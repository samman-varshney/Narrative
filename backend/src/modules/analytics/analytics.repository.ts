import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import { dateKey } from './analytics.time';
import type { DateRange, Granularity, TopBlogsMetric } from './analytics.types';

/**
 * The analytics READ layer. Every reporting query in the module lives here.
 *
 * Separate from `IAnalyticsStore` (the write side) because the two have opposite
 * shapes: the store takes batches from a worker and cares about throughput and
 * lock duration; this takes a date range from an HTTP request and cares about
 * selectivity and index use. See `IAnalyticsStore` for the full reasoning.
 *
 * ── Why raw SQL ─────────────────────────────────────────────────────────────
 * Every query here is a grouped aggregate over a date range, and two of the
 * things they need are outside Prisma's aggregate API entirely: `date_trunc`
 * bucketing (there is no `groupBy` on a computed expression) and keyset
 * pagination over an aggregate value. Expressing them through Prisma would mean
 * fetching daily rows and folding them in Node — moving the aggregation off the
 * database and onto the web process, over the wire, for every dashboard load.
 *
 * Every value is BOUND, never interpolated. The one exception is the ranking
 * column in `getTopBlogs`, which is looked up in a fixed table from a Zod-parsed
 * enum and can only ever be one of five constants in this file.
 *
 * ── Index coverage ──────────────────────────────────────────────────────────
 * Blog-scoped queries walk `BlogAnalyticsDaily_pkey` (blogId, date). Author
 * queries walk `@@index([authorId, date])`. Both are range scans over a
 * contiguous key prefix, which is why the leading column is the entity and not
 * the date. See ANALYTICS_MODULE.md § "Database indexes" for the EXPLAIN output.
 */

/**
 * Bucket expression shared by every time series.
 *
 * `date_trunc` handles all three granularities uniformly — for `day` it is a
 * no-op on a DATE column — so there is one code path instead of a special case
 * that only the least-used granularity exercises. `::date` back-casts the
 * timestamp `date_trunc` returns so buckets serialize as plain calendar days.
 */
function bucketExpression(granularity: Granularity): Prisma.Sql {
  return Prisma.sql`date_trunc(${granularity}::text, "date")::date`;
}

/**
 * Time-series rows as the DATABASE returns them.
 *
 * Deliberately NOT the `*Point` DTOs from analytics.types: `date_trunc` returns
 * a timestamp, so the driver hands back a `Date` here while the wire contract
 * promises a `YYYY-MM-DD` string. Declaring the DTO type on these methods would
 * be a type-level lie that only surfaces as a full ISO timestamp appearing in an
 * API response. The service converts, once, in its DTO mapping.
 */
export interface ViewsRow {
  date: Date;
  views: number;
  /**
   * Sum of per-day unique readers over the bucket. Equals the exact unique
   * reader count only when the bucket IS one day — see `analytics.types` §
   * `uniqueReaderDays` for why the two cannot be the same field.
   */
  uniqueReaderDays: number;
}

export interface EngagementRow {
  date: Date;
  bookmarks: number;
  unbookmarks: number;
  netBookmarks: number;
  comments: number;
}

export interface FollowerRow {
  date: Date;
  gained: number;
  lost: number;
  net: number;
}

/** Aggregate totals for one blog (or one author) over a range. */
export interface AnalyticsTotals {
  views: number;
  /** Sum of per-day unique readers across the range. Not period-uniques. */
  uniqueReaderDays: number;
  readStarts: number;
  readCompletions: number;
  totalReadingSeconds: number;
  bookmarks: number;
  unbookmarks: number;
  comments: number;
}

export interface FollowerTotals {
  followersGained: number;
  followersLost: number;
  blogsPublished: number;
}

/** One row of `getTopBlogs`, before DTO mapping. */
export interface TopBlogRow {
  blogId: string;
  title: string;
  slug: string;
  publishedAt: Date | null;
  views: number;
  uniqueReaderDays: number;
  netBookmarks: number;
  comments: number;
  readCompletions: number;
  metricValue: number;
}

