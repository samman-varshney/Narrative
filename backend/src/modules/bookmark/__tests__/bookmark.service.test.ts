import { bookmarkService } from '../bookmark.service';
import { bookmarkRepository } from '../bookmark.repository';
import { blogRepository } from '../../blog/blog.repository';
import { blogService } from '../../blog/blog.service';
import { eventBus, EVENTS } from '../../../core/events/eventBus';

jest.mock('../bookmark.repository');
jest.mock('../../blog/blog.repository');
jest.mock('../../blog/blog.service');
jest.mock('../../../core/events/eventBus');

const mockedBookmarkRepo = bookmarkRepository as jest.Mocked<typeof bookmarkRepository>;
const mockedBlogRepo = blogRepository as jest.Mocked<typeof blogRepository>;
const mockedBlogService = blogService as jest.Mocked<typeof blogService>;

const VIEWER = { userId: 'u1', role: 'USER' };

/** A bookmark row as the repository returns it, with its joined blog card. */
const bookmarkRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  userId: 'u1',
  blogId: `blog-${id}`,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  blog: {
    id: `blog-${id}`,
    title: 'Deep Dive',
    slug: 'deep-dive',
    coverImage: 'https://cdn.test/cover.png',
    readingTimeMinutes: 7,
    status: 'PUBLISHED',
    visibility: 'PUBLIC',
    authorId: 'author1',
    publishedAt: new Date('2026-06-01T00:00:00Z'),
    author: {
      id: 'author1',
      username: 'ada',
      name: 'Ada',
      avatar: null,
      bio: 'hi',
      isVerified: true,
    },
    ...overrides,
  },
});

