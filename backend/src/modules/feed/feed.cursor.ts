import { createHash } from 'crypto';
import { z } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { CANDIDATE_LIMIT } from './feed.config';
import type { FeedType } from './feed.types';

/**
 * Feed cursors.
 *
 * The platform has two existing cursor conventions and this module needs both,
 * because its four feeds are ordered two different ways:
 *
 *   CHRONOLOGICAL (following, latest)
 *     The ordering is a column. A keyset over `(publishedAt, id)` is exact: the
 *     next page is `WHERE (publishedAt, id) < (:ts, :id)`, which cannot skip a
 *     row and cannot repeat one however long the walk takes or however much is
 *     published in the meantime. The trailing id makes the order total, which is
 *     what stops two posts published in the same millisecond from swapping
 *     places between pages.
 *
 *   RANKED (explore, trending)
 *     The ordering is COMPUTED from signals that move — engagement accrues,
 *     recency decays. There is no column to seek to, and a keyset over a moving
 *     score would drop and repeat rows as the score changed underneath it. So
 *     the ordering is frozen once, as a SNAPSHOT of candidate ids, and the
 *     cursor is an offset into that snapshot. Paging is then exact BY
 *     CONSTRUCTION: the list the client is walking does not change while they
 *     walk it.
 *
 * ── Snapshot loss is survivable, not silent ─────────────────────────────────
 * A ranked cursor carries the snapshot's id AND the ranking bucket it was built
 * in. If the snapshot has expired from Redis, the service rebuilds it using the
 * bucket from the cursor — the same window bounds, the same weights, the same
 * candidate query — so the rebuilt ordering is the original one up to whatever
 * the aggregates recorded in between. See FEED_MODULE.md § Pagination.
 *
 * ── Fingerprinting ──────────────────────────────────────────────────────────
 * Every cursor is stamped with a fingerprint of the request that produced it:
 * the feed, the filters, the options, and — for the following feed — the viewer.
 * Replaying a cursor against a different request would otherwise produce a page
 * keyed on a position from an unrelated ordering. A mismatch is a 400, not a
 * strange page.
 *
 * The cursor is deliberately NOT signed. It encodes no authorization decision:
 * the following feed is scoped by the access token on every request, never by
 * anything inside the cursor, so a stolen cursor grants nothing. An HMAC would
 * add key management for no security gain — the same call the Search module made.
 */

/** Bumped if the payload shape changes, so old cursors are rejected cleanly. */
const CURSOR_VERSION = 1;

/** Length of the request fingerprint carried in a cursor. */
const FINGERPRINT_LENGTH = 12;

/** Longest snapshot id a cursor may carry (a truncated hex digest). */
const SNAPSHOT_ID_LENGTH = 32;

const chronologicalPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal('c'),
  /** Request fingerprint. */
  f: z.string().length(FINGERPRINT_LENGTH),
  /** Position timestamp, ISO-8601. */
  t: z.iso.datetime({ offset: true }),
  /** Position row id. */
  i: z.string().min(1).max(64),
});

const rankedPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  k: z.literal('r'),
  f: z.string().length(FINGERPRINT_LENGTH),
  /** Snapshot the offset refers to. */
  s: z.string().length(SNAPSHOT_ID_LENGTH),
  /**
   * Offset into the snapshot. Bounded by the candidate cap, so a hand-crafted
   * cursor cannot ask the service to walk an arbitrarily long list.
   */
  o: z.number().int().min(0).max(CANDIDATE_LIMIT),
  /** Ranking bucket (epoch seconds) the snapshot was built in. */
  b: z.number().int().min(0),
});

/** Decoded position for a chronological walk. */
export interface ChronologicalPosition {
  sortAt: Date;
  id: string;
}

/** Decoded position for a ranked walk. */
export interface RankedPosition {
  snapshotId: string;
  offset: number;
  /** The ranking clock the snapshot was built against, as an instant. */
  bucketAt: Date;
}

/**
 * Everything that changes the shape of a feed's result set.
 *
 * `limit` is deliberately absent: a client is free to change page size mid-walk
 * and both pagination styles handle that correctly. `viewerId` is present only
 * for the following feed — including it for the shared feeds would make every
 * user's cursors mutually incompatible for no benefit.
 */
export function feedFingerprint(parts: {
  feed: FeedType;
  viewerId?: string;
  filters?: object;
  options?: object;
}): string {
  const canonical = JSON.stringify({
    feed: parts.feed,
    viewer: parts.viewerId ?? null,
    filters: canonicalize(parts.filters ?? {}),
    options: canonicalize(parts.options ?? {}),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * Stable JSON-able form of a parameter bag: keys sorted, `undefined` dropped,
 * arrays sorted, Dates as ISO strings.
 *
 * Without it `{tag, author}` and `{author, tag}` — the same filter — would
 * fingerprint differently and invalidate each other's cursors and cache entries.
 * Module-local, matching Search and Analytics, which each keep their own copy
 * next to the keys it protects.
 */
export function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return [...value].map(canonicalize).sort();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Chronological
// ---------------------------------------------------------------------------

export function encodeChronologicalCursor(payload: {
  fingerprint: string;
  sortAt: Date;
  id: string;
}): string {
  return encode({
    v: CURSOR_VERSION,
    k: 'c',
    f: payload.fingerprint,
    t: payload.sortAt.toISOString(),
    i: payload.id,
  });
}

export function decodeChronologicalCursor(
  raw: string,
  expectedFingerprint: string
): ChronologicalPosition {
  const parsed = chronologicalPayloadSchema.safeParse(decode(raw));
  if (!parsed.success || parsed.data.f !== expectedFingerprint) throw invalidCursor();

  const sortAt = new Date(parsed.data.t);
  if (Number.isNaN(sortAt.getTime())) throw invalidCursor();

  return { sortAt, id: parsed.data.i };
}

// ---------------------------------------------------------------------------
// Ranked
// ---------------------------------------------------------------------------

export function encodeRankedCursor(payload: {
  fingerprint: string;
  snapshotId: string;
  offset: number;
  bucketAt: Date;
}): string {
  return encode({
    v: CURSOR_VERSION,
    k: 'r',
    f: payload.fingerprint,
    s: payload.snapshotId,
    o: payload.offset,
    b: Math.floor(payload.bucketAt.getTime() / 1000),
  });
}

export function decodeRankedCursor(raw: string, expectedFingerprint: string): RankedPosition {
  const parsed = rankedPayloadSchema.safeParse(decode(raw));
  if (!parsed.success || parsed.data.f !== expectedFingerprint) throw invalidCursor();

  return {
    snapshotId: parsed.data.s,
    offset: parsed.data.o,
    bucketAt: new Date(parsed.data.b * 1000),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function encode(payload: object): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
}

/**
 * Every failure mode — malformed base64, bad JSON, wrong version, wrong kind,
 * out-of-range offset, fingerprint mismatch — surfaces as the same 400, so the
 * error text cannot be used to probe how cursors are built.
 */
function invalidCursor(): AppError {
  return new AppError(
    'Invalid or expired feed cursor — start from the first page',
    400,
    'INVALID_CURSOR'
  );
}
