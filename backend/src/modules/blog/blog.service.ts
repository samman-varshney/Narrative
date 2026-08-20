import { Prisma, BlogStatus } from '@prisma/client';
import {
  blogRepository,
  BlogCard,
  BlogDetail,
  BlogMetaRow,
  ReadingMetadataWrite,
  SeoWrite,
  CreateBlogData,
} from './blog.repository';
import {
  CreateBlogInput,
  UpdateBlogInput,
  AutosaveInput,
  SeoInput,
  MyBlogsQuery,
} from './blog.validator';
import { userRepository } from '../user/user.repository';
import { mediaService, UploadedFile } from '../media/media.service';
import { editorParser } from '../../core/providers/editor/TiptapParser';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { buildCursorPage, CursorPagination } from '../../core/utils/pagination';
import { slugify } from '../../core/utils/slug';

/** The authenticated (or anonymous) requester context for read access control. */
export interface Viewer {
  userId: string;
  role: string;
}

/**
 * Per-request context that is NOT part of access control.
 *
 * Currently just the caller-supplied anonymous id, which lets a signed-out
 * reader be recognised as the same reader across a session — the only way
 * BLOG_VIEWED can be deduplicated for anonymous traffic without falling back to
 * an IP address. Blog neither stores nor interprets it: it is passed straight
 * through onto the event, and only Analytics ever reads it.
 */
export interface ReadContext {
  anonymousId?: string;
}

/**
 * The minimal blog shape `canView` inspects. Structural, so both `BlogDetail`
 * and the lean `blogCardSelect` projection satisfy it.
 */
export type ViewableBlog = Pick<BlogDetail, 'status' | 'visibility' | 'authorId'>;

export interface TagDTO {
  id: string;
  name: string;
  slug: string;
}
export type CategoryDTO = TagDTO;

export interface BlogAuthorDTO {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  bio: string | null;
  isVerified: boolean;
}

export interface ReadingStatsDTO {
  headingCount: number;
  imageCount: number;
  codeBlockCount: number;
}

/** Effective SEO (stored overrides merged with generated defaults). */
export interface SeoDTO {
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  twitterCard: string | null;
}

/** A blog as it appears in list/card views (no content body, no SEO). */
export interface BlogCardDTO {
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  coverImage: string | null;
  status: BlogStatus;
  visibility: string;
  readingTimeMinutes: number;
  wordCount: number;
  charCount: number;
  readingStats: ReadingStatsDTO;
  author: BlogAuthorDTO;
  tags: TagDTO[];
  categories: CategoryDTO[];
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A full blog detail, including the content body and effective SEO. */
export interface BlogDTO extends BlogCardDTO {
  content: unknown;
  seo: SeoDTO;
}

export interface BlogListResult {
  items: BlogCardDTO[];
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
}

type LifecycleAction = 'publish' | 'unpublish' | 'archive' | 'restore' | 'softDelete';

/**
 * Blog lifecycle state machine. Maps each action to the allowed
 * `currentStatus → nextStatus` transitions. Any (action, status) pair absent
 * from this table is rejected with 409 INVALID_TRANSITION.
 */
const TRANSITIONS: Record<LifecycleAction, Partial<Record<BlogStatus, BlogStatus>>> = {
  publish: { DRAFT: 'PUBLISHED', ARCHIVED: 'PUBLISHED' },
  unpublish: { PUBLISHED: 'DRAFT' },
  archive: { DRAFT: 'ARCHIVED', PUBLISHED: 'ARCHIVED' },
  restore: { ARCHIVED: 'DRAFT', DELETED: 'DRAFT' },
  softDelete: { DRAFT: 'DELETED', PUBLISHED: 'DELETED', ARCHIVED: 'DELETED' },
};

export class BlogService {
  // ---- Create / update / autosave ----

