import { z } from 'zod';
import { paginationQuerySchema } from '../../core/utils/pagination';

/** Route param for every blog-scoped bookmark endpoint. */
export const blogIdParamSchema = z.object({
  blogId: z.string().min(1, 'blogId is required'),
});
export type BlogIdParam = z.infer<typeof blogIdParamSchema>;

/**
 * Query for `GET /users/me/bookmarks`. Extends the shared pagination schema, so
 * `cursor` and the coerced `limit` (capped at MAX_PAGE_LIMIT) come for free.
 *
 * `sort` orders by when the bookmark was saved — NOT by the blog's publish date
 * — which is what the (userId, createdAt) index covers in both directions.
 */
export const bookmarkListQuerySchema = paginationQuerySchema.extend({
  sort: z.enum(['recent', 'oldest']).default('recent'),
  authorId: z.string().min(1).optional(),
  tag: z.string().min(1).max(50).optional(),
});
export type BookmarkListQuery = z.infer<typeof bookmarkListQuerySchema>;
