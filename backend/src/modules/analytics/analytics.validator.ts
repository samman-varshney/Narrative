import { z } from 'zod';
import { env } from '../../core/config/env';
import { ANALYTICS_EVENT_TYPES } from './analytics.types';

/**
 * Zod schemas for the Analytics module.
 *
 * Almost everything here validates QUERY STRINGS rather than bodies, so the
 * controller parses them with a local `parseOrThrow` instead of the
 * `validateRequest` body middleware — Express 5 makes `req.query` a read-only
 * getter, so the middleware's parse-and-assign approach cannot work. The Blog,
 * Notification and Search modules all handle their list endpoints the same way.
 *
 * The reading-telemetry endpoint is the exception: it takes a body, and uses
 * `validateRequest`.
 */

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

/** Default window when the caller supplies no dates. A month of daily points. */
export const DEFAULT_RANGE_DAYS = 30;

/**
 * Buckets a single response may contain.
 *
 * Expressed in BUCKETS rather than days because that is what actually costs:
 * 370 daily points and 370 weekly points are the same work to aggregate,
 * serialize and render, while a "max N days" rule would arbitrarily forbid a
 * three-year monthly chart that returns 36 rows.
 *
 * Deliberately BELOW `MAX_LOOKBACK_DAYS`, so the two limits do different jobs.
 * Set equal, this one would be unreachable at daily granularity — lookback would
 * always reject first — and the cap that the brief actually asks for would be
 * dead code on the granularity where it matters most.
 *
 * 370 admits a full year of daily points (366 in a leap year), which is the
 * genuinely useful high-resolution request, and rejects anything longer with
 * guidance to ask for `week` instead — where the entire retention window fits in
 * under 60 points.
 */
export const MAX_BUCKETS = 370;

/**
 * How far back a range may start.
 *
 * DERIVED from the retention setting, not a constant beside it. Hardcoding this
 * makes the two drift the moment an operator lowers retention: the API would go
 * on accepting a 400-day range whose rows the prune job had already deleted, and
 * answer with an empty series that reads as "you had no traffic" rather than
 * "that data no longer exists". Tying them means the API can only ever offer
 * what the database still holds.
 */
export const MAX_LOOKBACK_DAYS = env.ANALYTICS_DAILY_RETENTION_DAYS;

export const granularitySchema = z.enum(['day', 'week', 'month']).default('day');

/** `YYYY-MM-DD`. Deliberately not `z.coerce.date()`, which accepts far too much. */
const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');

/**
 * The shared range parameters.
 *
 * Both dates are optional; the service fills in a default window. Cross-field
 * checks (ordering, bucket count, lookback) need the resolved defaults, so they
 * live in `analytics.range.ts` rather than in a `.refine` here — a refinement
 * could only see what the caller actually sent.
 */
export const dateRangeQuerySchema = z.object({
  startDate: dateStringSchema.optional(),
  endDate: dateStringSchema.optional(),
  granularity: granularitySchema,
});

export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;

/**
 * Range parameters for the endpoints that return ONE aggregate rather than a
 * series — `overview` and `reading`.
 *
 * `granularity` is deliberately absent. Those endpoints collapse the whole range
 * into a single set of totals, so a bucket size means nothing to them; accepting
 * the parameter would advertise a knob that silently does nothing, which is worse
 * than never offering it. (The Search module makes the same call about its
 * `visibility` filter.)
 *
 * Their range is resolved by `resolveTotalsRange`, which also skips the
 * bucket-count cap — a 400-day overview is one indexed aggregate, not 400 data
 * points, so rejecting it would be an error the query does not deserve.
 */
export const totalsRangeQuerySchema = z.object({
  startDate: dateStringSchema.optional(),
  endDate: dateStringSchema.optional(),
});

export type TotalsRangeQuery = z.infer<typeof totalsRangeQuerySchema>;

// ---------------------------------------------------------------------------
// Endpoint queries
// ---------------------------------------------------------------------------

/** Page size for `top-blogs`. Bounded well below the platform's 100. */
export const MAX_TOP_BLOGS_LIMIT = 50;
export const DEFAULT_TOP_BLOGS_LIMIT = 10;

/**
 * `uniqueReaderDays`, not `uniqueViews`: ranking is over the whole range, and
 * an exact unique-reader count only exists for a single day. See
 * `analytics.types` § `uniqueReaderDays`.
 */
export const topBlogsMetricSchema = z
  .enum(['views', 'uniqueReaderDays', 'bookmarks', 'comments', 'readCompletions'])
  .default('views');

export const topBlogsQuerySchema = dateRangeQuerySchema.extend({
  metric: topBlogsMetricSchema,
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_BLOGS_LIMIT)
    .default(DEFAULT_TOP_BLOGS_LIMIT),
});

export type TopBlogsQuery = z.infer<typeof topBlogsQuerySchema>;

/** Path params. cuid, so a permissive id shape with a sane length bound. */
export const blogIdParamSchema = z.object({
  blogId: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// Reading telemetry
// ---------------------------------------------------------------------------

/**
 * Analytics event types a CLIENT is allowed to report.
 *
 * A strict subset of `ANALYTICS_EVENT_TYPES`. Everything else on that list is
 * derived from a domain event the server itself emitted, and accepting one over
 * HTTP would let any caller manufacture bookmarks, follows and views for any
 * blog. Reading progress is the only signal the server genuinely cannot observe
 * on its own, which is exactly why it is the only one accepted here.
 */
export const CLIENT_REPORTABLE_EVENTS = ANALYTICS_EVENT_TYPES.filter(
  (type): type is 'BLOG_READ_STARTED' | 'BLOG_READ_COMPLETED' =>
    type === 'BLOG_READ_STARTED' || type === 'BLOG_READ_COMPLETED'
);

/**
 * Upper bound on a claimed reading duration, at the edge.
 *
 * The ingestion service clamps against the post's own length and against the
 * server-measured elapsed time, which is the real defence. This exists so an
 * absurd value is rejected with a clear validation error instead of travelling
 * further in to be silently clamped — and so `durationSeconds: 1e308` never
 * reaches arithmetic.
 */
const MAX_CLAIMED_DURATION_SECONDS = 24 * 60 * 60;

/**
 * A client-supplied identifier: session id or anonymous id.
 *
 * Length- and charset-bounded because both are concatenated into Redis keys.
 * An unbounded string is how a client would bloat the keyspace; a string
 * containing the key delimiter is how it would collide with another reader's.
 */
const clientIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, 'Expected 16-64 characters of [A-Za-z0-9_-]');

export const readTelemetrySchema = z.object({
  event: z.enum(['BLOG_READ_STARTED', 'BLOG_READ_COMPLETED']),
  sessionId: clientIdSchema,
  /**
   * Required for anonymous callers; ignored when a bearer token is present, so
   * a signed-in reader cannot attribute their reading to someone else's id.
   */
  anonymousId: clientIdSchema.optional(),
  durationSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_CLAIMED_DURATION_SECONDS)
    .optional(),
});

export type ReadTelemetryInput = z.infer<typeof readTelemetrySchema>;
