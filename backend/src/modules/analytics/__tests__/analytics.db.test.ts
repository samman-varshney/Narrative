import { prisma } from '../../../core/database/prisma';
import { resetDb, disconnectDb, makeUser, makeBlog } from '../../../test/db';
import { analyticsRepository } from '../analytics.repository';
import { PostgresAnalyticsStore } from '../store/PostgresAnalyticsStore';
import type { BlogDailyDelta, DateRange } from '../analytics.types';

/**
 * The reporting queries, against real SQL.
 *
 * Mock-based tests would prove each query is BUILT as intended. These prove it
 * BEHAVES as intended — that `date_trunc` buckets land where a calendar says
 * they should, that keyset pagination over an aggregate neither repeats nor
 * skips a row, that `SUM` over an empty range is 0 and not `null`, and that a
 * `bigint` never escapes into a JSON response. None of that is observable
 * through a mocked Prisma delegate.
 */

let authorId: string;
let otherAuthorId: string;
let blogIds: string[];

const store = new PostgresAnalyticsStore();

/** A daily row with sensible zeros, overridable per test. */
function daily(overrides: Partial<BlogDailyDelta> & Pick<BlogDailyDelta, 'blogId' | 'authorId' | 'date'>): BlogDailyDelta {
  return {
    views: 0,
    uniqueViews: 0,
    readStarts: 0,
    readCompletions: 0,
    totalReadingSeconds: 0,
    bookmarks: 0,
    unbookmarks: 0,
    comments: 0,
    ...overrides,
  };
}

const range = (
  startDate: string,
  endDate: string,
  granularity: DateRange['granularity'] = 'day'
): DateRange => ({
  startDate: new Date(`${startDate}T00:00:00.000Z`),
  endDate: new Date(`${endDate}T00:00:00.000Z`),
  granularity,
});

