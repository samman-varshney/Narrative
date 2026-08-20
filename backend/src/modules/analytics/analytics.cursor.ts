import { AppError } from '../../core/exceptions/AppError';
import type { TopBlogsMetric } from './analytics.types';

/**
 * Opaque cursor for the `top-blogs` list.
 *
 * A top-blogs page is keyset-paginated over `(metricValue, blogId)`, so the
 * cursor has to carry BOTH — a bare blog id (the platform's usual cursor, as in
 * `core/utils/pagination`) is not enough, because resuming needs the metric
 * value to compare against and re-deriving it would mean another aggregate query
 * per page.
 *
 * ── Why the fingerprint ─────────────────────────────────────────────────────
 * A cursor is only meaningful for the exact query that produced it. Paging with
 * a cursor from a `views` ranking into a `comments` ranking, or into a different
 * date range, would compare a metric value against a completely different
 * distribution and return an arbitrary slice — silently, and looking perfectly
 * normal. Stamping the query's identity into the cursor turns that from wrong
 * results into a clear 400.
 *
 * Base64url with no padding, so it survives a query string untouched.
 */

const CURSOR_VERSION = 1;

interface CursorPayload {
  /** Version, so a future shape change can reject old cursors explicitly. */
  v: number;
  /** Query fingerprint — see above. */
  f: string;
  /** Metric value of the last row on the previous page. */
  m: number;
  /** Blog id of the last row on the previous page. */
  b: string;
}

/** Identity of the query a cursor belongs to. */
export function topBlogsFingerprint(parts: {
  authorId: string;
  metric: TopBlogsMetric;
  startDate: Date;
  endDate: Date;
}): string {
  return [
    parts.authorId,
    parts.metric,
    parts.startDate.toISOString().slice(0, 10),
    parts.endDate.toISOString().slice(0, 10),
  ].join('|');
}

export function encodeTopBlogsCursor(
  fingerprint: string,
  row: { metricValue: number; blogId: string }
): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    f: fingerprint,
    m: row.metricValue,
    b: row.blogId,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or throws 400.
 *
 * A cursor is opaque to clients, so ANY problem with one — malformed base64,
 * bad JSON, wrong version, mismatched fingerprint — means the client is holding
 * something it should not have constructed. All four are the same 400, because
 * distinguishing them only helps someone probing the format.
 */
export function decodeTopBlogsCursor(
  cursor: string,
  expectedFingerprint: string
): { metricValue: number; blogId: string } {
  const invalid = () =>
    new AppError(
      'Invalid or expired cursor for this query — start from the first page',
      400,
      'INVALID_CURSOR'
    );

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw invalid();
  }

  if (
    payload?.v !== CURSOR_VERSION ||
    typeof payload.b !== 'string' ||
    typeof payload.m !== 'number' ||
    !Number.isFinite(payload.m) ||
    payload.f !== expectedFingerprint
  ) {
    throw invalid();
  }

  return { metricValue: payload.m, blogId: payload.b };
}
