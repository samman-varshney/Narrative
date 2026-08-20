import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { notificationService } from './notification.service';
import {
  notificationIdParamSchema,
  notificationListQuerySchema,
} from './notification.validator';
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

export class NotificationController {
  /** The recipient is always the token's user — never a param or body. */
  async list(req: Request, res: Response) {
    const query = parseOrThrow(notificationListQuerySchema, req.query);
    const { items, ...meta } = await notificationService.list(req.user!.userId, query);
    sendSuccess(res, { items }, 200, meta);
  }

  async unreadCount(req: Request, res: Response) {
    const result = await notificationService.unreadCount(req.user!.userId);
    sendSuccess(res, result);
  }

  async markRead(req: Request, res: Response) {
    const { id } = parseOrThrow(notificationIdParamSchema, req.params);
    const result = await notificationService.markRead(req.user!.userId, id);
    sendSuccess(res, result, 200, { message: 'Notification marked as read' });
  }

  async markAllRead(req: Request, res: Response) {
    const result = await notificationService.markAllRead(req.user!.userId);
    sendSuccess(res, result, 200, { message: 'All notifications marked as read' });
  }

  async getPreferences(req: Request, res: Response) {
    const preferences = await notificationService.getPreferences(req.user!.userId);
    sendSuccess(res, { preferences });
  }

  async updatePreferences(req: Request, res: Response) {
    const preferences = await notificationService.updatePreferences(
      req.user!.userId,
      req.body
    );
    sendSuccess(res, { preferences }, 200, { message: 'Preferences updated' });
  }
}

export const notificationController = new NotificationController();