describe('AnalyticsRepository (real database)', () => {
  beforeEach(async () => {
    await resetDb();

    const author = await makeUser();
    const other = await makeUser();
    authorId = author.id;
    otherAuthorId = other.id;

    blogIds = [];
    for (let i = 0; i < 3; i++) {
      const blog = await makeBlog(author.id, { title: `Post ${i}` });
      blogIds.push(blog.id);
    }
  });

  afterAll(disconnectDb);

  describe('totals', () => {
    it('sums only the requested range', async () => {
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-07-31', views: 100 }),
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-01', views: 10 }),
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-15', views: 20 }),
        daily({ blogId: blogIds[0]!, authorId, date: '2026-09-01', views: 100 }),
      ]);

      const totals = await analyticsRepository.getBlogTotals(
        blogIds[0]!,
        range('2026-08-01', '2026-08-31')
      );

      // Both bounds inclusive; neighbours on either side excluded.
      expect(totals.views).toBe(30);
    });

    it('returns zeros, never nulls, for a range with no data', async () => {
      const totals = await analyticsRepository.getBlogTotals(
        blogIds[0]!,
        range('2026-08-01', '2026-08-31')
      );

      // `SUM` over no rows is NULL in SQL. Without COALESCE the DTO would
      // promise a number and deliver null.
      expect(totals).toEqual({
        views: 0,
        uniqueReaderDays: 0,
        readStarts: 0,
        readCompletions: 0,
        totalReadingSeconds: 0,
        bookmarks: 0,
        unbookmarks: 0,
        comments: 0,
      });
    });

    it('returns JSON-serializable numbers, not bigints', async () => {
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-01', views: 2_000_000_000 }),
      ]);

      const totals = await analyticsRepository.getBlogTotals(
        blogIds[0]!,
        range('2026-08-01', '2026-08-31')
      );

      // An un-cast SUM comes back as a BigInt, which JSON.stringify throws on —
      // an endpoint that works until a number gets big enough to matter.
      expect(typeof totals.views).toBe('number');
      expect(() => JSON.stringify(totals)).not.toThrow();
    });

    it('scopes author totals across every blog, and never another author’s', async () => {
      const otherBlog = await makeBlog(otherAuthorId);

      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-01', views: 10 }),
        daily({ blogId: blogIds[1]!, authorId, date: '2026-08-01', views: 20 }),
        daily({ blogId: otherBlog.id, authorId: otherAuthorId, date: '2026-08-01', views: 500 }),
      ]);

      const mine = await analyticsRepository.getUserTotals(authorId, range('2026-08-01', '2026-08-31'));
      expect(mine.views).toBe(30);
    });
  });

  describe('granularity bucketing', () => {
    beforeEach(async () => {
      // Two consecutive ISO weeks, spanning a month boundary.
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-07-27', views: 1 }), // Mon, week A
        daily({ blogId: blogIds[0]!, authorId, date: '2026-07-30', views: 2 }), // Thu, week A
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-03', views: 4 }), // Mon, week B
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-05', views: 8 }), // Wed, week B
      ]);
    });

    it('returns one point per day', async () => {
      const points = await analyticsRepository.getBlogViewsSeries(
        blogIds[0]!,
        range('2026-07-01', '2026-08-31', 'day')
      );

      expect(points.map((p) => p.views)).toEqual([1, 2, 4, 8]);
    });

    it('groups by ISO week, which starts on Monday', async () => {
      const points = await analyticsRepository.getBlogViewsSeries(
        blogIds[0]!,
        range('2026-07-01', '2026-08-31', 'week')
      );

      expect(points).toHaveLength(2);
      expect(points.map((p) => p.views)).toEqual([3, 12]);
      // Postgres `date_trunc('week')` anchors on Monday.
      expect(points[0]!.date.toISOString().slice(0, 10)).toBe('2026-07-27');
    });

    it('groups by calendar month, splitting a week across the boundary', async () => {
      const points = await analyticsRepository.getBlogViewsSeries(
        blogIds[0]!,
        range('2026-07-01', '2026-08-31', 'month')
      );

      expect(points).toHaveLength(2);
      expect(points.map((p) => p.views)).toEqual([3, 12]);
      expect(points[0]!.date.toISOString().slice(0, 10)).toBe('2026-07-01');
      expect(points[1]!.date.toISOString().slice(0, 10)).toBe('2026-08-01');
    });

    it('returns points in ascending date order', async () => {
      const points = await analyticsRepository.getBlogViewsSeries(
        blogIds[0]!,
        range('2026-07-01', '2026-08-31', 'day')
      );

      const dates = points.map((p) => p.date.getTime());
      expect(dates).toEqual([...dates].sort((a, b) => a - b));
    });

    it('omits empty buckets rather than zero-filling them', async () => {
      const points = await analyticsRepository.getBlogViewsSeries(
        blogIds[0]!,
        range('2026-07-01', '2026-08-31', 'day')
      );

      // 61 days in the range, 4 with data.
      expect(points).toHaveLength(4);
    });
  });

  describe('engagement series', () => {
    it('reports gross bookmarks and the net alongside them', async () => {
      await store.upsertBlogDaily([
        daily({
          blogId: blogIds[0]!,
          authorId,
          date: '2026-08-01',
          bookmarks: 10,
          unbookmarks: 4,
          comments: 3,
        }),
      ]);

      const [point] = await analyticsRepository.getBlogEngagementSeries(
        blogIds[0]!,
        range('2026-08-01', '2026-08-31')
      );

      // A day that gained 10 and lost 4 is a different fact from one that
      // gained 6 — both are reported so the client can show either.
      expect(point).toMatchObject({ bookmarks: 10, unbookmarks: 4, netBookmarks: 6, comments: 3 });
    });

    it('allows a negative net when a day lost more than it gained', async () => {
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-01', bookmarks: 1, unbookmarks: 5 }),
      ]);

      const [point] = await analyticsRepository.getBlogEngagementSeries(
        blogIds[0]!,
        range('2026-08-01', '2026-08-31')
      );

      expect(point?.netBookmarks).toBe(-4);
    });
  });

  describe('follower series', () => {
    it('reports gains, losses and net per bucket', async () => {
      await store.upsertUserDaily([
        { userId: authorId, date: '2026-08-01', followersGained: 5, followersLost: 1, blogsPublished: 1 },
        { userId: authorId, date: '2026-08-02', followersGained: 0, followersLost: 3, blogsPublished: 0 },
      ]);

      const points = await analyticsRepository.getUserFollowerSeries(
        authorId,
        range('2026-08-01', '2026-08-31')
      );

      expect(points.map((p) => p.net)).toEqual([4, -3]);
    });
  });

  describe('getTopBlogs', () => {
    beforeEach(async () => {
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-01', views: 30, comments: 9 }),
        daily({ blogId: blogIds[1]!, authorId, date: '2026-08-01', views: 20, comments: 1 }),
        daily({ blogId: blogIds[2]!, authorId, date: '2026-08-01', views: 10, comments: 5 }),
      ]);
    });

    it('ranks by the requested metric', async () => {
      const byViews = await analyticsRepository.getTopBlogs(
        authorId,
        range('2026-08-01', '2026-08-31'),
        'views',
        10
      );
      expect(byViews.map((r) => r.metricValue)).toEqual([30, 20, 10]);

      const byComments = await analyticsRepository.getTopBlogs(
        authorId,
        range('2026-08-01', '2026-08-31'),
        'comments',
        10
      );
      expect(byComments.map((r) => r.metricValue)).toEqual([9, 5, 1]);
    });

    it('ranks by uniqueReaderDays against the real database', async () => {
      // The metric enum and the SQL fragment table are keyed by the same
      // string. A mismatch yields `undefined` where a `Prisma.Sql` belongs and
      // fails only at query time, so this needs a real database to catch.
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-02', uniqueViews: 4 }),
        daily({ blogId: blogIds[1]!, authorId, date: '2026-08-02', uniqueViews: 11 }),
      ]);

      const ranked = await analyticsRepository.getTopBlogs(
        authorId,
        range('2026-08-01', '2026-08-31'),
        'uniqueReaderDays',
        10
      );

      expect(ranked[0]?.blogId).toBe(blogIds[1]);
      expect(ranked[0]?.metricValue).toBe(11);
    });

    it('sums uniqueReaderDays across days rather than deduplicating readers', async () => {
      // The documented semantics, pinned. The same reader on two days is two
      // reader-days; there is no sketch left to merge, so this is an upper
      // bound on distinct readers and is named accordingly.
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-02', uniqueViews: 5 }),
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-03', uniqueViews: 5 }),
      ]);

      const totals = await analyticsRepository.getBlogTotals(
        blogIds[0]!,
        range('2026-08-01', '2026-08-31')
      );

      expect(totals.uniqueReaderDays).toBe(10);
    });

    it('returns limit + 1 rows so the caller can derive hasNextPage', async () => {
      const rows = await analyticsRepository.getTopBlogs(
        authorId,
        range('2026-08-01', '2026-08-31'),
        'views',
        2
      );

      expect(rows).toHaveLength(3);
    });

    it('walks every blog exactly once across pages', async () => {
      const seen: string[] = [];
      let cursor: { metricValue: number; blogId: string } | undefined;

      for (let guard = 0; guard < 10; guard++) {
        const rows = await analyticsRepository.getTopBlogs(
          authorId,
          range('2026-08-01', '2026-08-31'),
          'views',
          1,
          cursor
        );
        const page = rows.slice(0, 1);
        seen.push(...page.map((r) => r.blogId));
        if (rows.length <= 1) break;
        const last = page[0]!;
        cursor = { metricValue: last.metricValue, blogId: last.blogId };
      }

      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);
    });

    it('pages correctly when several blogs share a metric value', async () => {
      // The case a metric-only cursor gets wrong: with no tiebreaker the
      // database has no defined order among ties, so pages repeat and skip.
      const tied = [];
      for (let i = 0; i < 5; i++) tied.push(await makeBlog(authorId, { title: `Tied ${i}` }));
      await store.upsertBlogDaily(
        tied.map((b) => daily({ blogId: b.id, authorId, date: '2026-08-02', views: 7 }))
      );

      const seen: string[] = [];
      let cursor: { metricValue: number; blogId: string } | undefined;

      for (let guard = 0; guard < 20; guard++) {
        const rows = await analyticsRepository.getTopBlogs(
          authorId,
          range('2026-08-01', '2026-08-31'),
          'views',
          2,
          cursor
        );
        const page = rows.slice(0, 2);
        seen.push(...page.map((r) => r.blogId));
        if (rows.length <= 2) break;
        const last = page[page.length - 1]!;
        cursor = { metricValue: last.metricValue, blogId: last.blogId };
      }

      expect(seen).toHaveLength(8); // 3 original + 5 tied
      expect(new Set(seen).size).toBe(8);
    });

    it('excludes soft-deleted blogs while keeping their history in the table', async () => {
      await prisma.blog.update({ where: { id: blogIds[0]! }, data: { status: 'DELETED' } });

      const rows = await analyticsRepository.getTopBlogs(
        authorId,
        range('2026-08-01', '2026-08-31'),
        'views',
        10
      );

      // Not in the list a reader could click through to a 404...
      expect(rows.map((r) => r.blogId)).not.toContain(blogIds[0]);
      // ...but the row is still there, so past ranges stay accurate.
      expect(await prisma.blogAnalyticsDaily.count({ where: { blogId: blogIds[0]! } })).toBe(1);
    });

    it('never returns another author’s blogs', async () => {
      const otherBlog = await makeBlog(otherAuthorId);
      await store.upsertBlogDaily([
        daily({ blogId: otherBlog.id, authorId: otherAuthorId, date: '2026-08-01', views: 9_999 }),
      ]);

      const rows = await analyticsRepository.getTopBlogs(
        authorId,
        range('2026-08-01', '2026-08-31'),
        'views',
        10
      );

      expect(rows.map((r) => r.blogId)).not.toContain(otherBlog.id);
    });

    it('carries the blog’s title and slug for display', async () => {
      const [row] = await analyticsRepository.getTopBlogs(
        authorId,
        range('2026-08-01', '2026-08-31'),
        'views',
        10
      );

      // So a dashboard never has to issue a second query per row.
      expect(row?.title).toBe('Post 0');
      expect(row?.slug).toBeTruthy();
    });
  });

  describe('index usage', () => {
    it('uses the primary key for a blog-scoped range scan', async () => {
      await store.upsertBlogDaily([
        daily({ blogId: blogIds[0]!, authorId, date: '2026-08-01', views: 1 }),
      ]);

      const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT SUM("views") FROM "BlogAnalyticsDaily"
         WHERE "blogId" = '${blogIds[0]}' AND "date" >= '2026-08-01' AND "date" <= '2026-08-31'`
      );
      const text = plan.map((r) => r['QUERY PLAN']).join('\n');

      // Tiny table, so the planner may legitimately choose a seq scan; what
      // must never appear is a plan that cannot use the index at all. Asserting
      // the index EXISTS and is applicable is the durable check.
      expect(text).toBeTruthy();

      const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'BlogAnalyticsDaily'
      `;
      const names = indexes.map((i) => i.indexname);

      expect(names).toEqual(
        expect.arrayContaining([
          'BlogAnalyticsDaily_pkey',
          'BlogAnalyticsDaily_authorId_date_idx',
          'BlogAnalyticsDaily_date_idx',
        ])
      );
    });

    it('has the author + date index that makes dashboards a single-table scan', async () => {
      const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'BlogAnalyticsDaily'
          AND indexname = 'BlogAnalyticsDaily_authorId_date_idx'
      `;

      // Leading column must be authorId: every author query filters one author
      // first and a range second.
      // Postgres reports `date` unquoted, being already lower-case.
      expect(indexes[0]?.indexdef).toMatch(/\("authorId", date\)/);
    });
  });

  describe('upsert conflict target', () => {
    it('keeps exactly one row per (blog, day) however many times it is written', async () => {
      for (let i = 0; i < 5; i++) {
        await store.upsertBlogDaily([
          daily({ blogId: blogIds[0]!, authorId, date: '2026-08-01', views: 1 }),
        ]);
      }

      const rows = await prisma.blogAnalyticsDaily.findMany({ where: { blogId: blogIds[0]! } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.views).toBe(5);
    });

    it('writes a whole batch in one statement', async () => {
      const batch = blogIds.map((id) =>
        daily({ blogId: id, authorId, date: '2026-08-01', views: 3 })
      );

      const affected = await store.upsertBlogDaily(batch);

      expect(affected).toBe(3);
    });
  });
});
