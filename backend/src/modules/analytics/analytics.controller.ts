import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { analyticsService, type Requester } from './analytics.service';
import {
  blogIdParamSchema,
  dateRangeQuerySchema,
  topBlogsQuerySchema,
  totalsRangeQuerySchema,
  type ReadTelemetryInput,
} from './analytics.validator';

/**
 * HTTP layer for the Analytics module.
 *
 * Parses and validates, delegates, formats. No authorization decisions are made
 * here — `AnalyticsService` owns those, so the same rules apply to any future
 * caller that is not an HTTP request. No database access either.
 *
 * Every read endpoint returns its resolved range in `meta`. That matters more
 * than it looks: the service fills in defaults and clamps a future `endDate`, so
 * without echoing the range back, a client charting "the last 30 days" has no
 * way to label its own axis correctly.
 */

/**
 * Parses `req.params`/`req.query` with a Zod schema, raising the same
 * VALIDATION_ERROR shape the `validateRequest` body middleware produces.
 * Local because Express 5's `req.query` is a read-only getter — the same reason
 * the Blog, Notification and Search controllers each carry this helper.
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

/** The authenticated requester. Present on every route except the ingest one. */
function requesterOf(req: Request): Requester {
  return { userId: req.user!.userId, role: req.user!.role };
}

/**
 * Idempotency key for one reading beacon.
 *
 * DERIVED, not random. `navigator.sendBeacon` and a retrying fetch can both
 * deliver the same event twice, and a random id would make each delivery look
 * like a separate read. A session can only legitimately start once and complete
 * once, so hashing (blog, session, event) gives a key that is stable across
 * redeliveries and distinct across genuine reads.
 */
function telemetryEventId(blogId: string, input: ReadTelemetryInput): string {
  return createHash('sha256')
    .update(`read:${blogId}:${input.sessionId}:${input.event}`)
    .digest('base64url')
    .slice(0, 32);
}

export class AnalyticsController {
  // ---- Author dashboard ("me") ------------------------------------------

  async myOverview(req: Request, res: Response) {
    // `totalsRangeQuerySchema`, not the series one: an overview collapses the
    // whole range into a single set of totals, so a granularity would be a knob
    // that does nothing.
    const query = parseOrThrow(totalsRangeQuerySchema, req.query);
    const overview = await analyticsService.getUserOverview(requesterOf(req), query);
    sendSuccess(res, { overview }, 200, { range: overview.range });
  }

  async myViews(req: Request, res: Response) {
    const query = parseOrThrow(dateRangeQuerySchema, req.query);
    const { range, points } = await analyticsService.getUserViews(requesterOf(req), query);
    sendSuccess(res, { points }, 200, rangeMeta(range));
  }

  async myEngagement(req: Request, res: Response) {
    const query = parseOrThrow(dateRangeQuerySchema, req.query);
    const { range, points } = await analyticsService.getUserEngagement(requesterOf(req), query);
    sendSuccess(res, { points }, 200, rangeMeta(range));
  }

  async myFollowers(req: Request, res: Response) {
    const query = parseOrThrow(dateRangeQuerySchema, req.query);
    const { range, points, currentFollowers } = await analyticsService.getUserFollowers(
      requesterOf(req),
      query
    );
    sendSuccess(res, { points, currentFollowers }, 200, rangeMeta(range));
  }

  async myTopBlogs(req: Request, res: Response) {
    const query = parseOrThrow(topBlogsQuerySchema, req.query);
    const { range, metric, items, nextCursor, hasNextPage } =
      await analyticsService.getUserTopBlogs(requesterOf(req), query);

    sendSuccess(res, { items }, 200, { ...rangeMeta(range), metric, nextCursor, hasNextPage });
  }

  // ---- Per-blog reports --------------------------------------------------

  async blogOverview(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const query = parseOrThrow(totalsRangeQuerySchema, req.query);
    const overview = await analyticsService.getBlogOverview(blogId, requesterOf(req), query);
    sendSuccess(res, { overview }, 200, { range: overview.range });
  }

  async blogViews(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const query = parseOrThrow(dateRangeQuerySchema, req.query);
    const { range, points } = await analyticsService.getBlogViews(blogId, requesterOf(req), query);
    sendSuccess(res, { points }, 200, rangeMeta(range));
  }

  async blogEngagement(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const query = parseOrThrow(dateRangeQuerySchema, req.query);
    const { range, points } = await analyticsService.getBlogEngagement(
      blogId,
      requesterOf(req),
      query
    );
    sendSuccess(res, { points }, 200, rangeMeta(range));
  }

  async blogReading(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const query = parseOrThrow(totalsRangeQuerySchema, req.query);
    const { range, reading, estimatedReadingMinutes } = await analyticsService.getBlogReading(
      blogId,
      requesterOf(req),
      query
    );
    sendSuccess(res, { reading, estimatedReadingMinutes }, 200, rangeMeta(range));
  }

  // ---- Ingest ------------------------------------------------------------

  /**
   * Reading telemetry from the client.
   *
   * `202 Accepted`, not `200`, and with no body: the event has been accepted for
   * processing, not stored — it is in a Redis buffer that a worker will fold
   * into PostgreSQL later. Saying `200 OK` with a result would claim a
   * durability the pipeline deliberately does not offer.
   *
   * The response is also identical whether the event was counted or dropped as a
   * duplicate. A client that could tell the difference could probe the dedupe
   * state, and there is nothing useful it would do with the answer anyway.
   */
  async recordReading(req: Request, res: Response) {
    const { blogId } = parseOrThrow(blogIdParamSchema, req.params);
    const input = req.body as ReadTelemetryInput;

    const requester = req.user
      ? { userId: req.user.userId, role: req.user.role }
      : undefined;

    await analyticsService.recordReadingProgress(
      blogId,
      input,
      requester,
      telemetryEventId(blogId, input)
    );

    res.status(202).json({ success: true, data: null });
  }
}

/** Range echoed into every time-series response. See the class doc. */
function rangeMeta(range: { startDate: Date; endDate: Date; granularity: string }) {
  return {
    range: {
      startDate: range.startDate.toISOString().slice(0, 10),
      endDate: range.endDate.toISOString().slice(0, 10),
    },
    granularity: range.granularity,
  };
}

export const analyticsController = new AnalyticsController();
