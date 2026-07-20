import { Router } from 'express';
import { bookmarkController } from './bookmark.controller';
import { requireAuth } from '../../core/middlewares/requireAuth';
import { bookmarkWriteLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';

/**
 * The Bookmark module exposes TWO routers so all bookmark logic stays in this
 * module while its endpoints straddle two mounts:
 *
 *  - `blogBookmarkRoutes` mounts on `/api/v1/blogs`. Its paths are two-segment
 *    (`/:blogId/bookmark`), so they never collide with the blog `/:slug` route.
 *  - `userBookmarkRoutes` mounts on `/api/v1/users`. `/me/bookmarks` must be
 *    registered BEFORE the User router's `/:userId` so Express matches it first.
 *
 * Auth is applied per route, never via `router.use()`, so it cannot leak onto a
 * sibling router sharing the same mount.
 *
 * Every route requires auth: a bookmark library is private to its owner, so
 * there is no anonymous or `optionalAuth` surface here.
 */

// --- Blog-scoped bookmark routes (mounted at /api/v1/blogs) ---
const blogBookmarkRouter = Router();

blogBookmarkRouter.post(
  '/:blogId/bookmark/toggle',
  requireAuth,
  bookmarkWriteLimiter,
  catchAsync(bookmarkController.toggle)
);
blogBookmarkRouter.post(
  '/:blogId/bookmark',
  requireAuth,
  bookmarkWriteLimiter,
  catchAsync(bookmarkController.add)
);
blogBookmarkRouter.delete(
  '/:blogId/bookmark',
  requireAuth,
  bookmarkWriteLimiter,
  catchAsync(bookmarkController.remove)
);
blogBookmarkRouter.get(
  '/:blogId/bookmark-status',
  requireAuth,
  catchAsync(bookmarkController.status)
);

export const blogBookmarkRoutes = blogBookmarkRouter;

// --- User-scoped bookmark routes (mounted at /api/v1/users) ---
const userBookmarkRouter = Router();

userBookmarkRouter.get(
  '/me/bookmarks',
  requireAuth,
  catchAsync(bookmarkController.listMine)
);

export const userBookmarkRoutes = userBookmarkRouter;