  async createDraft(authorId: string, input: CreateBlogInput): Promise<BlogDTO> {
    const author = await userRepository.findById(authorId);
    if (!author) throw new AppError('Author not found', 404, 'USER_NOT_FOUND');

    const content = this.sanitizeContent(input.content);
    const reading = this.buildReading(content);
    const tagIds = input.tags ? await blogRepository.upsertTagsByName(input.tags) : [];
    const categoryIds = await this.resolveCategoryIds(input.categoryIds);
    const seo = this.normalizeSeo(input.seo);

    const base = slugify(input.title);
    const slug = await blogRepository.generateUniqueSlug(base);

    const blog = await this.createWithSlugRetry({
      authorId,
      title: input.title,
      slug,
      subtitle: input.subtitle ?? null,
      ...(content !== undefined && { content }),
      visibility: input.visibility,
      reading,
      tagIds,
      categoryIds,
      seo,
    });

    eventBus.emit(EVENTS.BLOG_CREATED, {
      blogId: blog.id,
      authorId,
      slug: blog.slug,
    });
    return this.toBlogDTO(blog);
  }

  async updateDraft(
    id: string,
    userId: string,
    role: string,
    input: UpdateBlogInput
  ): Promise<BlogDTO> {
    const blog = await this.loadOwned(id, userId, role);

    const data: Parameters<typeof blogRepository.updateBlog>[1] = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.subtitle !== undefined) data.subtitle = input.subtitle ?? null;
    if (input.visibility !== undefined) data.visibility = input.visibility;

    if (input.content !== undefined) {
      const content = this.sanitizeContent(input.content);
      if (content !== undefined) data.content = content;
      data.reading = this.buildReading(content);
    }

    // Slug policy: honor an explicit slug override; otherwise only auto-reslug
    // DRAFTs on a title change (published URLs stay stable).
    if (input.slug !== undefined && input.slug !== blog.slug) {
      data.slug = await blogRepository.generateUniqueSlug(input.slug);
    } else if (
      input.slug === undefined &&
      blog.status === 'DRAFT' &&
      input.title !== undefined &&
      input.title !== blog.title
    ) {
      data.slug = await blogRepository.generateUniqueSlug(slugify(input.title));
    }

    if (input.tags !== undefined) {
      data.tagIds = await blogRepository.upsertTagsByName(input.tags);
    }
    if (input.categoryIds !== undefined) {
      data.categoryIds = await this.resolveCategoryIds(input.categoryIds);
    }
    if (input.seo !== undefined) {
      // Partial patch: only the fields the caller actually sent are written, so
      // a field-at-a-time SEO edit never clobbers previously-stored overrides.
      data.seo = this.seoPatch(input.seo);
    }

    const updated = await this.updateWithSlugRetry(id, data);
    eventBus.emit(EVENTS.BLOG_UPDATED, { blogId: id, authorId: blog.authorId });
    return this.toBlogDTO(updated);
  }

  async autosave(
    id: string,
    userId: string,
    role: string,
    input: AutosaveInput
  ): Promise<{ id: string; savedAt: Date }> {
    const blog = await this.loadOwned(id, userId, role);
    if (blog.status !== 'DRAFT') {
      throw new AppError('Only drafts can be autosaved', 409, 'NOT_A_DRAFT');
    }

    const patch: Parameters<typeof blogRepository.autosave>[1] = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.subtitle !== undefined) patch.subtitle = input.subtitle ?? null;
    if (input.content !== undefined) {
      const content = this.sanitizeContent(input.content);
      if (content !== undefined) patch.content = content;
      patch.reading = this.buildReading(content);
    }

