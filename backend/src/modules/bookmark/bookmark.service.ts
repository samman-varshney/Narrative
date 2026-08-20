import { BlogVisibility } from '@prisma/client';
import {
  bookmarkRepository,
  BookmarkWithBlog,
} from './bookmark.repository';
import { BookmarkListQuery } from './bookmark.validator';
import { blogRepository } from '../blog/blog.repository';
import { blogService, Viewer } from '../blog/blog.service';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { buildCursorPage } from '../../core/utils/pagination';
import { collectPaged } from '../../core/utils/collectPaged';
import { EXPORT_MAX_ROWS_PER_COLLECTION, EXPORT_PAGE_SIZE } from '../export/export.config';

/** The author of a bookmarked blog, as it appears on a bookmark card. */
export interface BookmarkAuthorDTO {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  isVerified: boolean;
}

/**
 * A lightweight blog card for the bookmark library. Deliberately excludes the
 * blog's `content` — a library page must stay cheap even with thousands of rows.
 */
export interface BookmarkedBlogDTO {
  id: string;
  title: string;
  slug: string;
  coverImage: string | null;
  readingTimeMinutes: number;
  author: BookmarkAuthorDTO;
  publishedAt: Date | null;
  visibility: BlogVisibility;
}

/** One entry in a user's bookmark library. */
export interface BookmarkItemDTO {
  bookmarkId: string;
  bookmarkedAt: Date;
  /**
   * False when the blog was deleted or its visibility was tightened after the
   * bookmark was made. The row is still returned (so the UI can show "no longer
   * available" and offer to remove it) but `blog` is nulled — the title, slug
   * and author of a now-hidden blog must never leak.
   */
  isAvailable: boolean;
  blog: BookmarkedBlogDTO | null;
}

/**
 * Whether the viewer has bookmarked a blog, plus both relevant counts.
 *
 * The two counts are named explicitly because a bare `bookmarksCount` on a
 * blog-scoped route reads as "how many people saved this blog" to some callers
 * and "how many blogs have I saved" to others. Spelling out the subject removes
 * the ambiguity — and both numbers are index-served, so exposing both is cheap.
 */
export interface BookmarkStatusDTO {
  isBookmarked: boolean;
  /** How many blogs the requesting viewer has bookmarked in total. */
  viewerBookmarksCount: number;
  /** How many users have bookmarked this blog (social proof). */
  blogBookmarksCount: number;
}

/** A single page of the bookmark library. */
export interface BookmarkListResult {
  items: BookmarkItemDTO[];
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
}

export class BookmarkService {
  /**
   * Bookmark `blogId` as `userId`. Idempotent: bookmarking an already-bookmarked
   * blog succeeds without creating a duplicate or re-emitting the event. The
   * owner is the authenticated user, enforcing "act as yourself".
   */
  async addBookmark(
    userId: string,
    blogId: string,
    role: string
  ): Promise<BookmarkStatusDTO> {
    await this.assertBookmarkableBlog(blogId, { userId, role });

    const { created } = await bookmarkRepository.bookmark(userId, blogId);
    if (created) {
      eventBus.emit(EVENTS.BLOG_BOOKMARKED, { blogId, userId });
    }

    // The write's outcome is authoritative — whether it created the row or hit
    // the unique constraint, the blog is bookmarked afterwards. Re-reading with
    // `exists` would cost a round trip and could disagree with what we emitted.
    return this.buildStatus(userId, blogId, true);
  }

  /**
   * Remove the bookmark on `blogId`. Idempotent, and deliberately performs NO
   * blog lookup: a user must always be able to clear a bookmark whose blog was
   * since deleted or made private.
   */
  async removeBookmark(userId: string, blogId: string): Promise<BookmarkStatusDTO> {
    const { count } = await bookmarkRepository.unbookmark(userId, blogId);
    if (count > 0) {
      eventBus.emit(EVENTS.BLOG_UNBOOKMARKED, { blogId, userId });
    }

    return this.buildStatus(userId, blogId, false);
  }

  /**
   * Flip the bookmark on `blogId` and return the resulting state. Gated by the
   * same visibility check as `addBookmark`, since a toggle can create a row.
   */
  async toggleBookmark(
    userId: string,
    blogId: string,
    role: string
  ): Promise<BookmarkStatusDTO> {
    await this.assertBookmarkableBlog(blogId, { userId, role });

    const { bookmarked, changed } = await bookmarkRepository.toggleBookmark(
      userId,
      blogId
    );
    // Emit only when THIS call mutated the row. The losing side of a concurrent
    // toggle reaches the same end state without changing anything, and emitting
    // there would double-count a single removal for every downstream listener.
    if (changed) {
      eventBus.emit(
        bookmarked ? EVENTS.BLOG_BOOKMARKED : EVENTS.BLOG_UNBOOKMARKED,
        { blogId, userId }
      );
    }

    // Report the state this call produced, so the response can never contradict
    // the event that was just emitted.
    return this.buildStatus(userId, blogId, bookmarked);
  }