/**
 * Ranking columns for `getTopBlogs`, as SQL fragments.
 *
 * A fixed table, keyed by an enum Zod has already validated. The values are
 * literals written here, so no caller-supplied string can reach the query even
 * if validation upstream were removed.
 */
const TOP_BLOG_METRICS: Record<TopBlogsMetric, Prisma.Sql> = {
  views: Prisma.sql`COALESCE(SUM("views"), 0)::int`,
  uniqueReaderDays: Prisma.sql`COALESCE(SUM("uniqueViews"), 0)::int`,
  bookmarks: Prisma.sql`(COALESCE(SUM("bookmarks"), 0) - COALESCE(SUM("unbookmarks"), 0))::int`,
  comments: Prisma.sql`COALESCE(SUM("comments"), 0)::int`,
  readCompletions: Prisma.sql`COALESCE(SUM("readCompletions"), 0)::int`,
};

/**
 * Every aggregate is `COALESCE`d and cast to `int` IN SQL.
 *
 * Two reasons, both of which bite silently. `SUM` over no rows is NULL, not 0 —
 * an author with no traffic would otherwise produce `null` where the DTO
 * promises a number. And `SUM` of an integer column returns `bigint`, which the
 * driver hands back as a JS `BigInt` that `JSON.stringify` refuses to serialize:
 * the endpoint would throw only once a number was large enough to matter, or
 * only on the aggregate paths, depending on the driver.
 */
const TOTALS_COLUMNS = Prisma.sql`
  COALESCE(SUM("views"), 0)::int               AS "views",
  COALESCE(SUM("uniqueViews"), 0)::int         AS "uniqueReaderDays",
  COALESCE(SUM("readStarts"), 0)::int          AS "readStarts",
  COALESCE(SUM("readCompletions"), 0)::int     AS "readCompletions",
  COALESCE(SUM("totalReadingSeconds"), 0)::int AS "totalReadingSeconds",
  COALESCE(SUM("bookmarks"), 0)::int           AS "bookmarks",
  COALESCE(SUM("unbookmarks"), 0)::int         AS "unbookmarks",
  COALESCE(SUM("comments"), 0)::int            AS "comments"
`;

const EMPTY_TOTALS: AnalyticsTotals = {
  views: 0,
  uniqueReaderDays: 0,
  readStarts: 0,
  readCompletions: 0,
  totalReadingSeconds: 0,
  bookmarks: 0,
  unbookmarks: 0,
  comments: 0,
};

export class AnalyticsRepository {
  // ---- Blog scope --------------------------------------------------------

  /** Totals for one blog across a range. */
  async getBlogTotals(blogId: string, range: DateRange): Promise<AnalyticsTotals> {
    const rows = await prisma.$queryRaw<AnalyticsTotals[]>`
      SELECT ${TOTALS_COLUMNS}
      FROM "BlogAnalyticsDaily"
      WHERE "blogId" = ${blogId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
    `;
    return rows[0] ?? EMPTY_TOTALS;
  }

  /**
   * Views time series for one blog.
   *
   * Buckets with no data are ABSENT, not zero-filled. Gap filling is the
   * service's job (and a `generate_series` LEFT JOIN here would cost a scan the
   * caller may not want) — but more importantly, "no row" and "zero" are the
   * same fact for a counter, so filling is presentation, not retrieval.
   */
  getBlogViewsSeries(blogId: string, range: DateRange): Promise<ViewsRow[]> {
    return prisma.$queryRaw<ViewsRow[]>`
      SELECT ${bucketExpression(range.granularity)}      AS "date",
             COALESCE(SUM("views"), 0)::int              AS "views",
             COALESCE(SUM("uniqueViews"), 0)::int        AS "uniqueReaderDays"
      FROM "BlogAnalyticsDaily"
      WHERE "blogId" = ${blogId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
      GROUP BY 1
      ORDER BY 1 ASC
    `;
  }

