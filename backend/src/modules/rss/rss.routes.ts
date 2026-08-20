import { Router } from 'express';
import { rssLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';
import { rssController } from './rss.controller';
import { rssErrorHandler } from './rss.errors';

/**
 * RSS routes, mounted at `/api/v1/rss`.
 *
 * ── Route shape ─────────────────────────────────────────────────────────────
 *
 *   GET /api/v1/rss                       every public post, newest first
 *   GET /api/v1/rss/authors/:username     one author's public posts
 *   GET /api/v1/rss/categories/:slug      one curated category
 *   GET /api/v1/rss/tags/:slug            one tag
 *
 * The module owns its own mount and shares no prefix with another router, so —
 * like `/search`, `/feed` and `/dashboard` — no registration-ordering
 * constraint applies to it in `app.ts`, and nothing here can be shadowed.
 *
 * The obvious alternative was to hang each feed off the resource it describes
 * (`/users/:username/rss`, `/blogs/tags/:slug/rss`). It was not taken because
 * `/api/v1/users` already carries THREE stacked routers whose ordering is
 * load-bearing — see the comments in `app.ts` — and adding a fourth path into
 * that arrangement to serve a document nobody browses to would be trading real
 * fragility for tidiness. Feeds are subscribed to once and then polled by a
 * machine forever; what their URL needs to be is stable, not decorative.
 *
 * Every path here is a literal segment followed by a parameter, so no route can
 * swallow another and the ordering below is presentational.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * There is none, deliberately, and not even `optionalAuth`. A feed carries only
 * PUBLIC content and is identical for every caller; reading a token would
 * create a viewer-conditional path where none needs to exist, and a
 * viewer-conditional path in front of a cache shared across viewers is how a
 * feed cache leaks. See `rss.controller.ts`.
 *
 * ── Rate limiting ───────────────────────────────────────────────────────────
 * `rssLimiter` sits in front of the whole router, and `/api/v1/rss` is exempt
 * from the global `/api` limiter for the same inversion `/search` and `/feed`
 * are: the global budget of 100 per 15 minutes is under seven requests a
 * minute, which a hosted aggregator polling on behalf of many subscribers
 * passes without doing anything wrong. See `rateLimiter.ts`.
 *
 * ── Errors ──────────────────────────────────────────────────────────────────
 * `rssErrorHandler` is registered LAST, and its position is load-bearing: an
 * Express error handler only catches what is thrown by handlers registered
 * BEFORE it. It renders XML instead of the platform's JSON envelope, which is
 * why it exists at all.
 */
const router = Router();

router.use(rssLimiter);

router.get('/', catchAsync(rssController.global));
router.get('/authors/:username', catchAsync(rssController.author));
router.get('/categories/:slug', catchAsync(rssController.category));
router.get('/tags/:slug', catchAsync(rssController.tag));

router.use(rssErrorHandler);

export const rssRoutes = router;
