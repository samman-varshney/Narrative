import { Prisma, BlogStatus, BlogVisibility } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import type { CursorPagination } from '../../core/utils/pagination';
import { slugify, nextIncrementalSlug } from '../../core/utils/slug';

/**
 * Public, non-sensitive author fields embedded in blog payloads — the canonical
 * "public author" projection shared with the Follow module.
 */
export const blogAuthorSelect = {
  id: true,
  username: true,
  name: true,
  avatar: true,
  bio: true,
  isVerified: true,
} satisfies Prisma.UserSelect;

// Join-row projections: flatten to the tag/category itself at the service layer.
const tagLinkSelect = {
  select: { tag: { select: { id: true, name: true, slug: true } } },
};
const categoryLinkSelect = {
  select: { category: { select: { id: true, name: true, slug: true } } },
};

/** Lean projection for list/card views — omits the heavy `content` JSON. */
export const blogCardSelect = {
  id: true,
  title: true,
  slug: true,
  subtitle: true,
  coverImage: true,
  status: true,
  visibility: true,
  // Moderation state rides along on every card and detail payload. The author
  // has to be told their post was hidden — a post that silently stops appearing
  // anywhere, with the dashboard still listing it as published, is
  // indistinguishable from a platform bug.
  isHidden: true,
  hiddenAt: true,
  readingTimeMinutes: true,
  wordCount: true,
  charCount: true,
  readingStats: true,
  authorId: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: blogAuthorSelect },
  tags: tagLinkSelect,
  categories: categoryLinkSelect,
} satisfies Prisma.BlogSelect;

/** Full projection for detail/preview views — adds content, cover ref, and SEO. */
export const blogDetailSelect = {
  ...blogCardSelect,
  content: true,
  coverMediaId: true,
  seo: true,
} satisfies Prisma.BlogSelect;

/**
 * Access-control projection: exactly the fields `blogService.canView` reads.
 * Sibling modules that only need to gate on visibility use this instead of
 * `blogDetailSelect`, so an existence check doesn't drag the whole content JSON
 * (and its SEO/tag joins) across the wire.
 */
export const blogVisibilitySelect = {
  id: true,
  status: true,
  visibility: true,
  isHidden: true,
  authorId: true,
  // Title/slug ride along for notification copy and deep links. Still four
  // scalars — nothing like the content JSON `blogDetailSelect` would pull.
  title: true,
  slug: true,
} satisfies Prisma.BlogSelect;

/**
 * Descriptive scalars a sibling module needs to reason about a blog without
 * loading it: ownership, lifecycle, display text, and the reading estimate.
 *
 * Distinct from `blogVisibilitySelect`, which exists for permission checks and
 * is deliberately kept to what those need. This one adds `readingTimeMinutes`
 * and `publishedAt` — the Analytics module validates claimed reading durations
 * against the former and labels its reports with the latter.
 */
export const blogMetaSelect = {
  id: true,
  authorId: true,
  status: true,
  visibility: true,
  isHidden: true,
  title: true,
  slug: true,
  readingTimeMinutes: true,
  publishedAt: true,
} satisfies Prisma.BlogSelect;

export type BlogCard = Prisma.BlogGetPayload<{ select: typeof blogCardSelect }>;
export type BlogDetail = Prisma.BlogGetPayload<{ select: typeof blogDetailSelect }>;
export type BlogVisibilityRow = Prisma.BlogGetPayload<{
  select: typeof blogVisibilitySelect;
}>;
export type BlogMetaRow = Prisma.BlogGetPayload<{ select: typeof blogMetaSelect }>;

/** Reading metadata written on every content change. */
export interface ReadingMetadataWrite {
  readingTimeMinutes: number;
  wordCount: number;
  charCount: number;
  readingStats: Prisma.InputJsonValue;
}

/** Fully-resolved SEO fields (defaults already applied by the service). */
export interface SeoWrite {
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  twitterCard: string | null;
}

export interface CreateBlogData {
  authorId: string;
  title: string;
  slug: string;
  subtitle?: string | null;
  content?: Prisma.InputJsonValue;
  visibility?: BlogVisibility;
  reading: ReadingMetadataWrite;
  tagIds: string[];
  categoryIds: string[];
  seo: SeoWrite;
}

/**
 * Sort key for author-scoped listings.
 *
 * Three keys because the three author-facing views genuinely order by different
 * things: "my blogs" by when they were written, a draft list by when it was last
 * touched (the one a writer means by "recent"), and a published list by when it
 * went out. Every one is paired with an `id` tiebreaker at the query, so the
 * ordering is total and a cursor can neither skip nor repeat a row.
 */
