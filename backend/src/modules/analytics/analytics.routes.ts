import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../core/middlewares/requireAuth';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { analyticsIngestLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';
import { analyticsController } from './analytics.controller';
import { readTelemetrySchema } from './analytics.validator';

/**
 * Analytics routes, mounted at `/api/v1/analytics`.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * Every REPORTING route requires auth, and every one is scoped to the token's
 * own user. `/me/*` needs no user id in the path because there is no legitimate
 * request for someone else's dashboard; `/blogs/:blogId/*` is checked against
 * the blog's author inside the service. There is no public analytics surface —
 * see `AnalyticsService.authorizeBlog` for why.
 *
 * The ingest route is the single exception. It uses `optionalAuth`, because a
 * signed-out reader's reading progress is exactly as real as a signed-in one's,
 * and requiring a token would silently exclude most of the audience from every
 * reading metric. It is a write, so it carries its own rate limiter.
 *
 * ── Route ordering ──────────────────────────────────────────────────────────
 * Literal segments (`/me/...`) are registered before the `/blogs/:blogId/...`
 * routes. Nothing collides today — the two prefixes are disjoint — but the
 * ordering is kept explicit so a future top-level `/:something` cannot quietly
 * swallow `/me`, which is how this bites on every other router in the codebase.
 *
 * Auth is applied PER ROUTE rather than with `router.use()`, matching the Blog
 * and Notification routers, so the one route with different auth cannot be
 * overlooked when reading this file.
 */
const router = Router();

// --- Author dashboard ---------------------------------------------------
router.get('/me/overview', requireAuth, catchAsync(analyticsController.myOverview));
router.get('/me/views', requireAuth, catchAsync(analyticsController.myViews));
router.get('/me/engagement', requireAuth, catchAsync(analyticsController.myEngagement));
router.get('/me/followers', requireAuth, catchAsync(analyticsController.myFollowers));
router.get('/me/top-blogs', requireAuth, catchAsync(analyticsController.myTopBlogs));

// --- Per-blog reports ---------------------------------------------------
router.get('/blogs/:blogId/overview', requireAuth, catchAsync(analyticsController.blogOverview));
router.get('/blogs/:blogId/views', requireAuth, catchAsync(analyticsController.blogViews));
router.get('/blogs/:blogId/reading', requireAuth, catchAsync(analyticsController.blogReading));
router.get(
  '/blogs/:blogId/engagement',
  requireAuth,
  catchAsync(analyticsController.blogEngagement)
);

// --- Reading telemetry (the only write, and the only public route) ------
router.post(
  '/blogs/:blogId/read',
  analyticsIngestLimiter,
  optionalAuth,
  validateRequest(readTelemetrySchema),
  catchAsync(analyticsController.recordReading)
);

export const analyticsRoutes = router;
