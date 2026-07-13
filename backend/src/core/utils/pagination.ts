import { z } from 'zod';

/**
 * Cursor-based pagination primitives, shared across feed-style modules
 * (followers/following now, blog feeds and comments later).
 *
 * The wire contract (see docs/ARCHITECTURE.md) is:
 *   request:  ?cursor=<opaque>&limit=<n>
 *   response meta: { nextCursor, hasNextPage }
 *
 * The cursor is the `id` of the last row returned. Repositories fetch `limit + 1`
 * rows so the presence of the extra row signals another page without a second
 * count query.
 */

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Zod schema for the pagination query string. `limit` is coerced from the raw
 * query string, bounded to [1, MAX_PAGE_LIMIT], and defaults to DEFAULT_PAGE_LIMIT.
 * `cursor` is an optional opaque string.
 */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
});

export type CursorPagination = z.infer<typeof paginationQuerySchema>;

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

/**
 * Given `limit + 1` rows fetched from the repository, trims the extra sentinel
 * row and derives `hasNextPage` / `nextCursor`.
 *
 * @param rows   rows returned by a query that used `take: limit + 1`
 * @param limit  the page size the caller asked for
 * @param getCursor  extracts the opaque cursor (row id) from a row
 */
export function buildCursorPage<T>(
  rows: T[],
  limit: number,
  getCursor: (row: T) => string
): CursorPage<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor = hasNextPage ? getCursor(items[items.length - 1]!) : null;
  return { items, nextCursor, hasNextPage };
}