export type AuthorBlogOrder = 'created' | 'updated' | 'published';

const AUTHOR_ORDER_BY: Record<AuthorBlogOrder, Prisma.BlogOrderByWithRelationInput[]> = {
  created: [{ createdAt: 'desc' }, { id: 'desc' }],
  updated: [{ updatedAt: 'desc' }, { id: 'desc' }],
  // NULLS come last in Postgres for DESC, so a never-published blog that slipped
  // into the filter sorts to the end rather than to the top.
  published: [{ publishedAt: 'desc' }, { id: 'desc' }],
};

/** Filter and ordering options for author-scoped blog listings. */
export interface AuthorFilter {
  statuses?: BlogStatus[];
  visibility?: BlogVisibility;
  /**
   * Sort key, defaulting to `created`. Ignored by the count queries, which have
   * no ordering — they share `authorWhere` with the list so the two can never
   * describe different sets.
   */
  order?: AuthorBlogOrder;
  /**
   * Drops moderation-hidden blogs. OFF by default, because the author's own
   * management views must keep showing a hidden post (with its flag) — losing
   * track of it is worse than seeing it. Turned on by the summary surfaces
   * where a hidden post would read as a live one; see `blogService.listMyBlogs`.
   */
  excludeHidden?: boolean;
}

export interface UpdateBlogData {
  title?: string;
  slug?: string;
  subtitle?: string | null;
  content?: Prisma.InputJsonValue;
  visibility?: BlogVisibility;
  reading?: ReadingMetadataWrite;
  /** When defined, REPLACES the blog's tag set (empty array clears it). */
  tagIds?: string[];
  /** When defined, REPLACES the blog's category set. */
  categoryIds?: string[];
  /** When defined, upserts the SEO row with these (partial) fields. */
  seo?: Partial<SeoWrite>;
}

export class BlogRepository {
  // ---- Writes ----

  /** Creates a DRAFT blog with its SEO row and tag/category join rows atomically. */
  async createDraft(data: CreateBlogData): Promise<BlogDetail> {
    return prisma.blog.create({
      data: {
        title: data.title,
        slug: data.slug,
        subtitle: data.subtitle ?? null,
        ...(data.content !== undefined && { content: data.content }),
        ...(data.visibility && { visibility: data.visibility }),
        status: 'DRAFT',
        readingTimeMinutes: data.reading.readingTimeMinutes,
        wordCount: data.reading.wordCount,
        charCount: data.reading.charCount,
        readingStats: data.reading.readingStats,
        author: { connect: { id: data.authorId } },
        seo: { create: data.seo },
        tags: {
          create: data.tagIds.map((tagId) => ({ tag: { connect: { id: tagId } } })),
        },
        categories: {
          create: data.categoryIds.map((categoryId) => ({
            category: { connect: { id: categoryId } },
          })),
        },
      },
      select: blogDetailSelect,
    });
  }

  /**
   * Updates a blog's editable fields and, when provided, re-syncs its SEO row
   * and tag/category sets in a single transaction.
   */
  async updateBlog(id: string, data: UpdateBlogData): Promise<BlogDetail> {
    return prisma.$transaction(async (tx) => {
      const blogData: Prisma.BlogUpdateInput = {};
      if (data.title !== undefined) blogData.title = data.title;
      if (data.slug !== undefined) blogData.slug = data.slug;
      if (data.subtitle !== undefined) blogData.subtitle = data.subtitle;
      if (data.content !== undefined) blogData.content = data.content;
      if (data.visibility !== undefined) blogData.visibility = data.visibility;
      if (data.reading) {
        blogData.readingTimeMinutes = data.reading.readingTimeMinutes;
        blogData.wordCount = data.reading.wordCount;
        blogData.charCount = data.reading.charCount;
        blogData.readingStats = data.reading.readingStats;
      }

      if (Object.keys(blogData).length > 0) {
        await tx.blog.update({ where: { id }, data: blogData });
      }

      if (data.seo) {
        await tx.blogSEO.upsert({
          where: { blogId: id },
          update: data.seo,
          create: { ...data.seo, blogId: id },
        });
      }

      if (data.tagIds !== undefined) {
        await tx.blogTag.deleteMany({ where: { blogId: id } });
        if (data.tagIds.length > 0) {
          await tx.blogTag.createMany({
            data: data.tagIds.map((tagId) => ({ blogId: id, tagId })),
          });
        }
      }

      if (data.categoryIds !== undefined) {
        await tx.blogCategory.deleteMany({ where: { blogId: id } });
        if (data.categoryIds.length > 0) {
          await tx.blogCategory.createMany({
            data: data.categoryIds.map((categoryId) => ({ blogId: id, categoryId })),
          });
        }
      }

      return tx.blog.findUniqueOrThrow({ where: { id }, select: blogDetailSelect });
    });
  }

