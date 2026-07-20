import { bookmarkRepository } from '../bookmark.repository';
import { prisma } from '../../../core/database/prisma';
import {
  resetDb,
  disconnectDb,
  makeUser,
  makeBlog,
  makeBookmark,
} from '../../../test/db';

/**
 * Real-SQL tests for the bookmark data layer.
 *
 * The mock-based repository suite proves each query is BUILT correctly. These
 * prove they BEHAVE correctly — cursor pagination that neither skips nor
 * repeats a row, the unique constraint under genuinely concurrent writes, and
 * cascade deletes. None of that is observable through a mocked delegate.
 */
describe('BookmarkRepository (real database)', () => {
  let userId: string;
  let blogIds: string[];

  beforeEach(async () => {
    await resetDb();
    const user = await makeUser();
    const author = await makeUser();
    userId = user.id;
    blogIds = [];
    for (let i = 0; i < 5; i++) {
      const blog = await makeBlog(author.id, { title: `Post ${i}` });
      blogIds.push(blog.id);
    }
  });

  afterAll(disconnectDb);

  /** Walks every page and returns the ids seen, in order. */
  async function walkAll(sort: 'recent' | 'oldest', pageSize: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const rows = await bookmarkRepository.getBookmarks(userId, {
        limit: pageSize,
        sort,
        cursor,
      });
      const kept = rows.slice(0, pageSize);
      seen.push(...kept.map((r) => r.id));
      if (rows.length <= pageSize) break;
      cursor = kept[kept.length - 1]!.id;
    }
    return seen;
  }

  describe('cursor pagination', () => {
    beforeEach(async () => {
      // Distinct createdAt values so ordering is unambiguous.
      for (let i = 0; i < blogIds.length; i++) {
        await prisma.bookmark.create({
          data: {
            userId,
            blogId: blogIds[i]!,
            createdAt: new Date(Date.UTC(2026, 0, i + 1)),
          },
        });
      }
    });

    it.each([
      ['recent' as const, 2],
      ['recent' as const, 1],
      ['oldest' as const, 2],
      ['oldest' as const, 1],
    ])('walks every row exactly once (sort=%s, pageSize=%i)', async (sort, pageSize) => {
      const seen = await walkAll(sort, pageSize);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5); // no repeats
    });

    it('orders newest-first for sort=recent and reverses for sort=oldest', async () => {
      const recent = await walkAll('recent', 2);
      const oldest = await walkAll('oldest', 2);

      expect(oldest).toEqual([...recent].reverse());
    });

    it('reports hasNextPage via the sentinel row, not a count query', async () => {
      const rows = await bookmarkRepository.getBookmarks(userId, {
        limit: 4,
        sort: 'recent',
      });
      expect(rows).toHaveLength(5); // limit + 1

      const last = await bookmarkRepository.getBookmarks(userId, {
        limit: 10,
        sort: 'recent',
      });
      expect(last).toHaveLength(5); // no sentinel — final page
    });

    it('survives a cursor whose row was deleted mid-scroll', async () => {
      const first = await bookmarkRepository.getBookmarks(userId, {
        limit: 2,
        sort: 'recent',
      });
      const cursor = first[1]!.id;
      await prisma.bookmark.delete({ where: { id: cursor } });

      // Prisma resolves the cursor row by id; a missing one yields an empty
      // page rather than throwing. Either way it must not 500.
      await expect(
        bookmarkRepository.getBookmarks(userId, { limit: 2, sort: 'recent', cursor })
      ).resolves.toBeInstanceOf(Array);
    });

    it("scopes to the owner — another user's bookmarks are never returned", async () => {
      const stranger = await makeUser();
      await makeBookmark(stranger.id, blogIds[0]!);

      const rows = await bookmarkRepository.getBookmarks(stranger.id, {
        limit: 20,
        sort: 'recent',
      });

      expect(rows).toHaveLength(1);
      expect(rows.every((r) => r.userId === stranger.id)).toBe(true);
    });
  });

  describe('idempotency and concurrency', () => {
    it('bookmarking twice creates exactly one row', async () => {
      const a = await bookmarkRepository.bookmark(userId, blogIds[0]!);
      const b = await bookmarkRepository.bookmark(userId, blogIds[0]!);

      expect(a).toEqual({ created: true });
      expect(b).toEqual({ created: false }); // P2002 swallowed
      expect(await prisma.bookmark.count({ where: { userId } })).toBe(1);
    });

    it('survives a genuine race: 5 concurrent bookmarks yield one row and one winner', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => bookmarkRepository.bookmark(userId, blogIds[0]!))
      );

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await prisma.bookmark.count({ where: { userId } })).toBe(1);
    });

    it('concurrent toggles report exactly one change per actual mutation', async () => {
      await makeBookmark(userId, blogIds[0]!);

      const results = await Promise.all([
        bookmarkRepository.toggleBookmark(userId, blogIds[0]!),
        bookmarkRepository.toggleBookmark(userId, blogIds[0]!),
      ]);

      const rows = await prisma.bookmark.count({ where: { userId } });
      const changes = results.filter((r) => r.changed).length;
      const netRowDelta = rows - 1;
      const netChanges = results.filter((r) => r.changed && r.bookmarked).length -
        results.filter((r) => r.changed && !r.bookmarked).length;

      // The invariant that matters: reported changes must match reality, or
      // downstream event listeners drift.
      expect(netChanges).toBe(netRowDelta);
      expect(changes).toBeGreaterThanOrEqual(1);
    });

    it('removing a non-existent bookmark reports count 0', async () => {
      expect(await bookmarkRepository.unbookmark(userId, blogIds[0]!)).toEqual({ count: 0 });
    });
  });

  describe('filters', () => {
    it('filters by author through the blog relation', async () => {
      const otherAuthor = await makeUser();
      const otherBlog = await makeBlog(otherAuthor.id);
      await makeBookmark(userId, blogIds[0]!);
      await makeBookmark(userId, otherBlog.id);

      const rows = await bookmarkRepository.getBookmarks(userId, {
        limit: 20,
        sort: 'recent',
        authorId: otherAuthor.id,
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.blog.authorId).toBe(otherAuthor.id);
    });

    it('count agrees with the filtered page', async () => {
      const otherAuthor = await makeUser();
      const otherBlog = await makeBlog(otherAuthor.id);
      await makeBookmark(userId, blogIds[0]!);
      await makeBookmark(userId, otherBlog.id);

      const filters = { limit: 20, sort: 'recent' as const, authorId: otherAuthor.id };
      const rows = await bookmarkRepository.getBookmarks(userId, filters);
      const count = await bookmarkRepository.countBookmarks(userId, filters);

      expect(count).toBe(rows.length);
    });
  });

  describe('cascade deletes', () => {
    it('removes bookmarks when the blog is hard-deleted', async () => {
      await makeBookmark(userId, blogIds[0]!);
      await prisma.blog.delete({ where: { id: blogIds[0]! } });

      expect(await prisma.bookmark.count({ where: { userId } })).toBe(0);
    });

    it('removes bookmarks when the user is deleted', async () => {
      await makeBookmark(userId, blogIds[0]!);
      await prisma.user.delete({ where: { id: userId } });

      expect(await prisma.bookmark.count({ where: { blogId: blogIds[0]! } })).toBe(0);
    });
  });
});