  getBlogEngagementSeries(blogId: string, range: DateRange): Promise<EngagementRow[]> {
    return prisma.$queryRaw<EngagementRow[]>`
      SELECT ${bucketExpression(range.granularity)}                  AS "date",
             COALESCE(SUM("bookmarks"), 0)::int                      AS "bookmarks",
             COALESCE(SUM("unbookmarks"), 0)::int                    AS "unbookmarks",
             (COALESCE(SUM("bookmarks"), 0)
              - COALESCE(SUM("unbookmarks"), 0))::int                AS "netBookmarks",
             COALESCE(SUM("comments"), 0)::int                       AS "comments"
      FROM "BlogAnalyticsDaily"
      WHERE "blogId" = ${blogId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
      GROUP BY 1
      ORDER BY 1 ASC
    `;
  }

  // ---- Author scope ------------------------------------------------------

  /**
   * Totals across every blog by one author.
   *
   * Reads `BlogAnalyticsDaily` alone — no join to `Blog` — which is the entire
   * reason `authorId` is denormalized onto the aggregate table. A join would put
   * the author filter on the far side of a nested loop over every daily row in
   * the range.
   */
  async getUserTotals(authorId: string, range: DateRange): Promise<AnalyticsTotals> {
    const rows = await prisma.$queryRaw<AnalyticsTotals[]>`
      SELECT ${TOTALS_COLUMNS}
      FROM "BlogAnalyticsDaily"
      WHERE "authorId" = ${authorId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
    `;
    return rows[0] ?? EMPTY_TOTALS;
  }

  getUserViewsSeries(authorId: string, range: DateRange): Promise<ViewsRow[]> {
    return prisma.$queryRaw<ViewsRow[]>`
      SELECT ${bucketExpression(range.granularity)}      AS "date",
             COALESCE(SUM("views"), 0)::int              AS "views",
             COALESCE(SUM("uniqueViews"), 0)::int        AS "uniqueReaderDays"
      FROM "BlogAnalyticsDaily"
      WHERE "authorId" = ${authorId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
      GROUP BY 1
      ORDER BY 1 ASC
    `;
  }

  getUserEngagementSeries(authorId: string, range: DateRange): Promise<EngagementRow[]> {
    return prisma.$queryRaw<EngagementRow[]>`
      SELECT ${bucketExpression(range.granularity)}                  AS "date",
             COALESCE(SUM("bookmarks"), 0)::int                      AS "bookmarks",
             COALESCE(SUM("unbookmarks"), 0)::int                    AS "unbookmarks",
             (COALESCE(SUM("bookmarks"), 0)
              - COALESCE(SUM("unbookmarks"), 0))::int                AS "netBookmarks",
             COALESCE(SUM("comments"), 0)::int                       AS "comments"
      FROM "BlogAnalyticsDaily"
      WHERE "authorId" = ${authorId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
      GROUP BY 1
      ORDER BY 1 ASC
    `;
  }

  // ---- User scope (non-blog metrics) -------------------------------------

  async getUserFollowerTotals(userId: string, range: DateRange): Promise<FollowerTotals> {
    const rows = await prisma.$queryRaw<FollowerTotals[]>`
      SELECT COALESCE(SUM("followersGained"), 0)::int AS "followersGained",
             COALESCE(SUM("followersLost"), 0)::int   AS "followersLost",
             COALESCE(SUM("blogsPublished"), 0)::int  AS "blogsPublished"
      FROM "UserAnalyticsDaily"
      WHERE "userId" = ${userId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
    `;
    return rows[0] ?? { followersGained: 0, followersLost: 0, blogsPublished: 0 };
  }

