import { createHash } from 'crypto';
import { z } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import type { SearchSort } from './search.types';

/**
 * Keyset cursors for search results.
 *
 * The rest of the platform paginates on a single opaque row id (see
 * `core/utils/pagination`), which works because those feeds order by an indexed
 * column that Prisma can `cursor:` on. Search cannot: its primary ordering is a
 * *computed relevance score*, which exists only for the duration of one query
 * and is not a column anyone can seek to.
 *
 * So a search cursor carries the full sort key:
 *
 *   (score, tiebreak timestamp, row id)
 *
 * and the next page is `WHERE (score, ts, id) < (:score, :ts, :id)` — a keyset
 * walk over a deterministic total order. The trailing row id makes the order
 * total even when the first two components tie, which is what stops a row from
 * being skipped or served twice across pages.
 *
 * Two details make this safe rather than merely plausible:
 *
 *  1. SCORE IS CARRIED AS A DECIMAL STRING, never a float. The engine rounds it
 *     to a fixed scale in SQL (`round(..., 6)`) and compares as `numeric`. If it
 *     round-tripped through a JS double, the `score = :score` half of the
 *     comparison could miss by one ULP and silently drop a row.
 *
 *  2. THE CURSOR IS FINGERPRINTED against the query, filters and sort it was
 *     produced for. Replaying a cursor against a different query would otherwise
 *     produce a page keyed on scores from an unrelated result set — not a
 *     security hole (everything here is public data) but a confusing, unstable
 *     one. A mismatch is rejected as a 400 instead.
 *
 * The cursor is deliberately NOT signed. It encodes no authorization decision
 * and reveals nothing a client did not already have; an HMAC would add key
 * management for no security gain.
 */

/** Bumped if the payload shape changes, so old cursors are rejected cleanly. */
const CURSOR_VERSION = 1;

/** Length of the query fingerprint carried in the cursor. */
const FINGERPRINT_LENGTH = 12;

/** Fixed decimal scale the engine rounds scores to. MUST match the SQL. */
export const SCORE_SCALE = 6;

const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  /** Query fingerprint — ties the cursor to the search that produced it. */
  f: z.string().length(FINGERPRINT_LENGTH),
  /** Score as a fixed-scale decimal string. Null for the recency sorts. */
  s: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, 'malformed score')
    .max(40)
    .nullable(),
  /** Tiebreak timestamp, ISO-8601. */
  t: z.iso.datetime({ offset: true }),
  /** Row id. */
  i: z.string().min(1).max(64),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

/** The decoded position a query resumes from. */
export interface CursorPosition {
  /** Decimal string, passed straight to Postgres as `::numeric`. */
  score: string | null;
  timestamp: Date;
  id: string;
}

/**
 * Derives the fingerprint a cursor must carry to be accepted.
 *
 * Everything that changes the shape of the result set goes in: the normalized
 * query, the sort mode, and the filters. The page size deliberately does NOT —
 * a client is free to change `limit` mid-walk, and keyset pagination handles
 * that correctly.
 */
export function cursorFingerprint(parts: {
  query: string;
  sort: SearchSort;
  /** Any plain filter bag — `canonicalize` handles the shape. */
  filters?: object;
}): string {
  const canonical = JSON.stringify({
    q: parts.query,
    sort: parts.sort,
    f: canonicalize(parts.filters ?? {}),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * Produces a stable JSON-able form of a filter bag: keys sorted, `undefined`
 * dropped, arrays sorted, Dates as ISO strings. Without this, `{tag, author}`
 * and `{author, tag}` — the same filter — would fingerprint differently and
 * invalidate each other's cursors and cache entries.
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

export function encodeCursor(payload: {
  fingerprint: string;
  score: string | null;
  timestamp: Date;
  id: string;
}): string {
  const body: CursorPayload = {
    v: CURSOR_VERSION,
    f: payload.fingerprint,
    s: payload.score,
    t: payload.timestamp.toISOString(),
    i: payload.id,
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor. Every failure mode — malformed base64, bad
 * JSON, wrong version, missing field, fingerprint mismatch — surfaces as the
 * same 400 INVALID_CURSOR, so a client cannot use the error text to probe how
 * cursors are built.
 */
export function decodeCursor(raw: string, expectedFingerprint: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) throw invalidCursor();
  if (result.data.f !== expectedFingerprint) throw invalidCursor();

  const timestamp = new Date(result.data.t);
  if (Number.isNaN(timestamp.getTime())) throw invalidCursor();

  return { score: result.data.s, timestamp, id: result.data.i };
}

function invalidCursor(): AppError {
  return new AppError(
    'Invalid or expired search cursor',
    400,
    'INVALID_CURSOR'
  );
}
