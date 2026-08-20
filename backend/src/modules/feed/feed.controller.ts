import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { feedService } from './feed.service';
import type { FeedPage } from './feed.types';
import {
  exploreFeedQuerySchema,
  followingFeedQuerySchema,
  latestFeedQuerySchema,
  trendingFeedQuerySchema,
} from './feed.validator';

/**
 * Feed HTTP layer.
 *
 * Contains no SQL, no ranking, no caching and no eligibility logic — it parses
 * the query string, calls the service, and shapes the envelope. Every endpoint
 * is a read.
 *
 * ── Response shape ──────────────────────────────────────────────────────────
 * The platform's standard envelope, identical to Search's:
 *
 *   { success, data: { items: [...] }, meta: { nextCursor, hasNextPage, hasMore } }
 *
 * `meta` rather than a `pagination` object nested in `data`, because that is
 * what `sendSuccess` builds and what every other module returns. `hasMore` rides
 * alongside `hasNextPage` so clients written against either name work.
 *
 * ── The viewer is never a parameter ─────────────────────────────────────────
 * `req.user.userId` comes from the verified access token and is the only source
 * of viewer identity in this file. There is no `:userId` on any feed route, so
 * "read someone else's following feed" is not an authorization check that could
 * be forgotten — it is a request that cannot be expressed.
 */

/**
 * Parses `req.query` with a Zod schema, raising the same VALIDATION_ERROR shape
 * the `validateRequest` body middleware produces. Local because Express 5 makes
 * `req.query` a read-only getter, so the middleware's parse-and-replace approach
 * cannot be used. Mirrors `blog.controller` and `search.controller`.
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

/** Splits a feed page into the body and the pagination meta. */
function pageResponse(res: Response, page: FeedPage, meta: Record<string, unknown> = {}): void {
  sendSuccess(res, { items: page.items }, 200, {
    nextCursor: page.nextCursor,
    hasNextPage: page.hasMore,
    hasMore: page.hasMore,
    ...meta,
  });
}

export class FeedController {
  /** `GET /feed/following` — authenticated; always the token's own feed. */
  async following(req: Request, res: Response) {
    const query = parseOrThrow(followingFeedQuerySchema, req.query);
    const page = await feedService.getFollowingFeed(req.user!.userId, query);
    pageResponse(res, page);
  }

  /** `GET /feed/latest` — public, chronological. */
  async latest(req: Request, res: Response) {
    const query = parseOrThrow(latestFeedQuerySchema, req.query);
    const page = await feedService.getLatestFeed(query);
    pageResponse(res, page);
  }

  /** `GET /feed/explore` — public; `excludeFollowing` needs a token to mean anything. */
  async explore(req: Request, res: Response) {
    const query = parseOrThrow(exploreFeedQuerySchema, req.query);
    const page = await feedService.getExploreFeed(query, req.user?.userId);
    pageResponse(res, page);
  }

  /** `GET /feed/trending` — public; the window is echoed back in `meta`. */
  async trending(req: Request, res: Response) {
    const query = parseOrThrow(trendingFeedQuerySchema, req.query);
    const page = await feedService.getTrendingFeed(query);
    // Echoed because it is defaulted server-side: a client that sent no window
    // would otherwise have to know what the default is to label the tab.
    pageResponse(res, page, { window: query.window });
  }
}

export const feedController = new FeedController();
