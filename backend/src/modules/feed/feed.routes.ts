import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../core/middlewares/requireAuth';
import { feedLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';
import { feedController } from './feed.controller';

/**
 * Feed routes, mounted at `/api/v1/feed`.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * `/following` requires a token — it is defined entirely by who is asking.
 * The other three are PUBLIC and use `optionalAuth`, which never rejects: an
 * expired token degrades a discovery request to an anonymous one rather than
 * 401-ing someone who is just browsing. The token is read on those routes for
 * exactly one purpose — Explore's opt-in `excludeFollowing` — and never changes
 * the ranking, which is what keeps those feeds cacheable across viewers.
 *
 * Auth is applied PER ROUTE rather than with `router.use()`, matching every
 * other router here, so the one route with different auth cannot be overlooked
 * when reading this file.
 *
 * ── Route ordering ──────────────────────────────────────────────────────────
 * Every path is a literal segment and there is no `/:param` route, so nothing
 * can be shadowed today. The ordering is kept explicit so adding one later
 * cannot quietly swallow `/latest`.
 *
 * ── Rate limiting ───────────────────────────────────────────────────────────
 * `feedLimiter` sits in front of the whole router, and `/api/v1/feed` is exempt
 * from the global `/api` limiter for the same reason `/search` is: an infinite
 * scroll fires far more requests than general API browsing, and 100 per 15
 * minutes would break the product's primary surface. See `rateLimiter.ts`.
 */
const router = Router();

router.use(feedLimiter);

// --- Personalized (authenticated) ---
router.get('/following', requireAuth, catchAsync(feedController.following));

// --- Public discovery ---
router.get('/latest', optionalAuth, catchAsync(feedController.latest));
router.get('/explore', optionalAuth, catchAsync(feedController.explore));
router.get('/trending', optionalAuth, catchAsync(feedController.trending));

export const feedRoutes = router;
