import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { searchService } from './search.service';
import type { EnginePage } from './search.types';
import {
  blogSearchQuerySchema,
  entitySearchQuerySchema,
  globalSearchQuerySchema,
  historyQuerySchema,
  suggestionsQuerySchema,
} from './search.validator';

/**
 * Search HTTP layer.
 *
 * Contains no SQL, no ranking, and no cache logic — it parses the query string,
 * calls the service, and shapes the envelope. Every endpoint is a read.
 *
 * ── Response shape ──────────────────────────────────────────────────────────
 * Paginated endpoints return the platform's standard envelope:
 *
 *   { success, data: { items: [...] }, meta: { nextCursor, hasNextPage, hasMore } }
 *
 * `meta` (rather than a `pagination` object nested inside `data`) is what every
 * other module on this platform returns, and `sendSuccess` builds it. `hasMore`
 * is emitted alongside `hasNextPage` as the search brief names it — one extra
 * boolean, and clients written against either name work.
 */

/**
 * Parses `req.query`/`req.params` with a Zod schema, raising the same
 * VALIDATION_ERROR shape the `validateRequest` body middleware produces. Local
 * because Express 5 makes `req.query` a read-only getter, so the middleware's
 * parse-and-replace approach cannot be used. Mirrors `blog.controller`.
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

/** Splits an engine page into the body and the pagination meta. */
function pageResponse<T>(res: Response, page: EnginePage<T>): void {
  sendSuccess(res, { items: page.items }, 200, {
    nextCursor: page.nextCursor,
    hasNextPage: page.hasMore,
    hasMore: page.hasMore,
  });
}

export class SearchController {
  // ---- Cross-entity overview ----------------------------------------------

  async global(req: Request, res: Response) {
    const query = parseOrThrow(globalSearchQuerySchema, req.query);
    const result = await searchService.globalSearch(query, req.user?.userId);
    sendSuccess(res, result);
  }

  // ---- Per-entity searches ------------------------------------------------

  async blogs(req: Request, res: Response) {
    const query = parseOrThrow(blogSearchQuerySchema, req.query);
    const page = await searchService.searchBlogs(query, req.user?.userId);
    pageResponse(res, page);
  }

  async users(req: Request, res: Response) {
    const query = parseOrThrow(entitySearchQuerySchema, req.query);
    const page = await searchService.searchUsers(query, req.user?.userId);
    pageResponse(res, page);
  }

  async tags(req: Request, res: Response) {
    const query = parseOrThrow(entitySearchQuerySchema, req.query);
    const page = await searchService.searchTags(query);
    pageResponse(res, page);
  }

  async categories(req: Request, res: Response) {
    const query = parseOrThrow(entitySearchQuerySchema, req.query);
    const page = await searchService.searchCategories(query);
    pageResponse(res, page);
  }

  // ---- Suggestions --------------------------------------------------------

  async suggestions(req: Request, res: Response) {
    const query = parseOrThrow(suggestionsQuerySchema, req.query);
    const suggestions = await searchService.suggest(query);
    sendSuccess(res, { suggestions });
  }

  // ---- History (authenticated) --------------------------------------------

  async history(req: Request, res: Response) {
    const { limit } = parseOrThrow(historyQuerySchema, req.query);
    const items = await searchService.listHistory(req.user!.userId, limit);
    sendSuccess(res, { items }, 200, { count: items.length });
  }

  async clearHistory(req: Request, res: Response) {
    const cleared = await searchService.clearHistory(req.user!.userId);
    sendSuccess(res, null, 200, { cleared, message: 'Search history cleared' });
  }
}

export const searchController = new SearchController();
