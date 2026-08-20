import { z } from 'zod';
import {
  DEFAULT_FEED_LIMIT,
  DEFAULT_TRENDING_WINDOW,
  MAX_FEED_LIMIT,
  TRENDING_WINDOW_NAMES,
} from './feed.config';

/**
 * Zod schemas for the Feed module.
 *
 * Everything here validates QUERY STRINGS — feeds have no write endpoints — so
 * these are parsed in the controller with `parseOrThrow` rather than by the
 * `validateRequest` body middleware, which cannot work on Express 5's read-only
 * `req.query`. The Blog, Notification, Search and Analytics modules all handle
 * their list endpoints the same way.
 *
 * ── Validation is a cost control here, not only a correctness one ───────────
 * Every bound in this file exists because an unbounded version of the same
 * parameter is a cheap way to make the database do expensive work: an unbounded
 * `limit` multiplies four hydration queries, an unbounded tag list becomes an
 * unbounded `IN (...)`, and an over-long cursor is a decode nobody asked for.
 * Cursors are additionally fingerprinted (see `feed.cursor.ts`), so a
 * well-formed but foreign cursor is rejected rather than walked.
 */

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_FEED_LIMIT)
  .default(DEFAULT_FEED_LIMIT);

/**
 * A repeatable query parameter.
 *
 * Express parses `?tag=a&tag=b` into an array but `?tag=a` into a bare string,
 * so both shapes must be accepted; a comma-separated single value is accepted
 * too because it is what clients reach for first. Everything collapses to a
 * de-duplicated, bounded, lowercased array so the SQL `IN (...)` list can never
 * grow without limit. Mirrors the Search module's handling exactly, so the two
 * discovery surfaces accept the same syntax.
 */
const multiValueSchema = (max: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) => {
      const raw = Array.isArray(value) ? value : value.split(',');
      const cleaned = raw.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
      return [...new Set(cleaned)].slice(0, max);
    })
    .pipe(z.array(z.string().min(1).max(80)).max(max));

/**
 * An opt-in boolean flag.
 *
 * Deliberately not `z.coerce.boolean()`, which maps the string `"false"` to
 * `true` — every non-empty string is truthy — and would turn an explicit opt-out
 * into an opt-in.
 */
const flagSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1')
  .default(false);

/** Pagination, common to every feed endpoint. */
const pageSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: limitSchema,
});

/**
 * Discovery filters.
 *
 * The set is deliberately smaller than Search's. `from`/`to` are absent because
 * a feed is a recency-ordered window by construction — an arbitrary date range
 * is a search, and offering it here would imply the feed's ordering could be
 * bent around it. `visibility` is absent for the reason the Search module gives:
 * feeds resolve to exactly one visibility set, and an API that advertises a
 * filter it silently ignores is worse than one that never offered it.
 */
const filterSchema = z.object({
  tag: multiValueSchema(10).optional(),
  category: multiValueSchema(10).optional(),
  author: z.string().trim().min(1).max(50).optional(),
  minReadingTime: z.coerce.number().int().min(0).max(600).optional(),
  maxReadingTime: z.coerce.number().int().min(0).max(600).optional(),
});

/** Cross-field check shared by every feed schema. */
const readingTimeOrder = (value: {
  minReadingTime?: number;
  maxReadingTime?: number;
}): boolean =>
  value.minReadingTime === undefined ||
  value.maxReadingTime === undefined ||
  value.minReadingTime <= value.maxReadingTime;

const READING_TIME_ORDER_MESSAGE = {
  message: '`minReadingTime` must not exceed `maxReadingTime`',
  path: ['minReadingTime'],
};

export const followingFeedQuerySchema = pageSchema
  .extend(filterSchema.shape)
  .refine(readingTimeOrder, READING_TIME_ORDER_MESSAGE);

export const latestFeedQuerySchema = pageSchema
  .extend(filterSchema.shape)
  .refine(readingTimeOrder, READING_TIME_ORDER_MESSAGE);

export const exploreFeedQuerySchema = pageSchema
  .extend(filterSchema.shape)
  .extend({
    /**
     * Hide authors the viewer already follows.
     *
     * Opt-in and authenticated-only: it is silently ignored for anonymous
     * callers, who have no follow graph, rather than rejected — an anonymous
     * client passing it is asking for the default feed, not making an error.
     */
    excludeFollowing: flagSchema,
  })
  .refine(readingTimeOrder, READING_TIME_ORDER_MESSAGE);

export const trendingFeedQuerySchema = pageSchema
  .extend(filterSchema.shape)
  .extend({
    /**
     * The engagement window. A fixed vocabulary rather than a free day count:
     * each value is a snapshot namespace and a cache key, and an open-ended
     * parameter would let a caller mint unbounded distinct rankings — every one
     * of which costs an aggregate scan to build.
     */
    window: z.enum(TRENDING_WINDOW_NAMES).default(DEFAULT_TRENDING_WINDOW),
  })
  .refine(readingTimeOrder, READING_TIME_ORDER_MESSAGE);

export type FollowingFeedQuery = z.infer<typeof followingFeedQuerySchema>;
export type LatestFeedQuery = z.infer<typeof latestFeedQuerySchema>;
export type ExploreFeedQuery = z.infer<typeof exploreFeedQuerySchema>;
export type TrendingFeedQuery = z.infer<typeof trendingFeedQuerySchema>;
