import { z } from 'zod';
import { MAX_QUERY_LENGTH } from './search.query';

/**
 * Zod schemas for the Search module.
 *
 * Everything here validates QUERY STRINGS, not bodies — search has no write
 * endpoints — so these are parsed in the controller via `parseOrThrow` rather
 * than by the `validateRequest` body middleware. That mirrors how the Blog and
 * Notification modules handle their list endpoints, and is forced by Express 5
 * making `req.query` a read-only getter.
 *
 * Note the deliberate difference from `core/utils/pagination`: search caps
 * `limit` lower than the platform-wide MAX_PAGE_LIMIT of 100. See
 * `MAX_SEARCH_LIMIT` below.
 */

/**
 * Maximum page size for search.
 *
 * Lower than the platform's MAX_PAGE_LIMIT because a search page is far more
 * expensive than a feed page: every item was ranked, and a large page pulls
 * proportionally more taxonomy rows. 50 is comfortably more than any UI shows at
 * once, and it keeps the cached payload small enough to be worth caching.
 */
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

/** Per-entity slice size for the `GET /search` overview. */
export const MAX_GLOBAL_LIMIT = 20;
export const DEFAULT_GLOBAL_LIMIT = 5;

export const MAX_SUGGESTION_LIMIT = 20;
export const DEFAULT_SUGGESTION_LIMIT = 10;

/**
 * The search term.
 *
 * Bounded here so an over-long query is rejected at the edge with a clear
 * VALIDATION_ERROR rather than travelling further in. `normalizeQuery` enforces
 * the same bound again on the value it actually uses — the two are not
 * redundant: this one reports a field-level error to the client, that one is the
 * invariant every internal caller relies on.
 */
const querySchema = z
  .string()
  .trim()
  .min(1, 'Search query is required')
  .max(MAX_QUERY_LENGTH, `Search query must be at most ${MAX_QUERY_LENGTH} characters`);

export const searchSortSchema = z.enum(['relevance', 'newest', 'oldest']).default('relevance');

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_SEARCH_LIMIT)
  .default(DEFAULT_SEARCH_LIMIT);

/**
 * A repeatable query parameter.
 *
 * Express parses `?tag=a&tag=b` into an array but `?tag=a` into a bare string,
 * so both shapes must be accepted. A comma-separated single value is also
 * accepted because it is what clients reach for first. Everything collapses to a
 * de-duplicated, bounded array so the SQL `IN (...)` list can never grow without
 * limit.
 */
const multiValueSchema = (max: number) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) => {
      const raw = Array.isArray(value) ? value : value.split(',');
      const cleaned = raw.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
      return [...new Set(cleaned)].slice(0, max);
    })
    .pipe(z.array(z.string().min(1).max(80)).max(max));

/** Shared pagination + ordering, used by every paginated search endpoint. */
const searchPageSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: limitSchema,
  sort: searchSortSchema,
});

/**
 * Blog search filters.
 *
 * `visibility` is intentionally absent. The brief lists it as a candidate
 * filter, but public search resolves to exactly one visibility — PUBLISHED and
 * PUBLIC — and accepting the parameter would imply the API can be asked for
 * anything else. An endpoint that silently ignores a filter it advertises is
 * worse than one that never offered it. Author-scoped listings across all
 * visibilities already exist on `GET /api/v1/blogs/me`.
 */
export const blogSearchQuerySchema = searchPageSchema.extend({
  q: querySchema,
  author: z.string().trim().min(1).max(50).optional(),
  tag: multiValueSchema(10).optional(),
  category: multiValueSchema(10).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minReadingTime: z.coerce.number().int().min(0).max(600).optional(),
  maxReadingTime: z.coerce.number().int().min(0).max(600).optional(),
})
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  })
  .refine(
    (value) =>
      value.minReadingTime === undefined ||
      value.maxReadingTime === undefined ||
      value.minReadingTime <= value.maxReadingTime,
    {
      message: '`minReadingTime` must not exceed `maxReadingTime`',
      path: ['minReadingTime'],
    }
  );

/** `/search/users`, `/search/tags`, `/search/categories`. */
export const entitySearchQuerySchema = searchPageSchema.extend({ q: querySchema });

/** `/search` — the cross-entity overview. Not cursor-paginated; see the doc. */
export const globalSearchQuerySchema = z.object({
  q: querySchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_GLOBAL_LIMIT)
    .default(DEFAULT_GLOBAL_LIMIT),
});

/** `/search/suggestions`. */
export const suggestionsQuerySchema = z.object({
  q: querySchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SUGGESTION_LIMIT)
    .default(DEFAULT_SUGGESTION_LIMIT),
});

/** `/search/history`. */
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type BlogSearchQuery = z.infer<typeof blogSearchQuerySchema>;
export type EntitySearchQuery = z.infer<typeof entitySearchQuerySchema>;
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