    const saved = await blogRepository.autosave(id, patch);
    // Autosave is intentionally silent (no event) to avoid downstream churn.
    return { id: saved.id, savedAt: saved.updatedAt };
  }

  // ---- Lifecycle transitions ----

  async publish(id: string, userId: string, role: string): Promise<BlogDTO> {
    const blog = await this.loadOwned(id, userId, role);
    const next = this.assertTransition(blog.status, 'publish');
    // publishedAt is stamped once, on the first publish only.
    const publishedAt = blog.publishedAt ?? new Date();
    const updated = await blogRepository.setStatus(id, next, {
      publishedAt: blog.publishedAt ? undefined : publishedAt,
    });
    eventBus.emit(EVENTS.BLOG_PUBLISHED, {
      blogId: id,
      authorId: blog.authorId,
      slug: blog.slug,
      publishedAt: updated.publishedAt,
    });
    return this.toBlogDTO(updated);
  }

  async unpublish(id: string, userId: string, role: string): Promise<BlogDTO> {
    return this.transition(id, userId, role, 'unpublish', EVENTS.BLOG_UNPUBLISHED);
  }

  async archive(id: string, userId: string, role: string): Promise<BlogDTO> {
    return this.transition(id, userId, role, 'archive', EVENTS.BLOG_ARCHIVED);
  }

  async restore(id: string, userId: string, role: string): Promise<BlogDTO> {
    const blog = await this.loadOwned(id, userId, role);
    const next = this.assertTransition(blog.status, 'restore');
    const updated = await blogRepository.setStatus(id, next);
    eventBus.emit(EVENTS.BLOG_RESTORED, {
      blogId: id,
      authorId: blog.authorId,
      status: next,
    });
    return this.toBlogDTO(updated);
  }

  async softDelete(id: string, userId: string, role: string): Promise<void> {
    const blog = await this.loadOwned(id, userId, role);
    const next = this.assertTransition(blog.status, 'softDelete');
    await blogRepository.setStatus(id, next);
    eventBus.emit(EVENTS.BLOG_DELETED, { blogId: id, authorId: blog.authorId });
  }

  /** Shared implementation for the single-target lifecycle transitions. */
  private async transition(
    id: string,
    userId: string,
    role: string,
    action: LifecycleAction,
    event: string
  ): Promise<BlogDTO> {
    const blog = await this.loadOwned(id, userId, role);
    const next = this.assertTransition(blog.status, action);
    const updated = await blogRepository.setStatus(id, next);
    eventBus.emit(event, { blogId: id, authorId: blog.authorId });
    return this.toBlogDTO(updated);
  }

  // ---- Cover image ----

  async updateCover(
    id: string,
    userId: string,
    role: string,
    file: UploadedFile
  ): Promise<BlogDTO> {
    const blog = await this.loadOwned(id, userId, role);

    // Media module is the single owner of file operations.
    const media = await mediaService.uploadCoverImage(userId, file);
    const previousMediaId = blog.coverMediaId;

    let updated: BlogDetail;
    try {
      updated = await blogRepository.updateCover(id, media.secureUrl, media.id);
    } catch (err) {
      // The DB connect failed — retire the just-uploaded asset so it isn't orphaned.
      await mediaService.deleteMedia(media.id, userId).catch(() => {});
      throw err;
    }

    // Retire the previous cover's Media record + storage asset (no orphans).
    if (previousMediaId) {
      await mediaService.deleteMedia(previousMediaId, userId).catch(() => {});
    }

    eventBus.emit(EVENTS.BLOG_COVER_UPDATED, {
      blogId: id,
      authorId: blog.authorId,
      coverImage: media.secureUrl,
    });
    return this.toBlogDTO(updated);
  }

  // ---- Reads ----

  /**
   * Public read by slug, gated by the status/visibility access-control matrix.
   *
   * This is the platform's only public full-read path, which makes it the one
   * honest place to say "a blog was viewed" — so it is where BLOG_VIEWED is
   * emitted. A client-side beacon was the alternative and is strictly worse: it
   * is trivially forgeable, it misses readers without JavaScript, and it would
   * report views for pages the server never actually served.
   *
   * The emit is fire-and-forget through the durable bus, so analytics can be
   * completely down and this method still returns a blog at the same speed.
   */
  async getBySlug(slug: string, viewer?: Viewer, context?: ReadContext): Promise<BlogDTO> {
    const blog = await blogRepository.findBySlug(slug);
    if (!blog || !this.canView(blog, viewer)) {
      // 404 (never 403) so we don't leak the existence of hidden blogs.
      throw new AppError('Blog not found', 404, 'BLOG_NOT_FOUND');
    }

    // Only a PUBLISHED blog can be viewed by an audience. An author opening
    // their own draft through this path is authoring, not readership, and
    // counting it would put a number on the dashboard that only the author's own
    // editing produced.
    if (blog.status === 'PUBLISHED') {
      eventBus.emit(EVENTS.BLOG_VIEWED, {
        blogId: blog.id,
        authorId: blog.authorId,
        slug: blog.slug,
        userId: viewer?.userId,
        anonymousId: context?.anonymousId,
      });
    }

    return this.toBlogDTO(blog);
  }

  /**
   * Descriptive scalars about one blog, for sibling modules.
   *
   * The module boundary for "tell me about this blog without loading it".
   * Analytics uses it to authorize a request against `authorId`, to label a
   * report, and to sanity-check claimed reading durations against
   * `readingTimeMinutes`. Returns null rather than throwing: a caller reacting to
   * an event may legitimately arrive after the blog was deleted.
   */
  getBlogMeta(blogId: string): Promise<BlogMetaRow | null> {
    return blogRepository.findMetaById(blogId);
  }

  /** Blog counts by status for one author. */
  countBlogsByStatus(authorId: string) {
    return blogRepository.countByStatus(authorId);
  }

  /** Author/admin-only preview — returns the blog in ANY status/visibility. */
  async getPreview(id: string, userId: string, role: string): Promise<BlogDTO> {
    const blog = await this.loadOwned(id, userId, role);
    return this.toBlogDTO(blog);
  }

  async getMyBlogs(userId: string, query: MyBlogsQuery): Promise<BlogListResult> {
    const statuses: BlogStatus[] = query.status
      ? [query.status]
      : ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
    return this.paginateAuthor(userId, query, { statuses });
  }

  async getMyDrafts(userId: string, pagination: CursorPagination): Promise<BlogListResult> {
    return this.paginateAuthor(userId, pagination, { statuses: ['DRAFT'] });
  }

  async getByAuthor(
    username: string,
    pagination: CursorPagination
  ): Promise<BlogListResult> {
    const author = await userRepository.findByUsername(username);
    if (!author || author.status !== 'ACTIVE') {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }
    return this.paginateAuthor(author.id, pagination, {
      statuses: ['PUBLISHED'],
      visibility: 'PUBLIC',
    });
  }

  private async paginateAuthor(
    authorId: string,
    pagination: CursorPagination,
    opts: { statuses: BlogStatus[]; visibility?: 'PUBLIC' }
  ): Promise<BlogListResult> {
    const [rows, totalCount] = await Promise.all([
      blogRepository.findByAuthor(authorId, pagination, opts),
      blogRepository.countByAuthor(authorId, opts),
    ]);
    const page = buildCursorPage(rows, pagination.limit, (r) => r.id);
    return {
      items: page.items.map((b) => this.toCardDTO(b)),
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      totalCount,
    };
  }

  // ---- Categories & tags ----

  listCategories() {
    return blogRepository.listCategories();
  }

  async createCategory(name: string) {
    try {
      const category = await blogRepository.createCategory(name.trim());
      // The Search module caches the category vocabulary for minutes at a time;
      // this lets it drop that cache now rather than serve a directory that is
      // missing a category an admin just created.
      eventBus.emit(EVENTS.CATEGORY_CREATED, {
        categoryId: category.id,
        name: category.name,
        slug: category.slug,
      });
      return category;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('Category already exists', 409, 'CATEGORY_EXISTS');
      }
      throw err;
    }
  }

  searchTags(q: string | undefined, limit: number) {
    return blogRepository.searchTags(q, limit);
  }

  // ---- Internal helpers ----

  /** Loads a blog by id and asserts the caller may modify it (author or admin). */
  private async loadOwned(id: string, userId: string, role: string): Promise<BlogDetail> {
    const blog = await blogRepository.findById(id);
    if (!blog) throw new AppError('Blog not found', 404, 'BLOG_NOT_FOUND');
    this.assertOwnership(blog.authorId, userId, role);
    return blog;
  }

  private assertOwnership(authorId: string, userId: string, role: string): void {
    if (authorId !== userId && role !== 'ADMIN') {
      throw new AppError('You do not have permission to modify this blog', 403, 'FORBIDDEN');
    }
  }

  private assertTransition(current: BlogStatus, action: LifecycleAction): BlogStatus {
    const next = TRANSITIONS[action][current];
    if (!next) {
      throw new AppError(
        `Cannot ${action} a blog in ${current} state`,
        409,
        'INVALID_TRANSITION'
      );
    }
    return next;
  }

  /**
   * Shared visibility guard: may `viewer` see this blog? Public so sibling
   * modules (Bookmark today) enforce the same status/visibility matrix instead
   * of duplicating it. Accepts any row carrying the three fields it reads, so
   * lean `blogCardSelect` projections work as well as full `BlogDetail` ones.
   */
  canView(blog: ViewableBlog, viewer?: Viewer): boolean {
    // DELETED blogs are never served on the public slug path — not even to the
    // owner/admin (they use preview-by-id / restore). This stops a stale public
    // URL from resurfacing trashed content.
    if (blog.status === 'DELETED') return false;

    const isOwnerOrAdmin =
      !!viewer && (viewer.userId === blog.authorId || viewer.role === 'ADMIN');
    if (isOwnerOrAdmin) return true;

    // Non-owners can only ever see PUBLISHED blogs.
    if (blog.status !== 'PUBLISHED') return false;

    switch (blog.visibility) {
      case 'PUBLIC':
      case 'UNLISTED': // reachable by direct link
        return true;
      case 'MEMBERS_ONLY':
        return !!viewer; // v1: any authenticated user
      case 'PRIVATE':
      default:
        return false;
    }
  }

  private sanitizeContent(content: unknown): Prisma.InputJsonValue | undefined {
    if (content === undefined) return undefined;
    return editorParser.sanitize(content) as Prisma.InputJsonValue;
  }

  private buildReading(content: unknown): ReadingMetadataWrite {
    const meta = editorParser.extractMetadata(content ?? null);
    return {
      readingTimeMinutes: meta.readingTimeMinutes,
      wordCount: meta.wordCount,
      charCount: meta.charCount,
      readingStats: {
        headingCount: meta.headingCount,
        imageCount: meta.imageCount,
        codeBlockCount: meta.codeBlockCount,
      },
    };
  }

  /** Validates supplied category ids exist; throws 400 if any are unknown. */
  private async resolveCategoryIds(ids?: string[]): Promise<string[]> {
    if (!ids || ids.length === 0) return [];
    const existing = await blogRepository.findExistingCategoryIds(ids);
    if (existing.length !== new Set(ids).size) {
      throw new AppError('One or more categories do not exist', 400, 'INVALID_CATEGORY');
    }
    return [...new Set(ids)];
  }

  /** Full SEO override set for a NEW blog — every field present (empty → null). */
  private normalizeSeo(input?: SeoInput): SeoWrite {
    const clean = (v?: string) => (v && v.trim() !== '' ? v.trim() : null);
    return {
      metaTitle: clean(input?.metaTitle),
      metaDescription: clean(input?.metaDescription),
      canonicalUrl: clean(input?.canonicalUrl),
      ogTitle: clean(input?.ogTitle),
      ogDescription: clean(input?.ogDescription),
      ogImage: clean(input?.ogImage),
      twitterCard: clean(input?.twitterCard),
    };
  }

  /**
   * Partial SEO patch for an UPDATE — only the keys actually present in the
   * request are written (empty string → null, an explicit clear). Omitted keys
   * are left untouched so a single-field edit doesn't wipe the others.
   */
  private seoPatch(input: SeoInput): Partial<SeoWrite> {
    const clean = (v?: string) => (v && v.trim() !== '' ? v.trim() : null);
    const patch: Partial<SeoWrite> = {};
    for (const key of Object.keys(input) as (keyof SeoInput)[]) {
      patch[key] = clean(input[key]);
    }
    return patch;
  }

  private async createWithSlugRetry(data: CreateBlogData): Promise<BlogDetail> {
    try {
      return await blogRepository.createDraft(data);
    } catch (err) {
      if (this.isSlugConflict(err)) {
        // Re-derive the base from the title (not by stripping the slug suffix,
        // which would eat a legitimate trailing number, e.g. "Chapter 5").
        const slug = await blogRepository.generateUniqueSlug(slugify(data.title));
        return blogRepository.createDraft({ ...data, slug });
      }
      throw err;
    }
  }

  private async updateWithSlugRetry(
    id: string,
    data: Parameters<typeof blogRepository.updateBlog>[1]
  ): Promise<BlogDetail> {
    try {
      return await blogRepository.updateBlog(id, data);
    } catch (err) {
      if (this.isSlugConflict(err) && data.slug) {
        const base = data.slug.replace(/-\d+$/, '');
        const slug = await blogRepository.generateUniqueSlug(base);
        return blogRepository.updateBlog(id, { ...data, slug });
      }
      throw err;
    }
  }

  private isSlugConflict(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      (err.meta?.target as string[] | undefined)?.includes('slug') !== false
    );
  }

  // ---- DTO mapping ----

  private toCardDTO(blog: BlogCard): BlogCardDTO {
    return {
      id: blog.id,
      title: blog.title,
      slug: blog.slug,
      subtitle: blog.subtitle,
      coverImage: blog.coverImage,
      status: blog.status,
      visibility: blog.visibility,
      readingTimeMinutes: blog.readingTimeMinutes,
      wordCount: blog.wordCount,
      charCount: blog.charCount,
      readingStats: this.toReadingStats(blog.readingStats),
      author: blog.author,
      tags: blog.tags.map((t) => t.tag),
      categories: blog.categories.map((c) => c.category),
      publishedAt: blog.publishedAt,
      createdAt: blog.createdAt,
      updatedAt: blog.updatedAt,
    };
  }

  private toBlogDTO(blog: BlogDetail): BlogDTO {
    return {
      ...this.toCardDTO(blog),
      content: blog.content ?? null,
      seo: this.effectiveSeo(blog),
    };
  }

  private toReadingStats(raw: Prisma.JsonValue | null): ReadingStatsDTO {
    const stats = (raw ?? {}) as Record<string, unknown>;
    return {
      headingCount: Number(stats.headingCount ?? 0),
      imageCount: Number(stats.imageCount ?? 0),
      codeBlockCount: Number(stats.codeBlockCount ?? 0),
    };
  }

  /** Merges stored SEO overrides with generated defaults (computed at read time). */
  private effectiveSeo(blog: BlogDetail): SeoDTO {
    const seo = blog.seo;
    const metaTitle = seo?.metaTitle ?? blog.title;
    const metaDescription =
      seo?.metaDescription ?? blog.subtitle ?? this.deriveDescription(blog.content);
    return {
      metaTitle,
      metaDescription,
      canonicalUrl: seo?.canonicalUrl ?? null,
      ogTitle: seo?.ogTitle ?? metaTitle,
      ogDescription: seo?.ogDescription ?? metaDescription,
      ogImage: seo?.ogImage ?? blog.coverImage,
      twitterCard: seo?.twitterCard ?? 'summary_large_image',
    };
  }

  private deriveDescription(content: Prisma.JsonValue | null): string | null {
    if (!content) return null;
    const { plainText } = editorParser.extractMetadata(content);
    const trimmed = plainText.trim();
    if (!trimmed) return null;
    return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
  }
}

export const blogService = new BlogService();
