import { z } from 'zod';
import { paginationQuerySchema } from '../../core/utils/pagination';

/**
 * Zod schemas for the Blog module. Bodies are validated by the
 * `validateRequest` middleware; params/query are validated in the controller
 * via `parseOrThrow` (Express 5's `req.query` is a read-only getter).
 */

// Mirrors the Prisma `BlogVisibility` / `BlogStatus` enums.
export const blogVisibilitySchema = z.enum([
  'PUBLIC',
  'UNLISTED',
  'PRIVATE',
  'MEMBERS_ONLY',
]);
export const blogStatusSchema = z.enum([
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED',
  'DELETED',
]);

/**
 * Tiptap/ProseMirror document. Validated as a permissive object (a `record`,
 * which — unlike `z.object` — does NOT strip unknown keys, so the nested
 * `content`/`attrs`/`marks` survive) whose root is a `doc`. Deep structural
 * validation + sanitization is delegated to the EditorParser at the service layer.
 */
export const tiptapContentSchema = z
  .record(z.string(), z.unknown())
  .refine((c) => c.type === 'doc', {
    message: 'content must be a Tiptap document (root type must be "doc")',
  });

/** SEO overrides. Any omitted field is derived from the blog at the service layer. */
export const seoInputSchema = z.object({
  metaTitle: z.string().max(70, 'Meta title is too long').optional(),
  metaDescription: z.string().max(320, 'Meta description is too long').optional(),
  canonicalUrl: z.url('Must be a valid URL').optional().or(z.literal('')),
  ogTitle: z.string().max(70).optional(),
  ogDescription: z.string().max(320).optional(),
  ogImage: z.url('Must be a valid URL').optional().or(z.literal('')),
  twitterCard: z.enum(['summary', 'summary_large_image']).optional(),
});

const titleSchema = z
  .string()
  .min(1, 'Title is required')
  .max(200, 'Title is too long');
const subtitleSchema = z.string().max(300, 'Subtitle is too long');
const tagsSchema = z
  .array(z.string().min(1).max(50))
  .max(10, 'Maximum 10 tags allowed');
const categoryIdsSchema = z
  .array(z.string().min(1))
  .max(5, 'Maximum 5 categories allowed');

/** Create-draft body. Only the title is required. */
export const createBlogSchema = z.object({
  title: titleSchema,
  subtitle: subtitleSchema.optional(),
  content: tiptapContentSchema.optional(),
  visibility: blogVisibilitySchema.optional(),
  tags: tagsSchema.optional(),
  categoryIds: categoryIdsSchema.optional(),
  seo: seoInputSchema.optional(),
});

/**
 * Update body. All fields optional. A caller may override the slug directly;
 * it must be a valid slug (lowercase, dash-separated). Uniqueness is enforced
 * by the repository (incremental numbering on collision).
 */
export const updateBlogSchema = createBlogSchema.partial().extend({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug format')
    .max(80)
    .optional(),
});

/** Lightweight autosave body — content churn only, no SEO/tag/category resync. */
export const autosaveSchema = z.object({
  title: titleSchema.optional(),
  subtitle: subtitleSchema.optional(),
  content: tiptapContentSchema.optional(),
});

/** Admin: create a curated category. */
export const createCategorySchema = z.object({
  name: z.string().min(1, 'Name is required').max(50, 'Name is too long'),
});

// ---- Query / param schemas (validated in the controller) ----

/** `/blogs/me` and `/blogs/me/drafts`: pagination + optional status filter. */
export const myBlogsQuerySchema = paginationQuerySchema.extend({
  status: blogStatusSchema.optional(),
});

/** `/blogs/author/:username`: plain cursor pagination. */
export const authorBlogsQuerySchema = paginationQuerySchema;

/** `/blogs/tags`: typeahead search over the tag vocabulary. */
export const tagSearchQuerySchema = z.object({
  q: z.string().min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const slugParamSchema = z.object({ slug: z.string().min(1, 'slug is required') });
export const idParamSchema = z.object({ id: z.string().min(1, 'id is required') });
export const usernameParamSchema = z.object({
  username: z.string().min(1, 'username is required'),
});

// ---- Inferred types ----

export type BlogVisibility = z.infer<typeof blogVisibilitySchema>;
export type BlogStatus = z.infer<typeof blogStatusSchema>;
export type SeoInput = z.infer<typeof seoInputSchema>;
export type CreateBlogInput = z.infer<typeof createBlogSchema>;
export type UpdateBlogInput = z.infer<typeof updateBlogSchema>;
export type AutosaveInput = z.infer<typeof autosaveSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type MyBlogsQuery = z.infer<typeof myBlogsQuerySchema>;
export type AuthorBlogsQuery = z.infer<typeof authorBlogsQuerySchema>;
export type TagSearchQuery = z.infer<typeof tagSearchQuerySchema>;
