import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../core/middlewares/requireAuth';
import { searchLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';
import { searchController } from './search.controller';

/**
 * Search routes, mounted at `/api/v1/search`.
 *
 * ROUTE ORDERING IS LOAD-BEARING, as elsewhere on this platform: the literal
 * segments (`/blogs`, `/users`, `/tags`, `/categories`, `/suggestions`,
 * `/history`) are all registered before the bare `/` overview. There is no
 * `/:param` route here, so nothing can be shadowed today — the ordering is kept
 * explicit so adding one later cannot quietly swallow `/tags`.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * Every search endpoint is PUBLIC and uses `optionalAuth`. The results do not
 * differ for a signed-in viewer; the token is read only so an authenticated
 * search can be written to that user's private history. `optionalAuth` never
 * rejects, so an expired token degrades to an anonymous search rather than a 401
 * in the middle of typing.
 *
 * The history endpoints are the only authenticated ones — they address a
 * specific user's data, always the token's own.
 *
 * ── Rate limiting ───────────────────────────────────────────────────────────
 * `searchLimiter` sits in front of the whole router. Search is the most
 * expensive read on the platform (ranked, multi-source, partially uncacheable
 * once filters and cursors vary) and is the natural target for scraping the blog
 * corpus, so it gets a tighter budget than the global `/api` limiter.
 */
const router = Router();

router.use(searchLimiter);

// --- Per-entity searches (literal segments — before the bare `/`) ---
router.get('/blogs', optionalAuth, catchAsync(searchController.blogs));
router.get('/users', optionalAuth, catchAsync(searchController.users));
router.get('/tags', optionalAuth, catchAsync(searchController.tags));
router.get('/categories', optionalAuth, catchAsync(searchController.categories));

// --- Typeahead ---
router.get('/suggestions', optionalAuth, catchAsync(searchController.suggestions));

// --- Private search history ---
router.get('/history', requireAuth, catchAsync(searchController.history));
router.delete('/history', requireAuth, catchAsync(searchController.clearHistory));

// --- Cross-entity overview (MUST be last) ---
router.get('/', optionalAuth, catchAsync(searchController.global));

export const searchRoutes = router;
