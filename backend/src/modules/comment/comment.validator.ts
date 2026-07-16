import { z } from 'zod';
import { paginationQuerySchema } from '../../core/utils/pagination';

/**
 * Zod schemas for the Comment module. Bodies are validated by the
 * `validateRequest` middleware; params/query are validated in the controller
 * via `parseOrThrow` (Express 5's `req.query` is a read-only getter).
 */

// ---- Configurable module constants ----
// Co-located with the module that owns them (mirrors the media/pagination consts).
// Promote to `core/config/env.ts` if these ever need to be env-tunable.

/** Deepest allowed nesting depth (0-indexed; top-level comments are depth 0). */
export const MAX_COMMENT_DEPTH = 5;
/** Max raw content length accepted at the edge (post-sanitize length is re-checked). */
export const MAX_COMMENT_LENGTH = 10_000;
/** Min content length after trimming/sanitization. */
export const MIN_COMMENT_LENGTH = 1;

/**
 * Raw comment body. Length is bounded here to reject abuse cheaply; the service
 * sanitizes to plain text and re-verifies the result is non-empty and within
 * `MAX_COMMENT_LENGTH`.
 */
const contentSchema = z
  .string()
  .min(MIN_COMMENT_LENGTH, 'Comment cannot be empty')
  .max(MAX_COMMENT_LENGTH, 'Comment is too long');

/**
 * Create body for `POST /blogs/:blogId/comments`. An optional `parentId` turns
 * the create into a reply (equivalent to `POST /comments/:parentId/reply`).
 */
export const createCommentSchema = z.object({
  content: contentSchema,
  parentId: z.string().min(1).optional(),
});

/** Reply body for `POST /comments/:id/reply` — parent comes from the path param. */
export const replyCommentSchema = z.object({
  content: contentSchema,
});

/** Edit body for `PATCH /comments/:id`. */
export const updateCommentSchema = z.object({
  content: contentSchema,
});

/** Optional moderation note for `POST /comments/:id/hide` (validated, not persisted yet). */
export const hideCommentSchema = z.object({
  reason: z.string().max(500).optional(),
});

// ---- Query / param schemas (validated in the controller) ----

/**
 * `GET /blogs/:blogId/comments`: cursor pagination over top-level comments plus
 * an optional `tree` flag. `tree` defaults to true (eager nested replies up to
 * `MAX_COMMENT_DEPTH`); `?tree=false` returns roots with reply counts only.
 */
export const commentListQuerySchema = paginationQuerySchema.extend({
  tree: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

/** `GET /comments/:id/replies`: plain cursor pagination over direct children. */
export const repliesQuerySchema = paginationQuerySchema;

export const blogIdParamSchema = z.object({
  blogId: z.string().min(1, 'blogId is required'),
});
export const idParamSchema = z.object({ id: z.string().min(1, 'id is required') });

// ---- Inferred types ----

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ReplyCommentInput = z.infer<typeof replyCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
export type HideCommentInput = z.infer<typeof hideCommentSchema>;
export type CommentListQuery = z.infer<typeof commentListQuerySchema>;
export type RepliesQuery = z.infer<typeof repliesQuerySchema>;
