import { env } from '../../core/config/env';

/**
 * SEO configuration — every tunable number and every piece of fixed copy in the
 * module, in one file.
 *
 * Kept apart from the code that applies it for the same reasons `rss.config.ts`
 * and `feed.config.ts` are: these are the values most likely to be tuned, they
 * are the part a unit test can assert on without a database or a Redis, and a
 * resolver reads as a resolver only when the constants live somewhere else.
 *
 * ── What is here and what is in `env.ts` ────────────────────────────────────
 * Values that genuinely differ per deployment — the site's name, its default
 * copy and image, whether it may be indexed, where its sitemaps are served —
 * are environment configuration and live in `core/config/env.ts`. They are read
 * through the accessors below rather than directly, so that a caller cannot
 * accidentally capture one at import time and so a test can change `APP_URL` or
 * `SEO_SITE_NAME` and see the effect.
 *
 * Everything else — chunk sizes, TTLs, the robots ruleset, the title format —
 * is a product decision that should be identical in dev and production. A
 * setting whose value should never differ is not configuration, it is a value
 * with a longer name and one more way to be wrong in production.
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Bumped when RESOLVED METADATA or a rendered document changes shape — a field
 * added, a directive rule changed, a structured-data node introduced.
 *
 * Part of every cache key, so a deploy that changes the output cannot serve
 * payloads built by the previous version, and folded into every ETag, so a
 * client holding a validator from the old shape revalidates instead of being
 * told 304 about a representation that no longer exists. Same mechanism, and
 * same reasoning, as `RSS_DOCUMENT_VERSION`.
 */
export const SEO_DOCUMENT_VERSION = 'v1';

// ---------------------------------------------------------------------------
// Site identity (deployment configuration, read through accessors)
// ---------------------------------------------------------------------------

export const siteName = (): string => env.SEO_SITE_NAME;
export const defaultTitle = (): string => env.SEO_DEFAULT_TITLE;
export const defaultDescription = (): string => env.SEO_DEFAULT_DESCRIPTION;
export const defaultImage = (): string | null => env.SEO_DEFAULT_IMAGE ?? null;
export const twitterSiteHandle = (): string | null => env.SEO_TWITTER_SITE ?? null;

/**
 * Whether crawlers may index this deployment at all.
 *
 * Unset means "only in production". A staging deployment serves the same public
 * content as production, and an indexed staging site competes with the real one
 * for its own queries — so the ambiguous case resolves to the safe answer rather
 * than the convenient one. When this is false every page resolves to
 * `noindex, nofollow` AND `robots.txt` disallows everything, so a deployment
 * cannot end up half-indexable.
 */
export const indexingEnabled = (): boolean =>
  env.SEO_INDEXING_ENABLED === undefined
    ? env.NODE_ENV === 'production'
    : env.SEO_INDEXING_ENABLED === 'true';

// ---------------------------------------------------------------------------
// Title and description shaping
// ---------------------------------------------------------------------------

/**
 * Longest `<title>` the module will emit, in characters.
 *
 * Search engines truncate a title around 60 characters and the platform's own
 * `seoInputSchema` already caps a stored `metaTitle` at 70 — this bounds what
 * the module GENERATES, including a title it built by appending the site name
 * to a 200-character post title. Truncation happens at a word boundary; see
 * `seo.resolver`.
 */
export const MAX_TITLE_LENGTH = 70;

/**
 * Longest description the module will emit, in characters.
 *
 * 160 is what a result snippet renders. `seoInputSchema` permits a stored
 * `metaDescription` of 320, and that is deliberately NOT re-truncated here to
 * 160: an author who wrote a longer summary chose it, Open Graph consumers show
 * more than a search snippet does, and silently cutting an explicit value is
 * worse than letting a consumer decide where to stop. What this bounds is the
 * DERIVED case — a description built from a subtitle or a body excerpt.
 */
export const MAX_DESCRIPTION_LENGTH = 200;

/**
 * How a page title is combined with the site's name.
 *
 * One format, in one place, so the home page, a post, a profile and a tag page
 * cannot each invent their own. The site's own pages pass their name alone.
 */
export const titleWithSite = (title: string, site: string): string =>
  title === site ? title : `${title} — ${site}`;

/** Channel copy for pages the platform generates rather than an author writes. */
export const DESCRIPTIONS = {
  author: (name: string, site: string) => `Posts by ${name} on ${site}.`,
  category: (name: string, site: string) => `Posts in ${name} on ${site}.`,
  tag: (name: string, site: string) => `Posts tagged ${name} on ${site}.`,
} as const;

/** Titles for the same. */
export const TITLES = {
  author: (name: string) => name,
  category: (name: string) => name,
  tag: (name: string) => `#${name}`,
} as const;

/** Breadcrumb label for the site root. */
export const HOME_BREADCRUMB_LABEL = 'Home';

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

/**
 * URLs per sitemap chunk.
 *
 * The sitemap protocol permits 50 000 URLs and 50 MB per document. 5 000 is
 * deliberately an order of magnitude below both, because the ceiling is not the
 * constraint that matters here: a chunk is generated in one query and held in
 * memory while it is rendered, so the chunk size IS the module's memory bound
 * per request. At 5 000 a document is a few hundred kilobytes and builds in
 * milliseconds; at 50 000 it would be tens of megabytes of string held per
 * concurrent request, which is how a sitemap endpoint becomes an availability
 * problem.
 *
 * Smaller chunks also mean a crawler re-fetches less when one changes.
 */
