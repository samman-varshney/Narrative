import { Router } from 'express';
import { seoLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';
import { seoController } from './seo.controller';
import { sitemapController } from './sitemap.controller';
import { seoErrorHandler } from './seo.errors';

/**
 * The SEO module's two routers.
 *
 * They are separate because they are mounted in different places for different
 * reasons, and mounting them together would make one of them wrong.
 *
 * ── The metadata API — `/api/v1/seo` ────────────────────────────────────────
 *
 *   GET /api/v1/seo/site                 the home page
 *   GET /api/v1/seo/blogs/:slug          one post
 *   GET /api/v1/seo/authors/:username    one profile
 *   GET /api/v1/seo/categories/:slug     one category page
 *   GET /api/v1/seo/tags/:slug           one tag page
 *
 * All five accept `?format=json` (default) or `?format=html`. JSON is
 * `ResolvedMetadata` in the platform's envelope; HTML is the same resolution
 * rendered as a `<head>` fragment.
 *
 * The module owns its own mount and shares no prefix with another router, so —
 * like `/search`, `/feed`, `/dashboard` and `/rss` — no registration-ordering
 * constraint applies to it in `app.ts`, and nothing here can be shadowed. Every
 * path is a literal segment followed by a parameter, so the ordering below is
 * presentational.
 *
 * ── The crawler routes — the site root ──────────────────────────────────────
 *
 *   GET /robots.txt
 *   GET /sitemap.xml                     the index
 *   GET /sitemap-<section>-<page>.xml    one chunk
 *
 * These are NOT under `/api/v1`, and that is not a style choice. `/robots.txt`
 * is specified to live at the origin's root and a crawler will not look
 * anywhere else. A sitemap must be at or above the URLs it lists, so one served
 * from `/api/v1/...` could not legally list `/blog/...` at all. Both are
 * designed to be proxied to this service from the application's own origin —
 * see `SEO_SITEMAP_BASE_URL` for the deployment where they are not.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * There is none, on either router, and not even `optionalAuth`. Both carry only
 * PUBLIC metadata and are identical for every caller; reading a token would
 * create a viewer-conditional path where none needs to exist, and a
 * viewer-conditional path in front of a cache shared across viewers is how
 * gated content leaks.
 *
 * ── Rate limiting ───────────────────────────────────────────────────────────
 * `seoLimiter` guards both. The metadata API is additionally exempt
 * from the global `/api` limiter, for the same inversion `/search`, `/feed` and
 * `/rss` are: it is called once per page render by a server-side renderer, so a
 * budget of 100 per 15 minutes would throttle ordinary browsing. The crawler
 * routes are not under `/api` at all, so the global limiter never saw them and
 * `seoLimiter` is their only limit. See `rateLimiter.ts`.
 *
 * ── Errors ──────────────────────────────────────────────────────────────────
 * The crawler router registers `seoErrorHandler` LAST, and its position is
 * load-bearing: an Express error handler only catches what is thrown by
 * handlers registered BEFORE it. It renders XML and plain text instead of the
 * platform's JSON envelope, which is why it exists. The metadata API
 * deliberately does NOT use it — that endpoint IS JSON, and the global handler
 * is exactly right for it.
 */

// --- The metadata API ---
const api = Router();

api.use(seoLimiter);

api.get('/site', catchAsync(seoController.site));
api.get('/blogs/:slug', catchAsync(seoController.blog));
api.get('/authors/:username', catchAsync(seoController.author));
api.get('/categories/:slug', catchAsync(seoController.category));
api.get('/tags/:slug', catchAsync(seoController.tag));

export const seoRoutes = api;

// --- The crawler routes ---
const crawler = Router();

// The limiter is attached PER ROUTE here, unlike on the API router above, and
// the difference is the mount. This router is mounted at the application ROOT
// (`app.use(seoCrawlerRoutes)`), because `/robots.txt` has to be there — so a
// `router.use(seoLimiter)` would run for every request that reaches this point
// in the stack, including ones bound for no route at all. A scanner walking
// nonexistent paths would then spend the SEO budget and 429 the crawlers this
// limiter exists to serve. Attached per route, it counts only real requests.
crawler.get('/robots.txt', seoLimiter, catchAsync(sitemapController.robots));
// Registered before the parameterised pattern. `/sitemap.xml` cannot be matched
// by `/sitemap-:section-:page.xml` — the literal hyphen prevents it — but the
// ordering is kept explicit so a future pattern cannot quietly swallow the
// index.
crawler.get('/sitemap.xml', seoLimiter, catchAsync(sitemapController.index));
crawler.get('/sitemap-:section-:page.xml', seoLimiter, catchAsync(sitemapController.chunk));

crawler.use(seoErrorHandler);

export const seoCrawlerRoutes = crawler;
