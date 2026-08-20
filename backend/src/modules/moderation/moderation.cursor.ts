import { createHash } from 'crypto';
import { z } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { CURSOR_VERSION } from './moderation.config';

/**
 * Cursors for the administrative lists (the moderation queue and the audit log).
 *
 * ── Why keyset and not offset ───────────────────────────────────────────────
 * Both lists are append-heavy and read while they are being written to: reports
 * arrive while a moderator pages the queue, and every action they take writes an
 * audit row. Under OFFSET, each insert shifts every later page by one — the
 * moderator sees a report twice, or never sees one at all, and neither failure
 * announces itself. A keyset over `(createdAt, id)` cannot skip or repeat: the
 * next page starts strictly after a position that already exists.
 *
 * The trailing `id` is what makes the ordering TOTAL. `createdAt` alone is not
 * unique — a spam wave files several reports inside the same millisecond, and a
 * bulk action writes several audit rows at once — and a keyset over a
 * non-unique column is exactly as broken as OFFSET, just less obviously.
 *
 * ── The fingerprint ─────────────────────────────────────────────────────────
 * A cursor is a position in ONE ordering. Replaying a cursor from
 * `?status=PENDING&sort=oldest` against `?status=RESOLVED&sort=newest` would
 * hand back a page seeked to a position that means nothing in that list. Every
 * cursor is stamped with a digest of the request that produced it, and a
 * mismatch is a 400 rather than a plausible-looking wrong page.
 *
 * ── Not signed, deliberately ────────────────────────────────────────────────
 * The cursor encodes no authorization: every administrative route is behind
 * `requirePermission`, and the queries are never scoped by anything inside the
 * cursor. A forged cursor buys a position in a list the caller was already
 * entitled to read. Signing it would add key management for no security gain —
 * the same conclusion the Search and Feed cursors reached.
 */

const FINGERPRINT_LENGTH = 12;

const payloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  /** Request fingerprint. */
  f: z.string().length(FINGERPRINT_LENGTH),
  /** Position timestamp, ISO-8601. */
  t: z.iso.datetime({ offset: true }),
  /** Position row id. */
  i: z.string().min(1).max(64),
});

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

/**
 * A stable digest of everything that defines an ordering.
 *
 * The input is JSON-stringified with SORTED keys, so `{status, sort}` and
 * `{sort, status}` produce the same fingerprint — otherwise a client that
 * happens to serialize its query differently would have its own cursors
 * rejected.
 */
export function cursorFingerprint(input: Record<string, unknown>): string {
  const normalized = JSON.stringify(input, Object.keys(input).sort());
  return createHash('sha256').update(normalized).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/** Encodes a position as an opaque, URL-safe token. */
export function encodeCursor(position: CursorPosition, fingerprint: string): string {
  const payload = {
    v: CURSOR_VERSION,
    f: fingerprint,
    t: position.createdAt.toISOString(),
    i: position.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor and verifies it belongs to THIS request.
 *
 * Every failure — malformed base64, wrong version, altered payload, wrong
 * request — is the same 400. A cursor is an opaque token the client got from us;
 * there is nothing a caller can do differently with a more specific message, and
 * distinguishing "expired format" from "wrong query" would only describe the
 * internals to someone probing them.
 */
export function decodeCursor(raw: string, fingerprint: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  const result = payloadSchema.safeParse(parsed);
  if (!result.success || result.data.f !== fingerprint) {
    throw invalidCursor();
  }

  return { createdAt: new Date(result.data.t), id: result.data.i };
}

function invalidCursor(): AppError {
  return new AppError('Invalid or expired cursor', 400, 'INVALID_CURSOR');
}