export const SITEMAP_URLS_PER_CHUNK = 5_000;

/**
 * Hard ceiling on chunks per section.
 *
 * Two things it bounds. A chunk is addressed by PAGE NUMBER, which is an
 * `OFFSET` — and an unbounded page number is an unbounded offset a stranger can
 * ask the database to walk. It is equally the bound on the index document: a
 * section that produced ten thousand children would render a sitemap index
 * nobody can use.
 *
 * 200 chunks is a million URLs per section, which is far beyond Narrative V1
 * and still a bounded amount of work. Crossing it is a real scaling event that
 * should be noticed rather than absorbed — see SEO_MODULE.md § Known
 * limitations.
 */
export const SITEMAP_MAX_CHUNKS = 200;

/**
 * `<changefreq>` and `<priority>` per section.
 *
 * Both are ADVISORY and Google has said publicly that it ignores them; Bing and
 * several smaller crawlers still read them. They are included because they cost
 * nothing and are part of the protocol, and they are set honestly: posts change
 * rarely once published, term pages change whenever something is published into
 * them, and priority describes relative importance WITHIN this site rather than
 * a claim about the site's importance in general.
 */
export const SITEMAP_HINTS = {
  home: { changefreq: 'daily', priority: 1.0 },
  blogs: { changefreq: 'weekly', priority: 0.8 },
  authors: { changefreq: 'weekly', priority: 0.6 },
  categories: { changefreq: 'daily', priority: 0.5 },
  tags: { changefreq: 'daily', priority: 0.4 },
} as const;

// ---------------------------------------------------------------------------
// Robots
// ---------------------------------------------------------------------------

/**
 * Paths no crawler should spend its budget on.
 *
 * Every entry here is a surface this codebase actually serves or references —
 * no route is invented. `/api/` is this application's own mount; the rest are
 * the authenticated application areas the backend modules imply, and
 * `/settings/` is referenced by name in the Notification email templates.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 * `robots.txt` is a crawling hint, not an access control. Nothing on this list
 * is protected BY being listed — every one of those surfaces is gated by
 * `requireAuth` and, where relevant, by a permission check. Listing a genuinely
 * secret path here would publish its existence to anyone who reads the file,
 * which is why the list contains only paths that are already obvious.
 *
 * The complement matters more: the public paths (`/blog/`, `/@…`,
 * `/categories/`, `/tags/`) are deliberately absent, and a test asserts that
 * none of them is matched by any rule here — accidentally disallowing the
 * platform's own content is the failure mode this file is most likely to
 * produce.
 */
export const ROBOTS_DISALLOWED_PATHS = [
  '/api/', // this application's API mount
  '/admin/', // the administrative surface (Moderation)
  '/moderation/', // the moderation queue
  '/dashboard/', // the author's private analytics (Dashboard)
  '/settings/', // account settings — named in the Notification templates
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
] as const;

/**
 * A crawl delay, in seconds, or null for none.
 *
 * Null on purpose. `Crawl-delay` is not part of the original specification,
 * Google ignores it outright, and the crawlers that honour it are not the ones
 * causing load. The real controls are the rate limiter and the caches — see
 * SEO_MODULE.md § Rate limiting.
 */
export const ROBOTS_CRAWL_DELAY: number | null = null;

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * TTLs in seconds, per cached artifact.
 *
 * These are an upper bound on staleness only in the ABSENCE of events:
 * publishing, editing, hiding or withdrawing a post bumps the generations that
 * key the affected entries and drops them immediately (see
 * `subscribers/seo.subscriber`). What a TTL bounds is the case where an event
 * is lost — a queue outage, a crash between commit and enqueue.
 *
 * Metadata is short because it backs a page render and a stale title is visible
 * to a human. A sitemap is long because it backs a crawler that visits on a
 * schedule of hours or days, and because building one is the most expensive
 * read in this module.
 */
export const CACHE_TTL_SECONDS = {
  metadata: 300,
  sitemap: 3_600,
  robots: 3_600,
} as const;

/**
 * How long a generation counter may be reused from process memory.
 *
 * Reading it from Redis on every request would put a round trip in front of
 * every page render. Memoizing cuts that to roughly one read per counter per
 * window, at the cost of up to this many extra seconds before an invalidation
 * raised on ANOTHER instance is visible here — well inside what the TTLs above
 * already allow. Same mechanism, and same number, as the RSS, Feed and Search
 * caches.
 */
export const GENERATION_MEMO_MS = 5_000;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * `max-age` per response kind, in seconds.
 *
 * Matched to the Redis TTLs deliberately: a shared cache that revalidates on
 * exactly the same cadence the origin refreshes on never serves anything the
 * origin would not have served itself, and the two staleness budgets stay one
 * number rather than two that drift.
 */
export const HTTP_MAX_AGE_SECONDS = {
  metadata: CACHE_TTL_SECONDS.metadata,
  sitemap: CACHE_TTL_SECONDS.sitemap,
  robots: CACHE_TTL_SECONDS.robots,
} as const;

/**
 * `stale-while-revalidate` window, in seconds.
 *
 * Lets an intermediary keep answering from a just-expired copy while it
 * refreshes in the background — which for a crawler-facing document costs
 * nothing and removes the request spike a synchronized expiry sends at the
 * origin.
 */
export const HTTP_STALE_WHILE_REVALIDATE_SECONDS = 600;

export const SITEMAP_CONTENT_TYPE = 'application/xml; charset=utf-8';
export const ROBOTS_CONTENT_TYPE = 'text/plain; charset=utf-8';
