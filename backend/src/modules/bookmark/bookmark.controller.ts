import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { bookmarkService } from './bookmark.service';
import { blogIdParamSchema, bookmarkListQuerySchema } from './bookmark.validator';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { AppError } from '../../core/exceptions/AppError';

/**
 * Parses `req.params`/`req.query` with a Zod schema, raising the same
 * VALIDATION_ERROR AppError shape that the `validateRequest` body middleware
 * produces. Kept local because — unlike bodies — Express 5's `req.query` is a
 * read-only getter, so these are validated in the handler rather than middleware.
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

export class BookmarkController {
  async add(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const status = await bookmarkService.addBookmark(
      req.user!.userId,
      blogId,
      req.user!.role
    );
    sendSuccess(res, status, 200, { message: 'Bookmarked successfully' });
  }

  async remove(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const status = await bookmarkService.removeBookmark(req.user!.userId, blogId);
    sendSuccess(res, status, 200, { message: 'Bookmark removed successfully' });
  }

  async toggle(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const status = await bookmarkService.toggleBookmark(
      req.user!.userId,
      blogId,
      req.user!.role
    );
    sendSuccess(res, status, 200, {
      message: status.isBookmarked ? 'Bookmarked successfully' : 'Bookmark removed successfully',
    });
  }

  async status(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const status = await bookmarkService.getStatus(
      req.user!.userId,
      blogId,
      req.user!.role
    );
    sendSuccess(res, status);
  }

  /**
   * The library is always the authenticated user's own — the owner comes from
   * the token, never from a param, so one user can never read another's.
   */
  async listMine(req: Request, res: Response) {
    const query = parseOrThrow(bookmarkListQuerySchema, req.query);
    const { items, ...meta } = await bookmarkService.getUserBookmarks(
      req.user!.userId,
      query,
      req.user!.role
    );
    sendSuccess(res, { items }, 200, meta);
  }
}

export const bookmarkController = new BookmarkController();
