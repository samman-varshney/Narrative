import { prisma } from '../../../core/database/prisma';
import { blogRepository } from '../../blog/blog.repository';
import { commentRepository } from '../../comment/comment.repository';
import { disconnectDb, makeBlog, makeUser, resetDb } from '../../../test/db';
import { bucketLabels, formatLabel, truncateToBucket } from '../dashboard.series';
import type { DashboardGranularity, DashboardRangeDTO } from '../dashboard.types';

/**
 * The dashboard's reads, against real SQL.
 *
 * Mock-based tests prove a query was BUILT as intended; only these prove it
 * BEHAVES as intended. Three things here are invisible to a mocked Prisma
 * delegate and are exactly where this module could be wrong:
 *
 *   1. the ownership and visibility filters on comments received — a leak here
 *      shows another author's readers to the wrong person;
 *   2. the ordering each panel depends on, which is a property of the query
 *      plan and not of the code that calls it;
 *   3. the agreement between this module's JavaScript bucket labels and
 *      Postgres's `date_trunc`. If those ever disagree, gap filling silently
 *      doubles points instead of filling holes, and no unit test on either side
 *      can see it.
 */

const DAY = 86_400_000;

beforeAll(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// Comments received
// ---------------------------------------------------------------------------

describe('commentRepository.findReceivedByAuthor', () => {
  let author: { id: string };
  let reader: { id: string };
  let stranger: { id: string };
  let myBlog: { id: string };

  beforeAll(async () => {
    await resetDb();

    author = await makeUser({ username: 'db-author' });
    reader = await makeUser({ username: 'db-reader' });
    stranger = await makeUser({ username: 'db-stranger' });

    myBlog = await makeBlog(author.id, { title: 'Mine', slug: 'mine' });
    const theirBlog = await makeBlog(stranger.id, { title: 'Theirs', slug: 'theirs' });

    const now = Date.now();
    const comment = (data: {
      blogId: string;
      authorId: string;
      content: string;
      minutesAgo: number;
      deletedAt?: Date;
      isHidden?: boolean;
      parentId?: string;
    }) =>
      prisma.comment.create({
        data: {
          blogId: data.blogId,
          authorId: data.authorId,
          content: data.content,
          path: '',
          createdAt: new Date(now - data.minutesAgo * 60_000),
          ...(data.deletedAt && { deletedAt: data.deletedAt }),
          ...(data.isHidden && { isHidden: data.isHidden }),
          ...(data.parentId && { parentId: data.parentId, depth: 1 }),
        },
      });

    const root = await comment({
      blogId: myBlog.id,
      authorId: reader.id,
      content: 'visible root',
      minutesAgo: 10,
    });
    await comment({
      blogId: myBlog.id,
      authorId: reader.id,
      content: 'visible reply',
      minutesAgo: 5,
      parentId: root.id,
    });
    await comment({
      blogId: myBlog.id,
      authorId: author.id,
      content: 'my own reply',
      minutesAgo: 4,
    });
    await comment({
      blogId: myBlog.id,
      authorId: reader.id,
      content: 'deleted',
      minutesAgo: 3,
      deletedAt: new Date(),
    });
    await comment({
      blogId: myBlog.id,
      authorId: reader.id,
      content: 'hidden',
      minutesAgo: 2,
      isHidden: true,
    });
    await comment({
      blogId: theirBlog.id,
      authorId: reader.id,
      content: 'on someone else blog',
      minutesAgo: 1,
    });
    await comment({
      blogId: myBlog.id,
      authorId: reader.id,
      content: 'too old',
      minutesAgo: 60 * 24 * 200,
    });
  });

  const received = (authorId: string, limit = 50, sinceDaysAgo = 90) =>
    commentRepository.findReceivedByAuthor(authorId, {
      limit,
      since: new Date(Date.now() - sinceDaysAgo * DAY),
    });

  it('returns comments other people left on the author\'s blogs', async () => {
    const rows = await received(author.id);
    const contents = rows.map((row) => row.content);

    expect(contents).toContain('visible root');
    // Replies count too: a reply on the author's post is audience engagement,
    // whatever its position in the thread.
    expect(contents).toContain('visible reply');
  });

  it('excludes the author\'s own comments', async () => {
    const rows = await received(author.id);
    // Answering your own thread is participation, not audience activity — the
    // same line the analytics `comments` counter draws.
    expect(rows.map((row) => row.content)).not.toContain('my own reply');
    expect(rows.every((row) => row.authorId !== author.id)).toBe(true);
  });

  it('excludes deleted and hidden comments', async () => {
    const contents = (await received(author.id)).map((row) => row.content);
    // A thread renders tombstones so replies stay attached; a flat activity
    // list has nothing to keep attached and would just show a moderator's work.
    expect(contents).not.toContain('deleted');
    expect(contents).not.toContain('hidden');
  });

  it('never returns comments from another author\'s blogs', async () => {
    const rows = await received(author.id);
    expect(rows.every((row) => row.blog.id === myBlog.id)).toBe(true);
    expect(rows.map((row) => row.content)).not.toContain('on someone else blog');
  });

  it('is scoped per author — a stranger sees only their own', async () => {
    const rows = await received(stranger.id);
    expect(rows.map((row) => row.content)).toEqual(['on someone else blog']);
  });

  it('respects the lookback window', async () => {
    const contents = (await received(author.id)).map((row) => row.content);
    expect(contents).not.toContain('too old');

    const wider = (await received(author.id, 50, 365)).map((row) => row.content);
    expect(wider).toContain('too old');
  });

  it('returns newest first and honours the limit', async () => {
    const rows = await received(author.id, 2);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe('visible reply'); // 5 minutes ago
    expect(rows[1]!.content).toBe('visible root'); // 10 minutes ago
  });

  it('carries the blog and the commenter in the same query', async () => {
    const [row] = await received(author.id, 1);

    // No N+1: a list that renders "Bob commented on <post>" must not need a
    // lookup per row.
    expect(row!.blog).toMatchObject({ id: myBlog.id, title: 'Mine', slug: 'mine' });
    expect(row!.author).toMatchObject({ id: reader.id, username: 'db-reader' });
  });

  it('returns nothing for an author with no blogs', async () => {
    const lonely = await makeUser({ username: 'db-lonely' });
    expect(await received(lonely.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Content panels
// ---------------------------------------------------------------------------

describe('blogRepository.listByAuthor', () => {
  let author: { id: string };
  let other: { id: string };

  beforeAll(async () => {
    await resetDb();
    author = await makeUser({ username: 'panel-author' });
    other = await makeUser({ username: 'panel-other' });

    const base = Date.now();

    // Published out of creation order, so an `order: 'published'` bug cannot
    // pass by accidentally agreeing with `createdAt`.
    await makeBlog(author.id, {
      title: 'Published old',
      slug: 'pub-old',
      publishedAt: new Date(base - 10 * DAY),
    });
    await makeBlog(author.id, {
      title: 'Published new',
      slug: 'pub-new',
      publishedAt: new Date(base - 1 * DAY),
    });
    await makeBlog(author.id, {
      title: 'Archived',
      slug: 'arch',
      status: 'ARCHIVED',
    });
    await makeBlog(author.id, { title: 'Draft A', slug: 'draft-a', status: 'DRAFT' });
    await makeBlog(author.id, { title: 'Draft B', slug: 'draft-b', status: 'DRAFT' });
    await makeBlog(other.id, {
      title: 'Not mine',
      slug: 'not-mine',
      publishedAt: new Date(base),
    });

    // `updatedAt` is `@updatedAt`, so it can only be moved by an actual write.
    const draftA = await prisma.blog.findUnique({ where: { slug: 'draft-a' } });
    await prisma.blog.update({
      where: { id: draftA!.id },
      data: { subtitle: 'touched' },
    });
  });

  it('orders published content by publication date', async () => {
    const rows = await blogRepository.listByAuthor(author.id, 10, {
      statuses: ['PUBLISHED'],
      order: 'published',
    });

    expect(rows.map((row) => row.title)).toEqual(['Published new', 'Published old']);
  });

  it('orders drafts by last edit, not by creation', async () => {
    const rows = await blogRepository.listByAuthor(author.id, 10, {
      statuses: ['DRAFT'],
      order: 'updated',
    });

    // Draft A was created FIRST and edited LAST — the case that separates the
    // two orderings, and the one a writer means by "recent".
    expect(rows[0]!.title).toBe('Draft A');
  });

  it('filters by status', async () => {
    const drafts = await blogRepository.listByAuthor(author.id, 10, {
      statuses: ['DRAFT'],
      order: 'updated',
    });
    expect(drafts.every((row) => row.status === 'DRAFT')).toBe(true);
  });

  it('never returns another author\'s blogs', async () => {
    const rows = await blogRepository.listByAuthor(author.id, 50, {
      statuses: ['PUBLISHED', 'DRAFT', 'ARCHIVED'],
      order: 'created',
    });
    expect(rows.map((row) => row.title)).not.toContain('Not mine');
  });

  it('honours the limit', async () => {
    const rows = await blogRepository.listByAuthor(author.id, 1, {
      statuses: ['PUBLISHED'],
      order: 'published',
    });
    expect(rows).toHaveLength(1);
  });

  it('omits the content JSON from panel rows', async () => {
    const [row] = await blogRepository.listByAuthor(author.id, 1, {
      statuses: ['PUBLISHED'],
      order: 'published',
    });
    // A dashboard that loaded eight blog bodies to show eight titles would be
    // the most expensive page on the platform.
    expect(row).not.toHaveProperty('content');
  });
});

describe('blogRepository.findCardsByIds', () => {
  it('returns only blogs the given author owns', async () => {
    await resetDb();
    const author = await makeUser({ username: 'cards-author' });
    const other = await makeUser({ username: 'cards-other' });
    const mine = await makeBlog(author.id, { slug: 'cards-mine' });
    const theirs = await makeBlog(other.id, { slug: 'cards-theirs' });

    const rows = await blogRepository.findCardsByIds(author.id, [mine.id, theirs.id]);

    // Ownership is part of the filter, not an assumption about the caller's
    // ids: an id the caller does not own returns nothing rather than someone
    // else's blog.
    expect(rows.map((row) => row.id)).toEqual([mine.id]);
  });

  it('short-circuits on an empty id list', async () => {
    const author = await makeUser({ username: 'cards-empty' });
    expect(await blogRepository.findCardsByIds(author.id, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bucket alignment
// ---------------------------------------------------------------------------

describe('bucket labels agree with Postgres date_trunc', () => {
  /**
   * The single most important test in this file.
   *
   * Gap filling invents bucket labels in JavaScript and matches them against
   * labels Postgres produced with `date_trunc`. If the two ever disagree — a
   * Sunday-based week, a timezone slip, a month boundary — the filled label
   * does not replace the real point, it sits NEXT to it, and the chart shows
   * two entries for one week. Neither side's unit tests can see that; only
   * comparing them can.
   */
  const dates = [
    '2026-01-01', // a Thursday, new year
    '2026-08-16', // a Sunday — the case JS gets wrong, since it numbers Sunday 0
    '2026-08-17', // a Monday — a bucket start
    '2026-08-20', // a Thursday, mid-week and mid-month
    '2026-08-31', // month end
    '2028-02-29', // a leap day
    '2025-12-31', // year end
  ];

  it.each(['day', 'week', 'month'] as DashboardGranularity[])(
    'matches for granularity=%s',
    async (granularity) => {
      const rows = await prisma.$queryRawUnsafe<{ input: Date; bucket: Date }[]>(
        `SELECT d::date AS "input", date_trunc('${granularity}', d)::date AS "bucket"
         FROM unnest($1::date[]) AS d`,
        dates
      );

      expect(rows).toHaveLength(dates.length);

      for (const row of rows) {
        const ours = formatLabel(
          truncateToBucket(new Date(row.input), granularity)
        );
        expect(ours).toBe(formatLabel(new Date(row.bucket)));
      }
    }
  );

  it('produces exactly the labels a real weekly series would return', async () => {
    const range: DashboardRangeDTO = {
      preset: '90d',
      startDate: '2026-06-15',
      endDate: '2026-08-20',
      granularity: 'week',
    };

    const rows = await prisma.$queryRawUnsafe<{ bucket: Date }[]>(
      `SELECT DISTINCT date_trunc('week', d)::date AS "bucket"
       FROM generate_series($1::date, $2::date, '1 day') AS d
       ORDER BY 1`,
      range.startDate,
      range.endDate
    );

    const fromPostgres = rows.map((row) => formatLabel(new Date(row.bucket)));
    expect(bucketLabels(range)).toEqual(fromPostgres);
  });
});
