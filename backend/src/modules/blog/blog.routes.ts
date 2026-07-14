import { Router } from 'express';
import { blogController } from './blog.controller';
import {
  requireAuth,
  optionalAuth,
  requireRole,
} from '../../core/middlewares/requireAuth';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { upload } from '../../core/middlewares/upload';
import { catchAsync } from '../../core/utils/asyncHandler';
import {
  createBlogSchema,
  updateBlogSchema,
  autosaveSchema,
  createCategorySchema,
} from './blog.validator';

/**
 * Blog routes, mounted at `/api/v1/blogs`. Auth is applied PER ROUTE.
 *
 * ROUTE-ORDERING IS LOAD-BEARING: literal-segment routes (`/me`, `/author`,
 * `/categories`, `/tags`) MUST be registered before the bare `/:slug` param
 * route, or Express would match `me`/`author`/… as a slug. Public reads are by
 * SEO `:slug`; mutations/actions are by stable `:id` (slugs can change).
 */
const router = Router();

// --- Create ---
router.post('/', requireAuth, validateRequest(createBlogSchema), catchAsync(blogController.create));

// --- Authenticated collections (literal segments — before /:slug) ---
router.get('/me', requireAuth, catchAsync(blogController.myBlogs));
router.get('/me/drafts', requireAuth, catchAsync(blogController.myDrafts));

// --- Public author listing ---
router.get('/author/:username', optionalAuth, catchAsync(blogController.byAuthor));

// --- Category vocabulary (curated) ---
router.get('/categories', catchAsync(blogController.listCategories));
router.post(
  '/categories',
  requireAuth,
  requireRole(['ADMIN']),
  validateRequest(createCategorySchema),
  catchAsync(blogController.createCategory)
);

// --- Tag typeahead ---
router.get('/tags', optionalAuth, catchAsync(blogController.searchTags));

// --- Id-scoped actions (two-segment; never collide with /:slug) ---
router.get('/:id/preview', requireAuth, catchAsync(blogController.preview));
router.patch('/:id/autosave', requireAuth, validateRequest(autosaveSchema), catchAsync(blogController.autosave));
router.patch('/:id/cover', requireAuth, upload.single('file'), catchAsync(blogController.updateCover));
router.post('/:id/publish', requireAuth, catchAsync(blogController.publish));
router.post('/:id/unpublish', requireAuth, catchAsync(blogController.unpublish));
router.post('/:id/archive', requireAuth, catchAsync(blogController.archive));
router.post('/:id/restore', requireAuth, catchAsync(blogController.restore));

// --- Id-scoped mutations ---
router.patch('/:id', requireAuth, validateRequest(updateBlogSchema), catchAsync(blogController.update));
router.delete('/:id', requireAuth, catchAsync(blogController.remove));

// --- Public read by slug (MUST be last) ---
router.get('/:slug', optionalAuth, catchAsync(blogController.getBySlug));

export const blogRoutes = router;
