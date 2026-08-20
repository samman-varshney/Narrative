import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { dashboardService } from './dashboard.service';
import type { DashboardRequester } from './dashboard.sections';
import {
  activityQuerySchema,
  chartsQuerySchema,
  draftsQuerySchema,
  overviewQuerySchema,
  rangeQuerySchema,
  topContentQuerySchema,
} from './dashboard.validator';

/**
 * HTTP layer for the Dashboard module.
 *
 * Parses, delegates, formats. No composition decisions, no authorization
 * decisions, no data access — the service owns all three, so the same rules
 * apply to any future caller that is not an HTTP request.
 *
 * Every response echoes its resolved range in `meta`. That matters more than it
 * looks: the server picks the window and DERIVES the granularity from it, so
 * without the echo a client charting "all time" has no way to label its own
 * axis or know whether it received days or weeks.
 */

/**
 * Parses `req.query` with a Zod schema, raising the same VALIDATION_ERROR shape
 * the `validateRequest` body middleware produces.
 *
 * Local because Express 5's `req.query` is a read-only getter, so the
 * parse-and-assign middleware cannot be used on it. The Blog, Notification,
 * Search, Feed and Analytics controllers each carry the same helper for the
 * same reason.
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

/**
 * The authenticated requester.
 *
 * Built from the token and nothing else. Every route is behind `requireAuth`,
 * so `req.user` is always present; there is no path here that reads a user id
 * from the URL or the query string, which is what makes cross-user access
 * impossible rather than merely guarded.
 */
function requesterOf(req: Request): DashboardRequester {
  return { userId: req.user!.userId, role: req.user!.role };
}

export class DashboardController {
  /**
   * The composite dashboard.
   *
   * `degradedSections` is surfaced in `meta` rather than buried: a client that
   * cannot tell "this panel failed" from "this panel is empty" will render the
   * wrong empty state, and an operator reading a HAR file deserves to see which
   * subsystem was down.
   */
  async overview(req: Request, res: Response) {
    const query = parseOrThrow(overviewQuerySchema, req.query);
    const { overview, range, sections, degradedSections } =
      await dashboardService.getOverview(requesterOf(req), query);

    sendSuccess(res, { overview }, 200, { range, sections, degradedSections });
  }

  async stats(req: Request, res: Response) {
    const query = parseOrThrow(rangeQuerySchema, req.query);
    const { stats, range } = await dashboardService.getStats(requesterOf(req), query);
    sendSuccess(res, { stats }, 200, { range });
  }

  async charts(req: Request, res: Response) {
    const query = parseOrThrow(chartsQuerySchema, req.query);
    const charts = await dashboardService.getCharts(requesterOf(req), query);
    sendSuccess(res, { charts }, 200, { range: charts.range, series: query.series });
  }

  async topContent(req: Request, res: Response) {
    const query = parseOrThrow(topContentQuerySchema, req.query);
    const { range, metric, items, nextCursor, hasNextPage } =
      await dashboardService.getTopContent(requesterOf(req), query);

    sendSuccess(res, { items }, 200, { range, metric, nextCursor, hasNextPage });
  }

  async drafts(req: Request, res: Response) {
    const query = parseOrThrow(draftsQuerySchema, req.query);
    const { items, ...meta } = await dashboardService.getDrafts(requesterOf(req), query);
    sendSuccess(res, { items }, 200, meta);
  }

  async activity(req: Request, res: Response) {
    const query = parseOrThrow(activityQuerySchema, req.query);
    const { items } = await dashboardService.getActivity(requesterOf(req), query);
    sendSuccess(res, { items }, 200, { limit: query.limit });
  }
}

export const dashboardController = new DashboardController();
