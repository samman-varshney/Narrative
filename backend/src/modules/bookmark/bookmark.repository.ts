import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import { blogCardSelect } from '../blog/blog.repository';
import type { BookmarkListQuery } from './bookmark.validator';

/**
 * Bookmark rows are always read together with a lean blog card. `blogCardSelect`
 * is reused verbatim from the Blog module rather than redefined here, so the
 * bookmark library and the blog feeds stay field-for-field identical — and the
 * heavy `content` JSON stays excluded. `coverImage` is a denormalized URL on
 * Blog, so no Media join is needed.
 */
export const bookmarkBlogInclude = {
  blog: { select: blogCardSelect },
} satisfies Prisma.BookmarkInclude;

export type BookmarkWithBlog = Prisma.BookmarkGetPayload<{
  include: typeof bookmarkBlogInclude;
}>;

/** The subset of the list query that narrows which bookmarks are returned. */
export type BookmarkFilters = Pick<BookmarkListQuery, 'authorId' | 'tag'>;

export class BookmarkRepository {
  /**
   * Idempotent bookmark. Attempts to create the row and swallows the unique-
   * constraint violation (P2002) raised when the blog is already bookmarked, so
   * a repeat call is a no-op. Returns whether a new row was created so the
   * service knows whether to emit BLOG_BOOKMARKED.
   */
  async bookmark(userId: string, blogId: string): Promise<{ created: boolean }> {
    try {
      await prisma.bookmark.create({ data: { userId, blogId } });
      return { created: true };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { created: false };
      }
      throw err;
    }
  }

  /**
   * Idempotent un-bookmark. `deleteMany` returns a count instead of throwing
   * when the row is absent, so removing a bookmark that isn't there is a no-op.
   * Returns how many rows were removed (0 or 1).
   */
  async unbookmark(userId: string, blogId: string): Promise<{ count: number }> {
    const result = await prisma.bookmark.deleteMany({
      where: { userId, blogId },
    });
    return { count: result.count };
  }

  /**
   * Flips the bookmark and reports both the resulting state and whether THIS
   * call was the one that changed it. Create-first (rather than read-then-write)
   * so two concurrent toggles cannot both observe "absent" and double-insert —
   * the unique constraint arbitrates.
   *
   * `changed` exists because the losing side of a concurrent toggle reaches the
   * same end state without having mutated anything; the service emits only on a
   * real change, so a single removal can never produce two events.
   */
  async toggleBookmark(
    userId: string,
    blogId: string
  ): Promise<{ bookmarked: boolean; changed: boolean }> {
    try {
      await prisma.bookmark.create({ data: { userId, blogId } });
      return { bookmarked: true, changed: true };
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
    }

    // `deleteMany` reports a count instead of throwing when a racing request
    // already removed the row, so we can tell "I removed it" from "it was gone".
    const { count } = await prisma.bookmark.deleteMany({
      where: { userId, blogId },
    });
    return { bookmarked: false, changed: count > 0 };
  }

  /** Whether `userId` has bookmarked `blogId`. */
  async exists(userId: string, blogId: string): Promise<boolean> {
    const row = await prisma.bookmark.findUnique({
      // NB: the compound unique is declared [blogId, userId] — field order here
      // must match the schema, unlike Follow's [followerId, followingId].
      where: { blogId_userId: { blogId, userId } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * A page of `userId`'s bookmarks with their blog cards, ordered by when they
   * were saved. Fetches `limit + 1` to detect a next page. The `id` tiebreaker
   * keeps ordering total, so the cursor can never skip or repeat a row.
   */
  async getBookmarks(
    userId: string,
    query: BookmarkListQuery
  ): Promise<BookmarkWithBlog[]> {
    const direction = query.sort === 'oldest' ? 'asc' : 'desc';
    return prisma.bookmark.findMany({
      where: this.buildWhere(userId, query),
      include: bookmarkBlogInclude,
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    });
  }

  /**
   * Total bookmarks for `userId` under the same filters as `getBookmarks`, so
   * `totalCount` always describes the set actually being paged.
   */
  async countBookmarks(
    userId: string,
    filters: BookmarkFilters = {}
  ): Promise<number> {
    return prisma.bookmark.count({ where: this.buildWhere(userId, filters) });
  }

  /** How many users have bookmarked `blogId`. Index-served via ([blogId]). */
  async countBlogBookmarks(blogId: string): Promise<number> {
    return prisma.bookmark.count({ where: { blogId } });
  }

  /**
   * Of `blogIds`, which has `userId` already bookmarked? Single batched query
   * for annotating blog feeds with `isBookmarked` (avoids N+1). Not yet wired to
   * a route — kept here so the Blog module can adopt it without a data-layer change.
   */
  async getBookmarkedSubset(
    userId: string,
    blogIds: string[]
  ): Promise<Set<string>> {
    if (blogIds.length === 0) return new Set();
    const rows = await prisma.bookmark.findMany({
      where: { userId, blogId: { in: blogIds } },
      select: { blogId: true },
    });
    return new Set(rows.map((r) => r.blogId));
  }

  /**
   * Shared `where` for the list and count queries — they must never diverge or
   * `totalCount` would contradict the page. `userId` leads so the
   * (userId, createdAt) index is used; the optional blog filters are applied as
   * a nested relation filter.
   */
  private buildWhere(
    userId: string,
    filters: BookmarkFilters
  ): Prisma.BookmarkWhereInput {
    const { authorId, tag } = filters;
    const blogFilter: Prisma.BlogWhereInput = {
      ...(authorId && { authorId }),
      ...(tag && { tags: { some: { tag: { slug: tag } } } }),
    };

    return {
      userId,
      ...(Object.keys(blogFilter).length > 0 && { blog: blogFilter }),
    };
  }
}

export const bookmarkRepository = new BookmarkRepository();