  /**
   * Public bookmark counts for many blogs, keyed by blog id.
   *
   * The Bookmark module's contribution to other modules' list views — the Feed
   * module renders it on every card. Counts only; WHO bookmarked a blog stays
   * private to its owner, which is why there is no batched variant of
   * `getBookmarkedSubset` exposed here for arbitrary viewers.
   */
  getBookmarkCounts(blogIds: string[]): Promise<Map<string, number>> {
    return bookmarkRepository.countForBlogs(blogIds);
  }

  /**
   * Bookmark state of `blogId` for `userId`, plus both counts. Gated by the same
   * visibility check as the writes, so a client can't be shown an enabled
   * bookmark button for a blog whose POST would then 404.
   */
  async getStatus(
    userId: string,
    blogId: string,
    role: string
  ): Promise<BookmarkStatusDTO> {
    await this.assertBookmarkableBlog(blogId, { userId, role });
    const isBookmarked = await bookmarkRepository.exists(userId, blogId);
    return this.buildStatus(userId, blogId, isBookmarked);
  }

  /**
   * A page of `userId`'s own bookmark library. `totalCount` reflects the same
   * filters as the page, so the two never contradict each other.
   */
  async getUserBookmarks(
    userId: string,
    query: BookmarkListQuery,
    role: string
  ): Promise<BookmarkListResult> {
    const [rows, totalCount] = await Promise.all([
      bookmarkRepository.getBookmarks(userId, query),
      bookmarkRepository.countBookmarks(userId, query),
    ]);

    const page = buildCursorPage(rows, query.limit, (r) => r.id);

    return {
      items: page.items.map((row) => this.toItemDTO(row, { userId, role })),
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      totalCount,
    };
  }

  // ---- Internal helpers ----

  /**
   * Assembles the status DTO around an already-known `isBookmarked`, fetching
   * both counts in parallel. Callers pass the state their own write produced
   * rather than re-reading it, which saves a round trip and keeps the response
   * consistent with the event that was emitted alongside it.
   */
  private async buildStatus(
    userId: string,
    blogId: string,
    isBookmarked: boolean
  ): Promise<BookmarkStatusDTO> {
    const [viewerBookmarksCount, blogBookmarksCount] = await Promise.all([
      bookmarkRepository.countBookmarks(userId),
      bookmarkRepository.countBlogBookmarks(blogId),
    ]);
    return { isBookmarked, viewerBookmarksCount, blogBookmarksCount };
  }

  /**
   * Verifies the blog exists and the viewer may see it, delegating to the Blog
   * module's shared `canView` guard rather than re-implementing the visibility
   * matrix. Throws 404 — never 403 — so a hidden blog's existence isn't leaked.
   */
  private async assertBookmarkableBlog(blogId: string, viewer: Viewer): Promise<void> {
    // Visibility projection, not the full detail: bookmarking never renders the
    // blog, so pulling its content JSON here would be pure waste on a hot path.
    const blog = await blogRepository.findVisibilityById(blogId);
    if (!blog || !blogService.canView(blog, viewer)) {
      throw new AppError('Blog not found', 404, 'BLOG_NOT_FOUND');
    }
  }

  /**
   * Maps a bookmark row to its DTO, re-checking visibility per row: a blog that
   * was visible when bookmarked may have been deleted or restricted since.
   */
  private toItemDTO(row: BookmarkWithBlog, viewer: Viewer): BookmarkItemDTO {
    const isAvailable = blogService.canView(row.blog, viewer);
    return {
      bookmarkId: row.id,
      bookmarkedAt: row.createdAt,
      isAvailable,
      blog: isAvailable ? this.toBlogDTO(row.blog) : null,
    };
  }

  private toBlogDTO(blog: BookmarkWithBlog['blog']): BookmarkedBlogDTO {
    return {
      id: blog.id,
      title: blog.title,
      slug: blog.slug,
      coverImage: blog.coverImage,
      readingTimeMinutes: blog.readingTimeMinutes,
      author: {
        id: blog.author.id,
        username: blog.author.username,
        name: blog.author.name,
        avatar: blog.author.avatar,
        isVerified: blog.author.isVerified,
      },
      publishedAt: blog.publishedAt,
      visibility: blog.visibility,
    };
  }

  /** This user's whole reading list, for the data export. */
  async collectForExport(userId: string) {
    type Row = Awaited<ReturnType<typeof bookmarkRepository.findAllByUserForExport>>[number];
    return collectPaged<Row>(
      (previous) =>
        bookmarkRepository.findAllByUserForExport(userId, EXPORT_PAGE_SIZE, previous?.id),
      EXPORT_PAGE_SIZE,
      EXPORT_MAX_ROWS_PER_COLLECTION
    );
  }
}

export const bookmarkService = new BookmarkService();