describe('BookmarkService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults; individual tests override as needed.
    mockedBlogRepo.findVisibilityById.mockResolvedValue({ id: 'blog1', authorId: 'author1' } as any);
    mockedBlogService.canView.mockReturnValue(true);
    mockedBookmarkRepo.exists.mockResolvedValue(false);
    mockedBookmarkRepo.countBookmarks.mockResolvedValue(0);
    mockedBookmarkRepo.countBlogBookmarks.mockResolvedValue(0);
  });

  describe('addBookmark', () => {
    it('creates the row and emits BLOG_BOOKMARKED exactly once', async () => {
      mockedBookmarkRepo.bookmark.mockResolvedValue({ created: true });

      await bookmarkService.addBookmark('u1', 'blog1', 'USER');

      expect(mockedBookmarkRepo.bookmark).toHaveBeenCalledWith('u1', 'blog1');
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.BLOG_BOOKMARKED, {
        blogId: 'blog1',
        userId: 'u1',
      });
    });

    it('is idempotent: bookmarking twice does not re-emit but still reports bookmarked', async () => {
      mockedBookmarkRepo.bookmark.mockResolvedValue({ created: false });
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(5);
      mockedBookmarkRepo.countBlogBookmarks.mockResolvedValue(9);

      const result = await bookmarkService.addBookmark('u1', 'blog1', 'USER');

      expect(result).toEqual({
        isBookmarked: true,
        viewerBookmarksCount: 5,
        blogBookmarksCount: 9,
      });
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('trusts the write outcome instead of re-reading with exists', async () => {
      mockedBookmarkRepo.bookmark.mockResolvedValue({ created: true });

      const result = await bookmarkService.addBookmark('u1', 'blog1', 'USER');

      expect(result.isBookmarked).toBe(true);
      // A re-read would cost a round trip and could disagree with the event.
      expect(mockedBookmarkRepo.exists).not.toHaveBeenCalled();
    });

    it('rejects a non-existent blog with 404 BLOG_NOT_FOUND', async () => {
      mockedBlogRepo.findVisibilityById.mockResolvedValue(null);

      await expect(bookmarkService.addBookmark('u1', 'ghost', 'USER')).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'BLOG_NOT_FOUND',
      });
      expect(mockedBookmarkRepo.bookmark).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('rejects a blog the viewer cannot see with 404 — never 403 — so its existence is not leaked', async () => {
      mockedBlogService.canView.mockReturnValue(false);

      await expect(bookmarkService.addBookmark('u1', 'blog1', 'USER')).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'BLOG_NOT_FOUND',
        message: 'Blog not found',
      });
      expect(mockedBookmarkRepo.bookmark).not.toHaveBeenCalled();
    });

    it('delegates the visibility decision to blogService rather than re-implementing it', async () => {
      mockedBookmarkRepo.bookmark.mockResolvedValue({ created: true });

      await bookmarkService.addBookmark('u1', 'blog1', 'ADMIN');

      expect(mockedBlogService.canView).toHaveBeenCalledWith(expect.anything(), {
        userId: 'u1',
        role: 'ADMIN',
      });
    });
  });

  describe('removeBookmark', () => {
    it('emits BLOG_UNBOOKMARKED when a row was removed', async () => {
      mockedBookmarkRepo.unbookmark.mockResolvedValue({ count: 1 });

      await bookmarkService.removeBookmark('u1', 'blog1');

      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.BLOG_UNBOOKMARKED, {
        blogId: 'blog1',
        userId: 'u1',
      });
    });

    it('is idempotent: removing a non-existent bookmark succeeds and emits nothing', async () => {
      mockedBookmarkRepo.unbookmark.mockResolvedValue({ count: 0 });

      await expect(bookmarkService.removeBookmark('u1', 'blog1')).resolves.toBeDefined();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not look the blog up, so a bookmark to a deleted blog can still be cleared', async () => {
      mockedBookmarkRepo.unbookmark.mockResolvedValue({ count: 1 });

      await bookmarkService.removeBookmark('u1', 'blog1');

      expect(mockedBlogRepo.findVisibilityById).not.toHaveBeenCalled();
    });
  });

  describe('toggleBookmark', () => {
    it('emits BLOG_BOOKMARKED exactly once when toggling on', async () => {
      mockedBookmarkRepo.toggleBookmark.mockResolvedValue({
        bookmarked: true,
        changed: true,
      });

      const result = await bookmarkService.toggleBookmark('u1', 'blog1', 'USER');

      expect(result.isBookmarked).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.BLOG_BOOKMARKED, {
        blogId: 'blog1',
        userId: 'u1',
      });
    });

    it('emits BLOG_UNBOOKMARKED exactly once when toggling off', async () => {
      mockedBookmarkRepo.toggleBookmark.mockResolvedValue({
        bookmarked: false,
        changed: true,
      });

      const result = await bookmarkService.toggleBookmark('u1', 'blog1', 'USER');

      expect(result.isBookmarked).toBe(false);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.BLOG_UNBOOKMARKED, {
        blogId: 'blog1',
        userId: 'u1',
      });
    });

    it('emits nothing when a concurrent toggle already made the change', async () => {
      // The losing side of two simultaneous toggles reaches the same end state
      // without mutating anything. Emitting here would double-count a single
      // removal and drift any downstream counter negative.
      mockedBookmarkRepo.toggleBookmark.mockResolvedValue({
        bookmarked: false,
        changed: false,
      });

      const result = await bookmarkService.toggleBookmark('u1', 'blog1', 'USER');

      expect(result.isBookmarked).toBe(false);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('reports the state it emitted, so response and event cannot disagree', async () => {
      mockedBookmarkRepo.toggleBookmark.mockResolvedValue({
        bookmarked: true,
        changed: true,
      });
      // A racing request flipped the row after our write — a re-read would
      // return false and contradict the BLOG_BOOKMARKED we just emitted.
      mockedBookmarkRepo.exists.mockResolvedValue(false);

      const result = await bookmarkService.toggleBookmark('u1', 'blog1', 'USER');

      expect(result.isBookmarked).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.BLOG_BOOKMARKED, expect.anything());
    });

    it('is gated by the same visibility check as add', async () => {
      mockedBlogService.canView.mockReturnValue(false);

      await expect(
        bookmarkService.toggleBookmark('u1', 'blog1', 'USER')
      ).rejects.toMatchObject({ statusCode: 404, errorCode: 'BLOG_NOT_FOUND' });
      expect(mockedBookmarkRepo.toggleBookmark).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('reports the bookmark state alongside both unambiguously named counts', async () => {
      mockedBookmarkRepo.exists.mockResolvedValue(true);
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(42);
      mockedBookmarkRepo.countBlogBookmarks.mockResolvedValue(7);

      expect(await bookmarkService.getStatus('u1', 'blog1', 'USER')).toEqual({
        isBookmarked: true,
        viewerBookmarksCount: 42,
        blogBookmarksCount: 7,
      });
    });

    it('is gated by the same visibility check as the writes', async () => {
      // Otherwise a client would render an enabled bookmark button from a 200
      // here, and the follow-up POST would 404.
      mockedBlogService.canView.mockReturnValue(false);

      await expect(
        bookmarkService.getStatus('u1', 'blog1', 'USER')
      ).rejects.toMatchObject({ statusCode: 404, errorCode: 'BLOG_NOT_FOUND' });
      expect(mockedBookmarkRepo.exists).not.toHaveBeenCalled();
    });

    it('404s for a blog that does not exist at all', async () => {
      mockedBlogRepo.findVisibilityById.mockResolvedValue(null);

      await expect(
        bookmarkService.getStatus('u1', 'ghost', 'USER')
      ).rejects.toMatchObject({ statusCode: 404, errorCode: 'BLOG_NOT_FOUND' });
    });
  });

  describe('getUserBookmarks', () => {
    const query = { limit: 20, sort: 'recent' as const };

    it('returns lightweight blog cards without the blog content', async () => {
      mockedBookmarkRepo.getBookmarks.mockResolvedValue([bookmarkRow('b1')] as any);
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(1);

      const result = await bookmarkService.getUserBookmarks('u1', query, 'USER');

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        bookmarkId: 'b1',
        isAvailable: true,
        blog: {
          title: 'Deep Dive',
          slug: 'deep-dive',
          coverImage: 'https://cdn.test/cover.png',
          readingTimeMinutes: 7,
          author: { username: 'ada' },
        },
      });
    });

    it('derives hasNextPage/nextCursor from the sentinel row', async () => {
      // limit 1 but the repo returns 2 (limit + 1) → there is a next page.
      mockedBookmarkRepo.getBookmarks.mockResolvedValue([
        bookmarkRow('b1'),
        bookmarkRow('b2'),
      ] as any);
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(2);

      const result = await bookmarkService.getUserBookmarks(
        'u1',
        { ...query, limit: 1 },
        'USER'
      );

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(true);
      expect(result.nextCursor).toBe('b1'); // id of the last kept row
      expect(result.totalCount).toBe(2);
    });

    it('nulls the blog and flags isAvailable:false when the viewer can no longer see it', async () => {
      mockedBookmarkRepo.getBookmarks.mockResolvedValue([
        bookmarkRow('b1', { visibility: 'PRIVATE' }),
      ] as any);
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(1);
      mockedBlogService.canView.mockReturnValue(false);

      const result = await bookmarkService.getUserBookmarks('u1', query, 'USER');

      // The row survives so the UI can offer to remove it...
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ bookmarkId: 'b1', isAvailable: false });
      // ...but nothing about the hidden blog leaks.
      expect(result.items[0].blog).toBeNull();
      expect(JSON.stringify(result)).not.toContain('Deep Dive');
      expect(JSON.stringify(result)).not.toContain('deep-dive');
    });

    it('mixes available and unavailable rows in one page', async () => {
      mockedBookmarkRepo.getBookmarks.mockResolvedValue([
        bookmarkRow('b1'),
        bookmarkRow('b2'),
      ] as any);
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(2);
      mockedBlogService.canView.mockReturnValueOnce(true).mockReturnValueOnce(false);

      const result = await bookmarkService.getUserBookmarks('u1', query, 'USER');

      expect(result.items.map((i) => i.isAvailable)).toEqual([true, false]);
      expect(result.items[0].blog).not.toBeNull();
      expect(result.items[1].blog).toBeNull();
    });

    it('counts with the same filters as the page so totalCount cannot contradict it', async () => {
      mockedBookmarkRepo.getBookmarks.mockResolvedValue([]);
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(0);
      const filtered = { ...query, authorId: 'author1', tag: 'rust' };

      await bookmarkService.getUserBookmarks('u1', filtered, 'USER');

      expect(mockedBookmarkRepo.countBookmarks).toHaveBeenCalledWith('u1', filtered);
      expect(mockedBookmarkRepo.getBookmarks).toHaveBeenCalledWith('u1', filtered);
    });

    it('evaluates visibility against the requesting viewer', async () => {
      mockedBookmarkRepo.getBookmarks.mockResolvedValue([bookmarkRow('b1')] as any);
      mockedBookmarkRepo.countBookmarks.mockResolvedValue(1);

      await bookmarkService.getUserBookmarks('u1', query, 'USER');

      expect(mockedBlogService.canView).toHaveBeenCalledWith(expect.anything(), VIEWER);
    });
  });
});
