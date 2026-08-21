import { z } from 'zod';
import { SITEMAP_MAX_CHUNKS } from './seo.config';
import { SITEMAP_SECTIONS } from './seo.types';

/**
 * Zod schemas for the SEO module.
 *
 * SEO has no write endpoints and no bodies, so everything here validates a path
 * parameter or a query string — parsed in the controllers with `parseOrThrow`
 * rather than by the `validateRequest` body middleware, which cannot operate on
 * Express 5's read-only `req.query`. The Blog, Feed, Search, Analytics and RSS
 * modules all handle their read endpoints the same way.
 *
 * ── Validation here is a cost control as much as a correctness one ──────────
 * The sitemap's `page` is the parameter that matters. It becomes an `OFFSET`,
 * so an unbounded page number is an unbounded scan a stranger can ask the
 * database to perform, and every distinct value is a distinct cache entry — so
 * the ceiling bounds both the work per request and how many entries the
 * sitemap keyspace can ever hold. `SITEMAP_MAX_CHUNKS` is enforced here AND in
 * `sitemapService.getChunk`, because a bound that exists in only one layer is
 * one route away from not existing.
 *
 * The subject parameters are bounded for a plainer reason: they go into an
 * indexed equality lookup, and an unbounded string is an unbounded value to
 * hash and compare on a public endpoint.
 */

/**
 * A username in a metadata path.
 *
 * Bounded, not pattern-matched: the username vocabulary is owned by the Auth
 * and User modules, and duplicating their rules here would create a second
 * definition that eventually disagrees. What matters at this boundary is that
 * the value is a plausible length before it becomes a database lookup; whether
 * it identifies anybody is settled by that lookup, which 404s.
 */
export const seoUsernameParamSchema = z.object({
  username: z.string().min(1, 'username is required').max(80),
});

/** A blog, tag or category slug in a metadata path. Bounded for the same reason. */
export const seoSlugParamSchema = z.object({
  slug: z.string().min(1, 'slug is required').max(200),
});

/**
 * The representation the caller wants.
 *
 * `json` is `ResolvedMetadata` — the form a frontend maps onto its own
 * head-management library. `html` is the rendered `<head>` fragment, for a
 * consumer that would otherwise have to re-implement escaping. Both describe
 * the same resolved metadata; neither exposes anything the other does not.
 */
export const seoFormatQuerySchema = z.object({
  format: z.enum(['json', 'html']).default('json'),
});

/**
 * A sitemap chunk address, parsed from `/sitemap-<section>-<page>.xml`.
 *
 * The section is an ENUM rather than a string: it selects a query, and an
 * open-ended value would be both a 500 waiting to happen and a way to mint
 * cache entries for sections that do not exist. Express 5 splits the path
 * segment for us; anything that does not land on a known section 404s here.
 */
export const sitemapParamsSchema = z.object({
  section: z.enum(SITEMAP_SECTIONS),
  page: z.coerce.number().int().min(1).max(SITEMAP_MAX_CHUNKS),
});

export type SeoFormat = z.infer<typeof seoFormatQuerySchema>['format'];
