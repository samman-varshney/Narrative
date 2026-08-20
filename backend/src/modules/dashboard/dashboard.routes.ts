import { Router } from 'express';
import { requireAuth } from '../../core/middlewares/requireAuth';
import { catchAsync } from '../../core/utils/asyncHandler';
import { dashboardController } from './dashboard.controller';

/**
 * Dashboard routes, mounted at `/api/v1/dashboard`.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * Every route requires authentication, and every route is scoped to the token's
 * own user. There is no `:userId` segment anywhere in this router and no user
 * parameter in any query schema — a dashboard is private, and the way to
 * guarantee that is to leave no way to ask for someone else's rather than to
 * check on each route that nobody did. That includes admins: platform-wide
 * insight is a different feature, not a parameter on this one.
 *
 * `requireAuth` is applied PER ROUTE rather than with `router.use()`, matching
 * the Blog, Notification and Analytics routers. With a `use()` a route added
 * above it would silently be public, and the diff would look fine.
 *
 * ── No dedicated rate limiter ───────────────────────────────────────────────
 * These endpoints inherit the global `/api` limiter (100 per 15 minutes) and
 * that is the right budget: a dashboard is opened a handful of times per
 * session, not scrolled like a feed or typed into like a search box — the two
 * cases that needed their own, higher budgets. The composite endpoint actively
 * reduces request count, and the Redis cache absorbs polling.
 *
 * ── No ordering constraint ──────────────────────────────────────────────────
 * This router owns its mount and shares no prefix with another. Every path here
 * is a distinct literal, so nothing can shadow anything.
 */
const router = Router();

// The composite landing payload. One request, every panel.
router.get('/overview', requireAuth, catchAsync(dashboardController.overview));

// Individual sections, for lazy loading, polling and "see all" pages.
router.get('/stats', requireAuth, catchAsync(dashboardController.stats));
router.get('/charts', requireAuth, catchAsync(dashboardController.charts));
router.get('/top-content', requireAuth, catchAsync(dashboardController.topContent));
router.get('/drafts', requireAuth, catchAsync(dashboardController.drafts));
router.get('/activity', requireAuth, catchAsync(dashboardController.activity));

export const dashboardRoutes = router;
