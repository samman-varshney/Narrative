import { Request, Response } from 'express';
import { ZodType } from 'zod';
import { blogService, Viewer } from './blog.service';
import {
  slugParamSchema,
  idParamSchema,
  usernameParamSchema,
  myBlogsQuerySchema,
  authorBlogsQuerySchema,
  tagSearchQuerySchema,
} from './blog.validator';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { AppError } from '../../core/exceptions/AppError';

/**
 * Parses `req.params`/`req.query` with a Zod schema, raising the same
 * VALIDATION_ERROR AppError shape that the `validateRequest` body middleware
 * produces. Local because Express 5's `req.query` is a read-only getter.
 */
function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));
    throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', true, details);
  }
  return result.data;
}

/** Builds the viewer context from an (optionally) authenticated request. */
function viewerOf(req: Request): Viewer | undefined {
  return req.user ? { userId: req.user.userId, role: req.user.role } : undefined;
}

export class BlogController {
  // ---- Write ----

  async create(req: Request, res: Response) {
    const blog = await blogService.createDraft(req.user!.userId, req.body);
    sendSuccess(res, { blog }, 201, { message: 'Draft created' });
  }

  async update(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const blog = await blogService.updateDraft(id, req.user!.userId, req.user!.role, req.body);
    sendSuccess(res, { blog }, 200, { message: 'Blog updated' });
  }

  async autosave(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const result = await blogService.autosave(id, req.user!.userId, req.user!.role, req.body);
    sendSuccess(res, result, 200, { message: 'Draft saved' });
  }

  async updateCover(req: Request, res: Response) {
    if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');
    const { id } = parseOrThrow(idParamSchema, req.params);
    const blog = await blogService.updateCover(id, req.user!.userId, req.user!.role, req.file);
    sendSuccess(res, { blog }, 200, { message: 'Cover updated' });
  }

  async remove(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    await blogService.softDelete(id, req.user!.userId, req.user!.role);
    sendSuccess(res, null, 200, { message: 'Blog deleted' });
  }

  // ---- Lifecycle actions ----

  async publish(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const blog = await blogService.publish(id, req.user!.userId, req.user!.role);
    sendSuccess(res, { blog }, 200, { message: 'Blog published' });
  }

  async unpublish(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const blog = await blogService.unpublish(id, req.user!.userId, req.user!.role);
    sendSuccess(res, { blog }, 200, { message: 'Blog unpublished' });
  }

  async archive(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const blog = await blogService.archive(id, req.user!.userId, req.user!.role);
    sendSuccess(res, { blog }, 200, { message: 'Blog archived' });
  }

  async restore(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const blog = await blogService.restore(id, req.user!.userId, req.user!.role);
    sendSuccess(res, { blog }, 200, { message: 'Blog restored' });
  }

  // ---- Read ----

  async getBySlug(req: Request, res: Response) {
    const { slug } = parseOrThrow(slugParamSchema, req.params);
    const blog = await blogService.getBySlug(slug, viewerOf(req));
    sendSuccess(res, { blog });
  }

  async preview(req: Request, res: Response) {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const blog = await blogService.getPreview(id, req.user!.userId, req.user!.role);
    sendSuccess(res, { blog });
  }

  async myBlogs(req: Request, res: Response) {
    const query = parseOrThrow(myBlogsQuerySchema, req.query);
    const { items, ...meta } = await blogService.getMyBlogs(req.user!.userId, query);
    sendSuccess(res, { items }, 200, meta);
  }

  async myDrafts(req: Request, res: Response) {
    const pagination = parseOrThrow(myBlogsQuerySchema, req.query);
    const { items, ...meta } = await blogService.getMyDrafts(req.user!.userId, pagination);
    sendSuccess(res, { items }, 200, meta);
  }

  async byAuthor(req: Request, res: Response) {
    const { username } = parseOrThrow(usernameParamSchema, req.params);
    const pagination = parseOrThrow(authorBlogsQuerySchema, req.query);
    const { items, ...meta } = await blogService.getByAuthor(username, pagination);
    sendSuccess(res, { items }, 200, meta);
  }

  // ---- Categories & tags ----

  async listCategories(_req: Request, res: Response) {
    const categories = await blogService.listCategories();
    sendSuccess(res, { categories });
  }

  async createCategory(req: Request, res: Response) {
    const category = await blogService.createCategory(req.body.name);
    sendSuccess(res, { category }, 201, { message: 'Category created' });
  }

  async searchTags(req: Request, res: Response) {
    const { q, limit } = parseOrThrow(tagSearchQuerySchema, req.query);
    const tags = await blogService.searchTags(q, limit);
    sendSuccess(res, { tags });
  }
}

export const blogController = new BlogController();
