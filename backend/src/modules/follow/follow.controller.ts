import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { followService } from './follow.service';
import { userIdParamSchema, followListQuerySchema } from './follow.validator';
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

export class FollowController {
  async follow(req: Request, res: Response) {
    const { userId } = parseOrThrow(userIdParamSchema, req.params);
    const status = await followService.followUser(req.user!.userId, userId);
    sendSuccess(res, status, 200, { message: 'Followed successfully' });
  }

  async unfollow(req: Request, res: Response) {
    const { userId } = parseOrThrow(userIdParamSchema, req.params);
    const status = await followService.unfollowUser(req.user!.userId, userId);
    sendSuccess(res, status, 200, { message: 'Unfollowed successfully' });
  }

  async getFollowers(req: Request, res: Response) {
    const { userId } = parseOrThrow(userIdParamSchema, req.params);
    const pagination = parseOrThrow(followListQuerySchema, req.query);
    const { items, ...meta } = await followService.getFollowers(
      userId,
      pagination,
      req.user?.userId
    );
    sendSuccess(res, { items }, 200, meta);
  }

  async getFollowing(req: Request, res: Response) {
    const { userId } = parseOrThrow(userIdParamSchema, req.params);
    const pagination = parseOrThrow(followListQuerySchema, req.query);
    const { items, ...meta } = await followService.getFollowing(
      userId,
      pagination,
      req.user?.userId
    );
    sendSuccess(res, { items }, 200, meta);
  }

  async followStatus(req: Request, res: Response) {
    const { userId } = parseOrThrow(userIdParamSchema, req.params);
    const status = await followService.getFollowStatus(req.user!.userId, userId);
    sendSuccess(res, status);
  }
}

export const followController = new FollowController();