  getUserFollowerSeries(userId: string, range: DateRange): Promise<FollowerRow[]> {
    return prisma.$queryRaw<FollowerRow[]>`
      SELECT ${bucketExpression(range.granularity)}          AS "date",
             COALESCE(SUM("followersGained"), 0)::int        AS "gained",
             COALESCE(SUM("followersLost"), 0)::int          AS "lost",
             (COALESCE(SUM("followersGained"), 0)
              - COALESCE(SUM("followersLost"), 0))::int      AS "net"
      FROM "UserAnalyticsDaily"
      WHERE "userId" = ${userId}
        AND "date" >= ${dateKey(range.startDate)}::date
        AND "date" <= ${dateKey(range.endDate)}::date
      GROUP BY 1
      ORDER BY 1 ASC
    `;
  }

  // ---- Top blogs ---------------------------------------------------------

  /**
   * An author's best-performing blogs over a range, ranked by one metric.
   *
   * Cursor-paginated, unlike the time series — this is the one analytics
   * endpoint whose result size grows with the data rather than with the range,
   * so a prolific author's list genuinely needs paging.
   *
   * The cursor is KEYSET over `(metricValue, blogId)`, both descending. The
   * blogId tiebreaker is what makes it correct: dozens of blogs can share a
   * metric value (zero views is common), and ranking on the metric alone would
   * give the database no defined order among them — pages would repeat and skip
   * rows arbitrarily. Postgres's row comparison `(a, b) < (c, d)` expresses the
   * composite boundary directly.
   *
   * Fetches `limit + 1` rows so the caller can derive `hasNextPage` without a
   * second count query, matching `core/utils/pagination`.
   */
  getTopBlogs(
    authorId: string,
    range: DateRange,
    metric: TopBlogsMetric,
    limit: number,
    cursor?: { metricValue: number; blogId: string }
  ): Promise<TopBlogRow[]> {
    const metricExpression = TOP_BLOG_METRICS[metric];

    // Collapses to nothing on the first page. `Prisma.empty` rather than a
    // `1=1` placeholder, so the planner sees the simpler query. The explicit
    // `::int` cast pins the comparison's type instead of leaving Postgres to
    // infer it from an untyped parameter.
    const keyset = cursor
      ? Prisma.sql`AND (t."metricValue", t."blogId") < (${cursor.metricValue}::int, ${cursor.blogId})`
      : Prisma.empty;

    return prisma.$queryRaw<TopBlogRow[]>`
      WITH totals AS (
        SELECT "blogId",
               ${metricExpression}                                AS "metricValue",
               COALESCE(SUM("views"), 0)::int                     AS "views",
               COALESCE(SUM("uniqueViews"), 0)::int               AS "uniqueReaderDays",
               (COALESCE(SUM("bookmarks"), 0)
                - COALESCE(SUM("unbookmarks"), 0))::int           AS "netBookmarks",
               COALESCE(SUM("comments"), 0)::int                  AS "comments",
               COALESCE(SUM("readCompletions"), 0)::int           AS "readCompletions"
        FROM "BlogAnalyticsDaily"
        WHERE "authorId" = ${authorId}
          AND "date" >= ${dateKey(range.startDate)}::date
          AND "date" <= ${dateKey(range.endDate)}::date
        GROUP BY "blogId"
      )
      SELECT t."blogId",
             b."title",
             b."slug",
             b."publishedAt",
             t."views",
             t."uniqueReaderDays",
             t."netBookmarks",
             t."comments",
             t."readCompletions",
             t."metricValue"
      FROM totals t
      JOIN "Blog" b ON b."id" = t."blogId"
      -- A soft-deleted blog keeps its history in the aggregate table (so past
      -- ranges stay accurate) but must not appear in a "top blogs" list the
      -- author would click through to a 404.
      WHERE b."status" <> 'DELETED'
      ${keyset}
      ORDER BY t."metricValue" DESC, t."blogId" DESC
      LIMIT ${limit + 1}
    `;
  }
}

export const analyticsRepository = new AnalyticsRepository();
