import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { commentService } from './comment.service';
import {
  blogIdParamSchema,
  idParamSchema,
  commentListQuerySchema,
  repliesQuerySchema,
} from './comment.validator';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { AppError } from '../../core/exceptions/AppError';

/**
 * Parses `req.params`/`req.query` with a Zod schema, raising the same
 * VALIDATION_ERROR AppError shape that the `validateRequest` body middleware
 * produces. Local because Express 5's `req.query` is a read-only getter.
 */
function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));
    throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', true, details);
  }
  return result.data;
}

export class CommentController {
  // ---- Write ----

  /** POST /blogs/:blogId/comments — top-level comment (or reply via body parentId). */
  async create(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const comment = await commentService.createComment(req.user!.userId, blogId, req.body);
    sendSuccess(res, { comment }, 201, { message: 'Comment created' });
  }

  /** POST /comments/:id/reply — reply to a specific comment. */
  async reply(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const comment = await commentService.reply(req.user!.userId, id, req.body);
    sendSuccess(res, { comment }, 201, { message: 'Reply created' });
  }

  /** PATCH /comments/:id — edit own comment (author or admin). */
  async update(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const comment = await commentService.edit(id, req.user!.userId, req.user!.role, req.body);
    sendSuccess(res, { comment }, 200, { message: 'Comment updated' });
  }

  /** DELETE /comments/:id — soft delete (author or admin). */
  async remove(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const comment = await commentService.softDelete(id, req.user!.userId, req.user!.role);
    sendSuccess(res, { comment }, 200, { message: 'Comment deleted' });
  }

  // ---- Moderation (admin) ----

  /**
   * POST /comments/:id/restore — un-delete (requires `content:restore`).
   *
   * The actor is built from the token, never from the body. Every moderation
   * entry point on the platform follows that rule; it is what makes an
   * administrative action impossible to attribute to someone else.
   */
  async restore(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const comment = await commentService.restore(id, {
      userId: req.user!.userId,
      role: req.user!.role,
    });
    sendSuccess(res, { comment }, 200, { message: 'Comment restored' });
  }

  /**
   * POST /comments/:id/hide — hide from public view (requires `content:hide`).
   *
   * Kept as a thin alias over the moderation seam rather than a second
   * implementation: the audited, report-aware path is
   * `POST /api/v1/admin/moderation/comments/:id/hide`. This one exists because
   * it already did, and now shares the same service method.
   */
  async hide(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const comment = await commentService.hideForModeration(id, {
      userId: req.user!.userId,
      role: req.user!.role,
    });
    sendSuccess(res, { comment }, 200, { message: 'Comment hidden' });
  }

  // ---- Read ----

  /** GET /blogs/:blogId/comments — paginated top-level comments (+ nested tree). */
  async list(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const query = parseOrThrow(commentListQuerySchema, req.query);
    const { items, ...meta } = await commentService.getBlogComments(blogId, query);
    sendSuccess(res, { items }, 200, meta);
  }

  /** GET /comments/:id — a single comment with its subtree. */
  async getOne(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const comment = await commentService.getById(id);
    sendSuccess(res, { comment });
  }

  /** GET /comments/:id/replies — paginated direct children. */
  async listReplies(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const query = parseOrThrow(repliesQuerySchema, req.query);
    const { items, ...meta } = await commentService.getReplies(id, query);
    sendSuccess(res, { items }, 200, meta);
  }
}

export const commentController = new CommentController();
