import { Router } from 'express';
import { commentController } from './comment.controller';
import {
  requireAuth,
  optionalAuth,
  requireRole,
} from '../../core/middlewares/requireAuth';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { commentWriteLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';
import {
  createCommentSchema,
  replyCommentSchema,
  updateCommentSchema,
} from './comment.validator';

/**
 * The Comment module exposes TWO routers so all comment logic stays in this
 * module while avoiding the Blog router's order-sensitive `/:slug` route:
 *
 *  - `blogCommentRoutes` mounts on `/api/v1/blogs`. Its paths are two-segment
 *    (`/:blogId/comments`), so they never collide with the blog `/:slug` route.
 *  - `commentRoutes` mounts on `/api/v1/comments`. Literal two-segment routes
 *    (`/:id/reply`, `/:id/restore`, `/:id/hide`, `/:id/replies`) are declared
 *    BEFORE the bare `/:id` routes so Express matches them first.
 */

// --- Blog-scoped comment routes (mounted at /api/v1/blogs) ---
const blogCommentRouter = Router();

blogCommentRouter.post(
  '/:blogId/comments',
  requireAuth,
  commentWriteLimiter,
  validateRequest(createCommentSchema),
  catchAsync(commentController.create)
);
blogCommentRouter.get(
  '/:blogId/comments',
  optionalAuth,
  catchAsync(commentController.list)
);

export const blogCommentRoutes = blogCommentRouter;

// --- Comment-scoped routes (mounted at /api/v1/comments) ---
const commentRouter = Router();

// Two-segment literal routes first.
commentRouter.get('/:id/replies', optionalAuth, catchAsync(commentController.listReplies));
commentRouter.post(
  '/:id/reply',
  requireAuth,
  commentWriteLimiter,
  validateRequest(replyCommentSchema),
  catchAsync(commentController.reply)
);
commentRouter.post(
  '/:id/restore',
  requireAuth,
  requireRole(['ADMIN']),
  catchAsync(commentController.restore)
);
commentRouter.post(
  '/:id/hide',
  requireAuth,
  requireRole(['ADMIN']),
  catchAsync(commentController.hide)
);

// Bare /:id routes.
commentRouter.get('/:id', optionalAuth, catchAsync(commentController.getOne));
commentRouter.patch(
  '/:id',
  requireAuth,
  validateRequest(updateCommentSchema),
  catchAsync(commentController.update)
);
commentRouter.delete('/:id', requireAuth, catchAsync(commentController.remove));

export const commentRoutes = commentRouter;
