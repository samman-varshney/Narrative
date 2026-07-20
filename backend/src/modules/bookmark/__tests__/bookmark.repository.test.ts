import { Prisma } from '@prisma/client';
import { bookmarkRepository, bookmarkBlogInclude } from '../bookmark.repository';
import { blogCardSelect } from '../../blog/blog.repository';
import { prisma } from '../../../core/database/prisma';

jest.mock('../../../core/database/prisma', () => ({
  prisma: {
    bookmark: {
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

const bookmarkDelegate = (
  prisma as unknown as {
    bookmark: {
      create: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  }
).bookmark;

const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('constraint failed', {
    code,
    clientVersion: 'test',
  });

describe('BookmarkRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('bookmark', () => {
    it('returns { created: true } when a new row is inserted', async () => {
      bookmarkDelegate.create.mockResolvedValue({ id: 'b1' });

      const result = await bookmarkRepository.bookmark('u1', 'blog1');

      expect(bookmarkDelegate.create).toHaveBeenCalledWith({
        data: { userId: 'u1', blogId: 'blog1' },
      });
      expect(result).toEqual({ created: true });
    });

    it('swallows P2002 and returns { created: false } (idempotent)', async () => {
      bookmarkDelegate.create.mockRejectedValue(knownError('P2002'));

      expect(await bookmarkRepository.bookmark('u1', 'blog1')).toEqual({
        created: false,
      });
    });

    it('re-throws non-P2002 errors', async () => {
      bookmarkDelegate.create.mockRejectedValue(new Error('db down'));
      await expect(bookmarkRepository.bookmark('u1', 'blog1')).rejects.toThrow('db down');
    });
  });

  describe('unbookmark', () => {
    it('uses deleteMany and returns the affected count', async () => {
      bookmarkDelegate.deleteMany.mockResolvedValue({ count: 1 });

      const result = await bookmarkRepository.unbookmark('u1', 'blog1');

      expect(bookmarkDelegate.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', blogId: 'blog1' },
      });
      expect(result).toEqual({ count: 1 });
    });

    it('returns count 0 when nothing was bookmarked (idempotent)', async () => {
      bookmarkDelegate.deleteMany.mockResolvedValue({ count: 0 });
      expect(await bookmarkRepository.unbookmark('u1', 'blog1')).toEqual({ count: 0 });
    });
  });

  describe('toggleBookmark', () => {
    it('creates the row and reports it changed', async () => {
      bookmarkDelegate.create.mockResolvedValue({ id: 'b1' });

      expect(await bookmarkRepository.toggleBookmark('u1', 'blog1')).toEqual({
        bookmarked: true,
        changed: true,
      });
      expect(bookmarkDelegate.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes on P2002 and reports it changed', async () => {
      bookmarkDelegate.create.mockRejectedValue(knownError('P2002'));
      bookmarkDelegate.deleteMany.mockResolvedValue({ count: 1 });

      const result = await bookmarkRepository.toggleBookmark('u1', 'blog1');

      expect(bookmarkDelegate.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', blogId: 'blog1' },
      });
      expect(result).toEqual({ bookmarked: false, changed: true });
    });

    it('reports changed:false when a racing toggle already removed the row', async () => {
      // The losing side of two concurrent toggles: create hits the unique
      // constraint, but the delete finds nothing left to remove. It must NOT
      // claim a change, or a single removal would emit two events.
      bookmarkDelegate.create.mockRejectedValue(knownError('P2002'));
      bookmarkDelegate.deleteMany.mockResolvedValue({ count: 0 });

      expect(await bookmarkRepository.toggleBookmark('u1', 'blog1')).toEqual({
        bookmarked: false,
        changed: false,
      });
    });

    it('re-throws an unexpected error from the create leg', async () => {
      bookmarkDelegate.create.mockRejectedValue(new Error('db down'));
      await expect(bookmarkRepository.toggleBookmark('u1', 'blog1')).rejects.toThrow(
        'db down'
      );
    });

    it('re-throws an unexpected error from the delete leg', async () => {
      bookmarkDelegate.create.mockRejectedValue(knownError('P2002'));
      bookmarkDelegate.deleteMany.mockRejectedValue(new Error('db down'));
      await expect(bookmarkRepository.toggleBookmark('u1', 'blog1')).rejects.toThrow(
        'db down'
      );
    });
  });

  describe('blog projection', () => {
    it('reuses blogCardSelect rather than redefining the blog fields', async () => {
      expect(bookmarkBlogInclude.blog.select).toBe(blogCardSelect);
    });

    it('never selects the heavy content JSON', async () => {
      // This — not the absence of `content` on the mapped DTO — is the invariant
      // that keeps a library page cheap for a user with thousands of bookmarks.
      expect(bookmarkBlogInclude.blog.select).not.toHaveProperty('content');
    });

    it('joins the blog card in the same query as the page (no N+1)', async () => {
      bookmarkDelegate.findMany.mockResolvedValue([]);

      await bookmarkRepository.getBookmarks('u1', { limit: 20, sort: 'recent' });

      expect(bookmarkDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: bookmarkBlogInclude })
      );
    });
  });

  describe('countBlogBookmarks', () => {
    it('counts every user who bookmarked the blog', async () => {
      bookmarkDelegate.count.mockResolvedValue(12);

      expect(await bookmarkRepository.countBlogBookmarks('blog1')).toBe(12);
      expect(bookmarkDelegate.count).toHaveBeenCalledWith({
        where: { blogId: 'blog1' },
      });
    });
  });

  describe('exists', () => {
    it('queries the composite unique key in [blogId, userId] order', async () => {
      bookmarkDelegate.findUnique.mockResolvedValue({ id: 'b1' });

      const result = await bookmarkRepository.exists('u1', 'blog1');

      expect(bookmarkDelegate.findUnique).toHaveBeenCalledWith({
        where: { blogId_userId: { blogId: 'blog1', userId: 'u1' } },
        select: { id: true },
      });
      expect(result).toBe(true);
    });

    it('returns false when no row is found', async () => {
      bookmarkDelegate.findUnique.mockResolvedValue(null);
      expect(await bookmarkRepository.exists('u1', 'blog1')).toBe(false);
    });
  });

  describe('getBookmarks (cursor pagination)', () => {
    it('fetches limit+1 rows newest-first without a cursor', async () => {
      bookmarkDelegate.findMany.mockResolvedValue([]);

      await bookmarkRepository.getBookmarks('u1', { limit: 20, sort: 'recent' });

      expect(bookmarkDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        })
      );
      const arg = bookmarkDelegate.findMany.mock.calls[0][0];
      expect(arg).not.toHaveProperty('cursor');
      expect(arg).not.toHaveProperty('skip');
    });

    it('flips ordering to ascending for sort=oldest', async () => {
      bookmarkDelegate.findMany.mockResolvedValue([]);

      await bookmarkRepository.getBookmarks('u1', { limit: 20, sort: 'oldest' });

      expect(bookmarkDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      );
    });

    it('adds cursor + skip:1 when a cursor is supplied', async () => {
      bookmarkDelegate.findMany.mockResolvedValue([]);

      await bookmarkRepository.getBookmarks('u1', {
        cursor: 'b10',
        limit: 5,
        sort: 'recent',
      });

      expect(bookmarkDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 6, cursor: { id: 'b10' }, skip: 1 })
      );
    });
  });

  describe('filters', () => {
    it('nests authorId and tag under the blog relation', async () => {
      bookmarkDelegate.findMany.mockResolvedValue([]);

      await bookmarkRepository.getBookmarks('u1', {
        limit: 20,
        sort: 'recent',
        authorId: 'author1',
        tag: 'rust',
      });

      expect(bookmarkDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'u1',
            blog: { authorId: 'author1', tags: { some: { tag: { slug: 'rust' } } } },
          },
        })
      );
    });

    it('builds an identical where for the list and the count', async () => {
      bookmarkDelegate.findMany.mockResolvedValue([]);
      bookmarkDelegate.count.mockResolvedValue(0);
      const query = {
        limit: 20,
        sort: 'recent' as const,
        authorId: 'author1',
        tag: 'rust',
      };

      await bookmarkRepository.getBookmarks('u1', query);
      await bookmarkRepository.countBookmarks('u1', query);

      // totalCount must describe exactly the set being paged.
      expect(bookmarkDelegate.count.mock.calls[0][0].where).toEqual(
        bookmarkDelegate.findMany.mock.calls[0][0].where
      );
    });

    it('omits the blog filter entirely when no filters are supplied', async () => {
      bookmarkDelegate.count.mockResolvedValue(7);

      expect(await bookmarkRepository.countBookmarks('u1')).toBe(7);
      expect(bookmarkDelegate.count).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });
  });

  describe('getBookmarkedSubset', () => {
    it('short-circuits without a query for an empty id list', async () => {
      expect(await bookmarkRepository.getBookmarkedSubset('u1', [])).toEqual(new Set());
      expect(bookmarkDelegate.findMany).not.toHaveBeenCalled();
    });

    it('returns the bookmarked ids as a Set', async () => {
      bookmarkDelegate.findMany.mockResolvedValue([{ blogId: 'a' }, { blogId: 'c' }]);

      const result = await bookmarkRepository.getBookmarkedSubset('u1', ['a', 'b', 'c']);

      expect(bookmarkDelegate.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', blogId: { in: ['a', 'b', 'c'] } },
        select: { blogId: true },
      });
      expect(result).toEqual(new Set(['a', 'c']));
    });
  });
});
