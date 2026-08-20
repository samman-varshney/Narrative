import { z } from 'zod';
import { DEFAULT_ITEM_COUNT, MAX_ITEM_COUNT } from './rss.config';

/**
 * Zod schemas for the RSS module.
 *
 * RSS has no write endpoints and no bodies, so everything here validates a path
 * parameter or a query string — parsed in the controller with `parseOrThrow`
 * rather than by the `validateRequest` body middleware, which cannot operate on
 * Express 5's read-only `req.query`. The Blog, Feed, Search and Analytics
 * modules all handle their read endpoints the same way.
 *
 * ── Validation here is a cost control as much as a correctness one ──────────
 * `limit` is the only knob a client has, and every bound on it exists because
 * the unbounded version is a cheap way to make the server do expensive work: a
 * larger page is more rows, more taxonomy, more excerpt bodies to parse, and a
 * larger document to render, hash and store. It is also a cache-keyspace
 * control — every distinct value is a distinct cached document, so the ceiling
 * bounds how many entries one feed can ever occupy.
 *
 * The subject parameters are bounded for a plainer reason: they go into an
 * indexed equality lookup, and an unbounded string is an unbounded value to
 * hash and compare on a public endpoint.
 */

/**
 * Item count.
 *
 * Coerced from the query string, clamped to `[1, MAX_ITEM_COUNT]`, defaulted.
 * A value above the ceiling is REJECTED rather than silently clamped, so a
 * client asking for 500 items learns that it cannot have them instead of
 * quietly receiving 50 and assuming it has the whole corpus.
 */
export const rssQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_ITEM_COUNT)
    .default(DEFAULT_ITEM_COUNT),
});

/**
 * A username in a feed path.
 *
 * Bounded, not pattern-matched: the username vocabulary is owned by the Auth
 * and User modules, and duplicating their rules here would create a second
 * definition that eventually disagrees. What matters at this boundary is that
 * the value is a plausible length before it becomes a database lookup; whether
 * it identifies anybody is settled by that lookup, which 404s.
 */
export const rssUsernameParamSchema = z.object({
  username: z.string().min(1, 'username is required').max(80),
});

/** A tag or category slug in a feed path. Bounded for the same reason. */
export const rssSlugParamSchema = z.object({
  slug: z.string().min(1, 'slug is required').max(120),
});

export type RssQuery = z.infer<typeof rssQuerySchema>;
export type RssUsernameParam = z.infer<typeof rssUsernameParamSchema>;
export type RssSlugParam = z.infer<typeof rssSlugParamSchema>;
