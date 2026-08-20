import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { permissionsFor } from '../auth/permissions';
import { moderationService } from './moderation.service';
import type { ModerationActor } from './moderation.types';
import {
  auditQuerySchema,
  contentTargetParamSchema,
  createReportSchema,
  idParamSchema,
  moderationActionSchema,
  reportQuerySchema,
  resolveReportSchema,
} from './moderation.validator';
import { reportService } from './report.service';

/**
 * HTTP layer for the Moderation module.
 *
 * Parses, delegates, formats. No authorization decisions are made here — the
 * routes carry `requirePermission` and every service method re-checks the same
 * permission, so a handler that lost its middleware in a refactor still refuses
 * the request. Nothing in this file inspects a role.
 *
 * The one rule this file is entirely responsible for: the ACTOR. It is built
 * from `req.user`, which `requireAuth` populated from a verified token, and from
 * nowhere else. No schema in this module accepts an actor id, so there is no
 * request body that can claim to be someone else.
 */

/**
 * Parses `req.query`/`req.params` with a Zod schema, raising the same
 * VALIDATION_ERROR shape the `validateRequest` body middleware produces.
 *
 * Local because Express 5's `req.query` is a read-only getter, so the
 * parse-and-assign middleware cannot be used on it — the Blog, Notification,
 * Search, Feed, Analytics and Dashboard controllers each carry the same helper
 * for the same reason.
 */
function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', true, details);
  }
  return result.data;
}

/** The authenticated actor, from the token and nothing else. */
function actorOf(req: Request): ModerationActor {
  return { userId: req.user!.userId, role: req.user!.role };
}

export class ModerationController {
  // ---- User-facing -------------------------------------------------------

  /** POST /api/v1/reports — file a report. */
  async createReport(req: Request, res: Response) {
    const input = parseOrThrow(createReportSchema, req.body);
    const report = await reportService.createReport(req.user!.userId, input);
    sendSuccess(res, { report }, 201, { message: 'Report submitted for review' });
  }

  // ---- Administrative reads ----------------------------------------------

  /**
   * GET /api/v1/admin/me — the caller's administrative capabilities.
   *
   * Exists so an admin client can render the actions this person may actually
   * take instead of showing buttons that 403. It is a convenience for the UI and
   * NOT an authorization mechanism: the backend re-checks every permission on
   * every request, and a client that ignored this endpoint entirely would be
   * refused exactly as thoroughly.
   */
  async me(req: Request, res: Response) {
    sendSuccess(res, {
      userId: req.user!.userId,
      role: req.user!.role,
      permissions: permissionsFor(req.user!.role),
    });
  }

  /** GET /api/v1/admin/moderation/overview */
  async overview(req: Request, res: Response) {
    const overview = await moderationService.getOverview(actorOf(req));
    sendSuccess(res, { overview });
  }

  /** GET /api/v1/admin/moderation/reports */
  async listReports(req: Request, res: Response) {
    const query = parseOrThrow(reportQuerySchema, req.query);
    const { items, nextCursor, hasNextPage } = await reportService.listReports(
      actorOf(req),
      query
    );
    sendSuccess(res, { reports: items }, 200, {
      nextCursor,
      hasNextPage,
      limit: query.limit,
    });
  }

  /** GET /api/v1/admin/moderation/reports/:id */
  async getReport(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const report = await reportService.getReport(actorOf(req), id);
    sendSuccess(res, { report });
  }

  /** GET /api/v1/admin/moderation/history */
  async history(req: Request, res: Response) {
    const query = parseOrThrow(auditQuerySchema, req.query);
    const { items, nextCursor, hasNextPage } = await moderationService.getHistory(
      actorOf(req),
      query
    );
    sendSuccess(res, { actions: items }, 200, {
      nextCursor,
      hasNextPage,
      limit: query.limit,
    });
  }

  /** GET /api/v1/admin/moderation/users/:id */
  async userModeration(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const user = await moderationService.getUserModeration(actorOf(req), id);
    sendSuccess(res, user);
  }

  /** GET /api/v1/admin/moderation/content/:targetType/:targetId */
  async contentModeration(req: Request, res: Response) {
    const { targetType, targetId } = parseOrThrow(contentTargetParamSchema, req.params);
    const content = await moderationService.getContentModeration(
      actorOf(req),
      targetType,
      targetId
    );
    sendSuccess(res, content);
  }

  // ---- Triage ------------------------------------------------------------

  /** POST /api/v1/admin/moderation/reports/:id/claim */
  async claimReport(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const report = await reportService.claimReport(actorOf(req), id);
    sendSuccess(res, { report }, 200, { message: 'Report claimed for review' });
  }

  /** POST /api/v1/admin/moderation/reports/:id/resolve */
  async resolveReport(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(resolveReportSchema, req.body ?? {});
    const report = await reportService.resolveReport(actorOf(req), id, input);
    sendSuccess(res, { report }, 200, { message: 'Report resolved' });
  }

  /** POST /api/v1/admin/moderation/reports/:id/dismiss */
  async dismissReport(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(resolveReportSchema, req.body ?? {});
    const report = await reportService.dismissReport(actorOf(req), id, input);
    sendSuccess(res, { report }, 200, { message: 'Report dismissed' });
  }

  // ---- Content actions ---------------------------------------------------

  /** POST /api/v1/admin/moderation/blogs/:id/hide */
  async hideBlog(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const blog = await moderationService.hideBlog(actorOf(req), id, input);
    sendSuccess(res, { blog }, 200, { message: 'Blog hidden' });
  }

  /** POST /api/v1/admin/moderation/blogs/:id/restore */
  async restoreBlog(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const blog = await moderationService.restoreBlog(actorOf(req), id, input);
    sendSuccess(res, { blog }, 200, { message: 'Blog restored' });
  }

  /** POST /api/v1/admin/moderation/blogs/:id/remove */
  async removeBlog(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const blog = await moderationService.deleteBlog(actorOf(req), id, input);
    sendSuccess(res, { blog }, 200, { message: 'Blog removed' });
  }

  /** POST /api/v1/admin/moderation/comments/:id/hide */
  async hideComment(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const comment = await moderationService.hideComment(actorOf(req), id, input);
    sendSuccess(res, { comment }, 200, { message: 'Comment hidden' });
  }

  /** POST /api/v1/admin/moderation/comments/:id/restore */
  async restoreComment(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const comment = await moderationService.restoreComment(actorOf(req), id, input);
    sendSuccess(res, { comment }, 200, { message: 'Comment restored' });
  }

  /** POST /api/v1/admin/moderation/comments/:id/remove */
  async removeComment(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const comment = await moderationService.deleteComment(actorOf(req), id, input);
    sendSuccess(res, { comment }, 200, { message: 'Comment removed' });
  }

  // ---- Account actions ---------------------------------------------------

  /** POST /api/v1/admin/moderation/users/:id/suspend */
  async suspendUser(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const user = await moderationService.suspendUser(actorOf(req), id, input);
    sendSuccess(res, { user }, 200, { message: 'Account suspended' });
  }

  /** POST /api/v1/admin/moderation/users/:id/unsuspend */
  async unsuspendUser(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const input = parseOrThrow(moderationActionSchema, req.body ?? {});
    const user = await moderationService.unsuspendUser(actorOf(req), id, input);
    sendSuccess(res, { user }, 200, { message: 'Account restored' });
  }
}

export const moderationController = new ModerationController();