  /** Low-level status transition writer used by publish/archive/restore/delete. */
  async setStatus(
    id: string,
    status: BlogStatus,
    opts: { publishedAt?: Date } = {}
  ): Promise<BlogDetail> {
    return prisma.blog.update({
      where: { id },
      data: {
        status,
        ...(opts.publishedAt && { publishedAt: opts.publishedAt }),
      },
      select: blogDetailSelect,
    });
  }

  /**
   * Moderation hide/restore, as a CONDITIONAL update.
   *
   * Returns whether this call is the one that changed the row. Two moderators
   * acting on the same blog from the same queue page is an ordinary occurrence,
   * and without the condition both would "succeed", both would write an audit
   * record, and the author would be told twice. Reported as a conflict instead.
   *
   * `hiddenAt` moves with the flag rather than being left behind on restore, so
   * the pair can never say "visible, hidden since Tuesday".
   */
  async setModerationHidden(id: string, hidden: boolean): Promise<boolean> {
    const result = await prisma.blog.updateMany({
      where: { id, isHidden: !hidden },
      data: { isHidden: hidden, hiddenAt: hidden ? new Date() : null },
    });
    return result.count === 1;
  }

  /**
   * Moderation delete: DELETED unless it already is. Conditional for the same
   * reason `setModerationHidden` is — two moderators, one queue row.
   *
   * `isHidden` is set ALONGSIDE the status, and that pairing is load-bearing
   * twice over:
   *
   *  - It is what makes the removal stick. Every author-side write is gated on
   *    `isHidden` by `assertNotModerated`, and on `isHidden` only — so a removal
   *    that moved the status alone would leave `POST /blogs/:id/restore`
   *    (DELETED → DRAFT) wide open to the author. The removal would be undoable
   *    by the very person it was aimed at, with nothing in the audit log.
   *  - It is what tells a later restore whose deletion this was. `status =
   *    DELETED AND isHidden` means moderation removed it; a plain DELETED row is
   *    the author's own doing, because their delete cannot run while the flag is
   *    set. No `deletedBy` column, and none needed.
   *
   * `hiddenAt` moves to now even on an already-hidden blog: it records when the
   * CURRENT withholding began, and a removal is a new, stronger one. The full
   * sequence lives in the audit log, which is append-only and is the place to
   * read history from.
   */
  async moderationDelete(id: string): Promise<boolean> {
    const result = await prisma.blog.updateMany({
      where: { id, status: { not: 'DELETED' } },
      data: { status: 'DELETED', isHidden: true, hiddenAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * Moderation restore: lifts the hide, and — when `revive` is set — brings a
   * moderation-REMOVED blog back in the same write.
   *
   * A revived blog lands in DRAFT, not in whatever status it held before the
   * removal. That status is recorded nowhere, and defaulting it to PUBLISHED
   * would put content an administrator judged removable straight back in front
   * of readers. The author re-publishes, which re-runs the publish path.
   *
   * Both shapes stay CONDITIONAL, and each condition names the full state it
   * expects rather than just the row id: two moderators restoring the same queue
   * entry still yield one restore, one audit record and one notification, and a
   * restore that races a removal loses cleanly (0 rows → 409) instead of
   * half-applying.
   */
  async moderationRestore(id: string, opts: { revive: boolean }): Promise<boolean> {
    const result = await prisma.blog.updateMany({
      where: opts.revive
        ? { id, isHidden: true, status: 'DELETED' }
        : { id, isHidden: true, status: { not: 'DELETED' } },
      data: {
        isHidden: false,
        hiddenAt: null,
        ...(opts.revive && { status: 'DRAFT' as const }),
      },
    });
    return result.count === 1;
  }

  /**
   * Everything a moderator needs to judge a blog, in one query.
   *
   * Includes the content JSON — a moderation decision cannot be made from a
   * title — which is exactly why this is separate from `findMetaById` rather
   * than an option on it: nothing else on the platform should be loading a
   * blog's body to answer a question about its state.
   */
  findModerationSnapshot(id: string) {
    return prisma.blog.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        slug: true,
        subtitle: true,
        content: true,
        status: true,
        visibility: true,
        isHidden: true,
        hiddenAt: true,
        authorId: true,
        author: { select: blogAuthorSelect },
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /** Lightweight autosave write — content + reading metadata only, no relations. */
  async autosave(
    id: string,
    data: {
      title?: string;
      subtitle?: string | null;
      content?: Prisma.InputJsonValue;
      reading?: ReadingMetadataWrite;
    }
  ): Promise<BlogDetail> {
    const blogData: Prisma.BlogUpdateInput = {};
    if (data.title !== undefined) blogData.title = data.title;
    if (data.subtitle !== undefined) blogData.subtitle = data.subtitle;
    if (data.content !== undefined) blogData.content = data.content;
    if (data.reading) {
      blogData.readingTimeMinutes = data.reading.readingTimeMinutes;
      blogData.wordCount = data.reading.wordCount;
      blogData.charCount = data.reading.charCount;
      blogData.readingStats = data.reading.readingStats;
    }
    return prisma.blog.update({ where: { id }, data: blogData, select: blogDetailSelect });
  }

  /** Connects a new cover Media reference (and denormalized URL). */
  async updateCover(
    id: string,
    coverImage: string,
    coverMediaId: string
  ): Promise<BlogDetail> {
    return prisma.blog.update({
      where: { id },
      data: { coverImage, coverMedia: { connect: { id: coverMediaId } } },
      select: blogDetailSelect,
    });
  }

  // ---- Reads ----

  findBySlug(slug: string): Promise<BlogDetail | null> {
    return prisma.blog.findUnique({ where: { slug }, select: blogDetailSelect });
  }

  findById(id: string): Promise<BlogDetail | null> {
    return prisma.blog.findUnique({ where: { id }, select: blogDetailSelect });
  }

  /**
   * Existence + access-control fields only, for sibling modules that just need
   * to gate on `blogService.canView`. Avoids loading the content JSON on hot
   * paths that never render the blog.
   */
  findVisibilityById(id: string): Promise<BlogVisibilityRow | null> {
    return prisma.blog.findUnique({ where: { id }, select: blogVisibilitySelect });
  }

  /** Descriptive scalars for a sibling module. See `blogMetaSelect`. */
  findMetaById(id: string): Promise<BlogMetaRow | null> {
    return prisma.blog.findUnique({ where: { id }, select: blogMetaSelect });
  }

  /** Blog counts by status for one author. Feeds the author analytics overview. */
  async countByStatus(authorId: string): Promise<Record<BlogStatus, number>> {
    const rows = await prisma.blog.groupBy({
      by: ['status'],
      where: { authorId },
      _count: { _all: true },
    });

    // Every status present, so a caller never has to distinguish "none" from
    // "absent from the grouping".
    const counts = { DRAFT: 0, PUBLISHED: 0, ARCHIVED: 0, DELETED: 0 } as Record<
      BlogStatus,
      number
    >;
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
  }

  /** Cursor page of a single author's blogs, optionally filtered by status/visibility. */
  findByAuthor(
    authorId: string,
    { cursor, limit }: CursorPagination,
    opts: AuthorFilter = {}
  ): Promise<BlogCard[]> {
    return prisma.blog.findMany({
      where: this.authorWhere(authorId, opts),
      select: blogCardSelect,
      orderBy: AUTHOR_ORDER_BY[opts.order ?? 'created'],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  /**
   * A short, uncursored list of one author's blogs.
   *
   * The preview-widget primitive: no cursor, and — the point — no companion
   * count. `findByAuthor` is always paired with `countByAuthor` because a paged
   * list has to report a total; a five-item dashboard panel does not, and paying
   * for that count on every panel is how an aggregation endpoint quietly doubles
   * its query count.
   */
  listByAuthor(
    authorId: string,
    limit: number,
    opts: AuthorFilter = {}
  ): Promise<BlogCard[]> {
    return prisma.blog.findMany({
      where: this.authorWhere(authorId, opts),
      select: blogCardSelect,
      orderBy: AUTHOR_ORDER_BY[opts.order ?? 'created'],
      take: limit,
    });
  }

  /**
   * Cards for a known set of the author's blog ids, in ONE query.
   *
   * `authorId` is part of the filter and not merely assumed from the ids: a
   * caller that passed an id it does not own gets nothing back rather than
   * another author's blog. Hydration for a list that arrived from elsewhere —
   * an analytics ranking, say — is the only reason this exists, and the batching
   * is the reason it is a repository method instead of a loop over `findById`.
   */
  findCardsByIds(
    authorId: string,
    ids: string[],
    opts: { excludeHidden?: boolean } = {}
  ): Promise<BlogCard[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.blog.findMany({
      where: {
        id: { in: ids },
        authorId,
        ...(opts.excludeHidden && { isHidden: false }),
      },
      select: blogCardSelect,
    });
  }

  countByAuthor(authorId: string, opts: AuthorFilter = {}): Promise<number> {
    return prisma.blog.count({ where: this.authorWhere(authorId, opts) });
  }

  private authorWhere(authorId: string, opts: AuthorFilter): Prisma.BlogWhereInput {
    return {
      authorId,
      ...(opts.statuses && { status: { in: opts.statuses } }),
      ...(opts.visibility && { visibility: opts.visibility }),
      ...(opts.excludeHidden && { isHidden: false }),
    };
  }

  /** Cursor page of publicly-visible published blogs, newest-published first. */
  findPublished({ cursor, limit }: CursorPagination): Promise<BlogCard[]> {
    return prisma.blog.findMany({
      where: { status: 'PUBLISHED', visibility: 'PUBLIC' },
      select: blogCardSelect,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  countPublished(): Promise<number> {
    return prisma.blog.count({ where: { status: 'PUBLISHED', visibility: 'PUBLIC' } });
  }

  findDrafts(authorId: string, pagination: CursorPagination): Promise<BlogCard[]> {
    return this.findByAuthor(authorId, pagination, { statuses: ['DRAFT'] });
  }

  // ---- Slug generation ----

  /**
   * Resolves a unique slug from `base` using incremental numbering: the bare
   * `base` if free, else `base-2`, `base-3`, … Best-effort at the app layer;
   * the DB `@unique` on `Blog.slug` is the ultimate guard (callers retry on P2002).
   */
  async generateUniqueSlug(
    base: string,
    tx: Prisma.TransactionClient | typeof prisma = prisma
  ): Promise<string> {
    const rows = await tx.blog.findMany({
      where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
      select: { slug: true },
    });
    return nextIncrementalSlug(base, rows.map((r) => r.slug));
  }

  // ---- Tags (free, get-or-create) ----

  /**
   * Resolves each tag name to a Tag id, creating tags that don't exist yet
   * (name is the natural key; slug is derived and de-duplicated). Race-safe:
   * a concurrent create that loses the `name` unique race is re-read.
   */
  async upsertTagsByName(names: string[]): Promise<string[]> {
    const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    return Promise.all(unique.map((name) => this.getOrCreateTag(name)));
  }

  private async getOrCreateTag(name: string): Promise<string> {
    const existing = await prisma.tag.findUnique({
      where: { name },
      select: { id: true },
    });
    if (existing) return existing.id;

    const slug = await this.uniqueSlugForTag(slugify(name));
    try {
      const created = await prisma.tag.create({
        data: { name, slug },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await prisma.tag.findUnique({ where: { name }, select: { id: true } });
        if (again) return again.id;
      }
      throw err;
    }
  }

  private async uniqueSlugForTag(base: string): Promise<string> {
    const rows = await prisma.tag.findMany({
      where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
      select: { slug: true },
    });
    return nextIncrementalSlug(base, rows.map((r) => r.slug));
  }

  searchTags(q: string | undefined, limit: number) {
    return prisma.tag.findMany({
      where: q ? { name: { contains: q, mode: 'insensitive' } } : undefined,
      orderBy: { name: 'asc' },
      take: limit,
      select: { id: true, name: true, slug: true },
    });
  }

  // ---- Categories (admin-curated) ----

  /** Returns the subset of `ids` that reference existing categories. */
  async findExistingCategoryIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  listCategories() {
    return prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true },
    });
  }

  async createCategory(name: string) {
    const slug = await this.uniqueSlugForCategory(slugify(name));
    return prisma.category.create({
      data: { name, slug },
      select: { id: true, name: true, slug: true },
    });
  }

  private async uniqueSlugForCategory(base: string): Promise<string> {
    const rows = await prisma.category.findMany({
      where: { OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
      select: { slug: true },
    });
    return nextIncrementalSlug(base, rows.map((r) => r.slug));
  }
}

export const blogRepository = new BlogRepository();
