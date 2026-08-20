import { AppError } from '../../core/exceptions/AppError';
import { logger } from '../../core/utils/logger';
import { blogService } from '../blog/blog.service';
import { followRepository } from '../follow/follow.repository';
import {
  AnalyticsRepository,
  analyticsRepository,
  type AnalyticsTotals,
  type EngagementRow,
  type FollowerRow,
  type TopBlogRow,
  type ViewsRow,
} from './analytics.repository';
import { currentGeneration, withReportCache } from './analytics.cache';
import { resolveDateRange, resolveTotalsRange } from './analytics.range';
import { decodeTopBlogsCursor, encodeTopBlogsCursor, topBlogsFingerprint } from './analytics.cursor';
import {
  bucketsAreSingleDays,
  dateKey,
  rangeIsSingleDay,
  reportingDaysAgo,
  startOfReportingDay,
} from './analytics.time';
import type {
  AnalyticsEvent,
  BlogEngagementRow,
  BlogOverviewDTO,
  DateRange,
  EngagementPoint,
  EngagementQuery,
  EngagementWeights,
  FollowerPoint,
  ReadingStatsDTO,
  TopBlogDTO,
  UserOverviewDTO,
  ViewsPoint,
} from './analytics.types';
import { MAX_BUCKETS, MAX_LOOKBACK_DAYS } from './analytics.validator';
import type {
  DateRangeQuery,
  ReadTelemetryInput,
  TopBlogsQuery,
  TotalsRangeQuery,
} from './analytics.validator';
import { analyticsIngestionService } from './ingestion/RedisAnalyticsIngestionService';
import type { IAnalyticsIngestionService } from './ingestion/IAnalyticsIngestionService';
import { collectPaged } from '../../core/utils/collectPaged';
import { EXPORT_MAX_ROWS_PER_COLLECTION, EXPORT_PAGE_SIZE } from '../export/export.config';

/**
 * The Analytics module's application service.
 *
 * Owns four things and delegates everything else: authorization, date-range
 * resolution, caching, and the mapping from database rows to wire DTOs. It holds
 * no SQL (that is `AnalyticsRepository`) and no knowledge of how events are
 * buffered (that is `IAnalyticsIngestionService`) — so replacing PostgreSQL with
 * a warehouse, or Redis with a stream, changes nothing in this file.
 *
 * ── Live counts vs. aggregated counts ───────────────────────────────────────
 * A metric that is cheap and exact to read from its source table is read from
 * its source table: the author's current follower count comes from `Follow`, and
 * their published-blog count from `Blog`. Only metrics that are expensive or
 * impossible to reconstruct — views, reads, engagement over time — come from the
 * aggregates.
 *
 * This is not a shortcut, it is the correctness argument. A follower total
 * summed from daily deltas drifts the moment one delta is lost or double-counted,
 * and the drift is permanent and invisible. Reading the live count means the
 * headline number on the dashboard is always exactly right, while the GROWTH
 * CHART beside it — which genuinely needs history — comes from the deltas.
 */

/** The authenticated requester. Same shape the Blog module uses. */
export interface Requester {
  userId: string;
  role: string;
}

export class AnalyticsService {
  constructor(
    private readonly repository: AnalyticsRepository = analyticsRepository,
    private readonly ingestion: IAnalyticsIngestionService = analyticsIngestionService
  ) {}

  // ---- Authorization -----------------------------------------------------

  /**
   * Asserts the requester may read this blog's analytics, and returns the blog.
   *
   * Analytics is private to the author (and to ADMIN). There is no public
   * surface: view counts are competitive information, and a public one would
   * also expose whether an UNLISTED post is being read.
   *
   * A blog that does not exist and a blog that belongs to someone else both
   * produce 404, never 403. A 403 would confirm the id is real — which for a
   * DRAFT is exactly the fact its author is relying on us not to leak. The Blog
   * module takes the same position on its own read path.
   */
  private async authorizeBlog(blogId: string, requester: Requester) {
    const blog = await blogService.getBlogMeta(blogId);

    if (!blog || (blog.authorId !== requester.userId && requester.role !== 'ADMIN')) {
      throw new AppError('Blog not found', 404, 'BLOG_NOT_FOUND');
    }

    return blog;
  }

  // ---- Blog reports ------------------------------------------------------

  async getBlogOverview(
    blogId: string,
    requester: Requester,
    query: TotalsRangeQuery
  ): Promise<BlogOverviewDTO> {
    const blog = await this.authorizeBlog(blogId, requester);
    const range = resolveTotalsRange(query);

    // Cached against the AUTHOR, not the requester: the answer depends only on
    // the blog and the range, so an ADMIN's read and the author's own read are
    // the same entry — and both are invalidated by the flush that writes the
    // author's rows.
    const totals = await withReportCache(
      'blog-overview',
      blog.authorId,
      { blogId, ...this.cacheParts(range) },
      () => this.repository.getBlogTotals(blogId, range)
    );

    return {
      blogId: blog.id,
      title: blog.title,
      slug: blog.slug,
      status: blog.status,
      publishedAt: blog.publishedAt ? blog.publishedAt.toISOString() : null,
      range: this.rangeDTO(range),
      views: totals.views,
      uniqueReaderDays: totals.uniqueReaderDays,
      uniqueViews: rangeIsSingleDay(range) ? totals.uniqueReaderDays : null,
      bookmarks: totals.bookmarks,
      netBookmarks: totals.bookmarks - totals.unbookmarks,
      comments: totals.comments,
      reading: this.readingStats(totals),
    };
  }

  async getBlogViews(
    blogId: string,
    requester: Requester,
    query: DateRangeQuery
  ): Promise<{ range: DateRange; points: ViewsPoint[] }> {
    const blog = await this.authorizeBlog(blogId, requester);
    const range = resolveDateRange(query);

    // The DTO is cached, NOT the database row. A cached value makes a round
    // trip through JSON, which turns every `Date` into a string — and the DTO
    // mappers call `.toISOString()` on those dates. Caching rows would work on
    // the miss and throw on every hit. Mapping inside the loader means the
    // cached value is exactly what is returned, in a shape JSON preserves.
    const points = await withReportCache(
      'blog-views',
      blog.authorId,
      { blogId, ...this.cacheParts(range) },
      async () =>
        (await this.repository.getBlogViewsSeries(blogId, range)).map((row) =>
          this.viewsPoint(row, bucketsAreSingleDays(range.granularity))
        )
    );

    return { range, points };
  }

  async getBlogEngagement(
    blogId: string,
    requester: Requester,
    query: DateRangeQuery
  ): Promise<{ range: DateRange; points: EngagementPoint[] }> {
    const blog = await this.authorizeBlog(blogId, requester);
    const range = resolveDateRange(query);

    const points = await withReportCache(
      'blog-engagement',
      blog.authorId,
      { blogId, ...this.cacheParts(range) },
      async () =>
        (await this.repository.getBlogEngagementSeries(blogId, range)).map((row) =>
          this.engagementPoint(row)
        )
    );

    return { range, points };
  }

  async getBlogReading(
    blogId: string,
    requester: Requester,
    query: TotalsRangeQuery
  ): Promise<{ range: DateRange; reading: ReadingStatsDTO; estimatedReadingMinutes: number }> {
    const blog = await this.authorizeBlog(blogId, requester);
    const range = resolveTotalsRange(query);

    const totals = await withReportCache(
      'blog-reading',
      blog.authorId,
      { blogId, ...this.cacheParts(range) },
      () => this.repository.getBlogTotals(blogId, range)
    );

    return {
      range,
      reading: this.readingStats(totals),
      // The post's own estimate, so a client can show measured-against-expected
      // without a second request to the Blog API.
      estimatedReadingMinutes: blog.readingTimeMinutes,
    };
  }

  // ---- Author reports ----------------------------------------------------

  async getUserOverview(requester: Requester, query: TotalsRangeQuery): Promise<UserOverviewDTO> {
    const range = resolveTotalsRange(query);
    const userId = requester.userId;

    const cached = await withReportCache(
      'user-overview',
      userId,
      this.cacheParts(range),
      async () => {
        // Five independent reads. Concurrent because none depends on another and
        // this is the dashboard's landing query — serially it would be five
        // round trips deep before the first byte.
        const [totals, followerTotals, blogCounts, followers] = await Promise.all([
          this.repository.getUserTotals(userId, range),
          this.repository.getUserFollowerTotals(userId, range),
          blogService.countBlogsByStatus(userId),
          followRepository.countFollowers(userId),
        ]);
        return { totals, followerTotals, blogCounts, followers };
      }
    );

    const { totals, followerTotals, blogCounts, followers } = cached;

    return {
      userId,
      range: this.rangeDTO(range),
      // Live counts — see the class doc.
      totalBlogs: blogCounts.DRAFT + blogCounts.PUBLISHED + blogCounts.ARCHIVED,
      publishedBlogs: blogCounts.PUBLISHED,
      draftBlogs: blogCounts.DRAFT,
      followers,
      // Range-scoped, from the aggregates.
      views: totals.views,
      uniqueReaderDays: totals.uniqueReaderDays,
      uniqueViews: rangeIsSingleDay(range) ? totals.uniqueReaderDays : null,
      bookmarks: totals.bookmarks,
      netBookmarks: totals.bookmarks - totals.unbookmarks,
      comments: totals.comments,
      followersGained: followerTotals.followersGained,
      followersLost: followerTotals.followersLost,
      blogsPublishedInRange: followerTotals.blogsPublished,
      reading: this.readingStats(totals),
    };
  }

  async getUserViews(
    requester: Requester,
    query: DateRangeQuery
  ): Promise<{ range: DateRange; points: ViewsPoint[] }> {
    const range = resolveDateRange(query);

    const points = await withReportCache(
      'user-views',
      requester.userId,
      this.cacheParts(range),
      async () =>
        (await this.repository.getUserViewsSeries(requester.userId, range)).map((row) =>
          this.viewsPoint(row, bucketsAreSingleDays(range.granularity))
        )
    );

    return { range, points };
  }

  async getUserEngagement(
    requester: Requester,
    query: DateRangeQuery
  ): Promise<{ range: DateRange; points: EngagementPoint[] }> {
    const range = resolveDateRange(query);

    const points = await withReportCache(
      'user-engagement',
      requester.userId,
      this.cacheParts(range),
      async () =>
        (await this.repository.getUserEngagementSeries(requester.userId, range)).map((row) =>
          this.engagementPoint(row)
        )
    );

    return { range, points };
  }

  /**
   * Audience growth over time, plus the current total.
   *
   * The chart is deltas from the aggregates; `currentFollowers` is the live
   * count. A client can therefore render both an exact "you have N followers"
   * and a correct shape for how it moved, without either being derived from the
   * other.
   */
  async getUserFollowers(
    requester: Requester,
    query: DateRangeQuery
  ): Promise<{ range: DateRange; currentFollowers: number; points: FollowerPoint[] }> {
    const range = resolveDateRange(query);

    const cached = await withReportCache(
      'user-followers',
      requester.userId,
      this.cacheParts(range),
      async () => {
        const [rows, currentFollowers] = await Promise.all([
          this.repository.getUserFollowerSeries(requester.userId, range),
          followRepository.countFollowers(requester.userId),
        ]);
        return { points: rows.map((row) => this.followerPoint(row)), currentFollowers };
      }
    );

    return { range, currentFollowers: cached.currentFollowers, points: cached.points };
  }

  /**
   * The author's best-performing blogs, cursor-paginated.
   *
   * The only analytics list that pages, because it is the only one whose length
   * grows with the author's output rather than with the requested range.
   */
  async getUserTopBlogs(
    requester: Requester,
    query: TopBlogsQuery
  ): Promise<{
    range: DateRange;
    metric: TopBlogsQuery['metric'];
    items: TopBlogDTO[];
    nextCursor: string | null;
    hasNextPage: boolean;
  }> {
    const range = resolveDateRange(query);

    const fingerprint = topBlogsFingerprint({
      authorId: requester.userId,
      metric: query.metric,
      startDate: range.startDate,
      endDate: range.endDate,
    });

    // Decoded BEFORE the cache lookup so a cursor from a different query is a
    // 400 rather than a cache miss that quietly returns page one.
    const cursor = query.cursor
      ? decodeTopBlogsCursor(query.cursor, fingerprint)
      : undefined;

    // Everything derived from the rows is computed INSIDE the loader, so the
    // cached value is plain JSON. Caching the rows themselves would survive the
    // miss and fail on every hit: `publishedAt` returns from Redis as a string,
    // and `topBlogDTO` calls `.toISOString()` on it.
    const cached = await withReportCache(
      'user-top-blogs',
      requester.userId,
      { ...this.cacheParts(range), metric: query.metric, limit: query.limit, cursor: query.cursor },
      async () => {
        const rows = await this.repository.getTopBlogs(
          requester.userId,
          range,
          query.metric,
          query.limit,
          cursor
        );

        // The repository fetched limit + 1; the extra row is the has-more
        // signal, never part of the page. Same contract as
        // `core/utils/pagination`.
        const hasNextPage = rows.length > query.limit;
        const page = hasNextPage ? rows.slice(0, query.limit) : rows;
        const last = page[page.length - 1];

        return {
          items: page.map((row) => this.topBlogDTO(row, rangeIsSingleDay(range))),
          hasNextPage,
          nextCursor:
            hasNextPage && last ? encodeTopBlogsCursor(fingerprint, last) : null,
        };
      }
    );

    return {
      range,
      metric: query.metric,
      items: cached.items,
      nextCursor: cached.nextCursor,
      hasNextPage: cached.hasNextPage,
    };
  }

  // ---- Reporting contract (for composing modules) ------------------------
  //
  // Three small accessors that publish facts a CONSUMER of these reports needs
  // in order to ask a valid question and to know when the answer changed. They
  // exist so a composing module (the Dashboard) never has to reach past this
  // service into `analytics.time`, `analytics.validator` or `analytics.cache`
  // and re-derive a rule that lives here. The alternative is a sibling module
  // computing UTC midnights and a hardcoded lookback, which drifts silently the
  // first time either setting changes.

  /**
   * The bounds a range request must satisfy.
   *
   * `maxLookbackDays` is the retention horizon — rows older than it are pruned,
   * so a range starting before it is rejected rather than answered with a
   * misleading empty series. `maxBuckets` caps the points in one series
   * response; a caller choosing a granularity for a long range needs it to pick
   * one that will actually be accepted.
   */
  getReportingLimits(): { maxLookbackDays: number; maxBuckets: number } {
    return { maxLookbackDays: MAX_LOOKBACK_DAYS, maxBuckets: MAX_BUCKETS };
  }

  /**
   * The inclusive window covering the last `days` reporting days, as the
   * `YYYY-MM-DD` labels this module's query API accepts.
   *
   * Reporting days, not UTC days: aggregates are bucketed by the configured
   * boundary (`ANALYTICS_REPORTING_UTC_OFFSET_MINUTES`), so a caller computing
   * calendar dates itself would silently shift the window by up to a day
   * whenever that setting is not zero. `days: 1` means "today".
   *
   * The sibling of `buildEngagementWindow`, which serves the same purpose for
   * the Feed module — this one returns date labels because its consumer feeds
   * them straight back into `getUserViews` and friends.
   */
  buildReportingWindow(days: number, now: Date = new Date()): {
    startDate: string;
    endDate: string;
  } {
    return {
      startDate: dateKey(reportingDaysAgo(days - 1, now)),
      endDate: dateKey(startOfReportingDay(now)),
    };
  }

  /**
   * The current cache generation for one owner's reports.
   *
   * A FRESHNESS TOKEN, not a cache implementation detail escaping: it changes
   * exactly when the flush worker writes new numbers for this user. A module
   * that caches a payload CONTAINING these reports embeds it in its own key, so
   * a flush invalidates that payload at the same instant it invalidates the
   * reports inside it. Without it, a composed cache's staleness is its own TTL
   * plus this module's, and the outer layer would go on serving numbers this
   * one had already superseded.
   */
  getReportGeneration(ownerId: string): Promise<number> {
    return currentGeneration(ownerId);
  }

  // ---- Ingestion ---------------------------------------------------------

  /**
   * Records client-reported reading progress.
   *
   * The one place a client may write into analytics, and it is deliberately
   * narrow: only the two reading events, only for a blog the caller can
   * actually see, and only through the same ingestion service the domain-event
   * subscribers use — so every guard (event dedupe, session ordering, duration
   * clamping, self-action filtering) applies identically to telemetry and to
   * server-emitted events.
   *
   * The visibility check is what stops this being an enumeration oracle: without
   * it, the endpoint's response would reveal which blog ids exist.
   */
  async recordReadingProgress(
    blogId: string,
    input: ReadTelemetryInput,
    requester: Requester | undefined,
    eventId: string
  ): Promise<void> {
    // A reading SESSION needs something stable to tie its start and completion
    // together, and an anonymous caller has supplied nothing. Reported rather
    // than silently dropped further in: this is a defect in the caller's own
    // request, so telling them is not the same as telling them what was
    // counted — a client missing this would otherwise send no-ops forever and
    // see 202 every time.
    if (!requester && !input.anonymousId) {
      throw new AppError(
        'anonymousId is required for unauthenticated reading telemetry',
        400,
        'ANONYMOUS_ID_REQUIRED'
      );
    }

    const blog = await blogService.getBlogMeta(blogId);

    if (
      !blog ||
      !blogService.canView(blog, requester ? { userId: requester.userId, role: requester.role } : undefined)
    ) {
      throw new AppError('Blog not found', 404, 'BLOG_NOT_FOUND');
    }

    const event: AnalyticsEvent = {
      eventId,
      eventType: input.event,
      // Server time, not client time. A client-supplied timestamp decides which
      // DAY a read is counted in, so trusting it would let a caller write into
      // any bucket — including days that have already been reported on.
      occurredAt: new Date(),
      entityType: 'BLOG',
      entityId: blogId,
      ownerId: blog.authorId,
      ...(requester
        ? { userId: requester.userId }
        : input.anonymousId
          ? { anonymousId: input.anonymousId }
          : {}),
      metadata: {
        kind: 'read',
        sessionId: input.sessionId,
        ...(input.durationSeconds !== undefined && { durationSeconds: input.durationSeconds }),
      },
    };

    const result = await this.ingestion.recordEvent(event);

    // Never surfaced to the caller. A rejected event is not a client error worth
    // reporting — "you already completed this session" and "you are the author"
    // are both correct outcomes — and an endpoint that tells a client which of
    // its events were counted is an endpoint that can be probed until they are.
    if (result.outcome !== 'recorded') {
      logger.debug(
        { blogId, event: input.event, outcome: result.outcome },
        'analytics: reading telemetry not recorded'
      );
    }
  }

  // ---- Discovery signals (internal, no HTTP surface) ---------------------

  /**
   * The platform's most-engaged blogs over a window.
   *
   * The Analytics module's contribution to content discovery, consumed by the
   * Feed & Explore module. There is deliberately NO route behind this and no
   * authorization check, because it is not reachable from the network: it is a
   * module-to-module call, and the caller is responsible for never serializing
   * the counts. Adding an endpoint here would publish per-blog view counts,
   * which `authorizeBlog` exists to keep private.
   *
   * Returns raw rows rather than DTOs — the consumer ranks with them, it does
   * not render them.
   */
  /**
   * Builds the window a discovery ranking is scored over.
   *
   * Exposed rather than left to the caller because a "day" is this module's
   * definition, not a universal one: aggregates are bucketed by the configured
   * reporting boundary (`ANALYTICS_REPORTING_UTC_OFFSET_MINUTES`), so a caller
   * computing UTC midnights would silently shift the window by up to a day
   * whenever that setting is not zero. `now` is a parameter so a ranking can be
   * rebuilt against the exact instant it was first built for.
   *
   * The window is INCLUSIVE at both ends and `windowDays` counts days, so
   * `windowDays: 1` means "today", and `7` means "today and the six days
   * before it".
   */
  buildEngagementWindow(input: {
    windowDays: number;
    weights: EngagementWeights;
    now?: Date;
  }): EngagementQuery {
    const now = input.now ?? new Date();
    return {
      startDate: reportingDaysAgo(input.windowDays - 1, now),
      endDate: startOfReportingDay(now),
      weights: input.weights,
    };
  }

  getEngagementRanking(query: EngagementQuery, limit: number): Promise<BlogEngagementRow[]> {
    return this.repository.getEngagementRanking(query, limit);
  }

  /**
   * Engagement for a known set of blogs, keyed by blog id.
   *
   * A Map rather than an array because every caller needs it by id, and building
   * that in each of them is how an O(n²) lookup ends up in a ranking loop. Blogs
   * with no activity in the window are ABSENT — the caller reads that as zero.
   */
  async getEngagementForBlogs(
    blogIds: string[],
    query: EngagementQuery
  ): Promise<Map<string, BlogEngagementRow>> {
    const rows = await this.repository.getEngagementForBlogs(blogIds, query);
    return new Map(rows.map((row) => [row.blogId, row]));
  }

  // ---- DTO mapping -------------------------------------------------------

  /**
   * Reading statistics derived from raw totals.
   *
   * Rates are `null`, never 0, when their denominator is 0. "No completion rate
   * because nobody started" and "a 0% completion rate" are different facts, and
   * collapsing them puts a red 0% on the dashboard of a post nobody has opened.
   */
  private readingStats(totals: AnalyticsTotals): ReadingStatsDTO {
    return {
      readStarts: totals.readStarts,
      readCompletions: totals.readCompletions,
      averageReadingSeconds:
        totals.readCompletions > 0
          ? Math.round(totals.totalReadingSeconds / totals.readCompletions)
          : null,
      totalReadingSeconds: totals.totalReadingSeconds,
      completionRate:
        totals.readStarts > 0
          ? round4(totals.readCompletions / totals.readStarts)
          : null,
      readThroughRate:
        totals.views > 0 ? round4(totals.readCompletions / totals.views) : null,
    };
  }

  /**
   * `exactUniques` is decided by the CALLER's range, not by the row: the same
   * summed column is an exact unique-reader count when the bucket is one day
   * and a reader-day total otherwise. Passing the flag in keeps that decision in
   * one place per endpoint instead of re-deriving it per row.
   */
  private viewsPoint(row: ViewsRow, exactUniques: boolean): ViewsPoint {
    return {
      date: dateKey(row.date),
      views: row.views,
      uniqueReaderDays: row.uniqueReaderDays,
      uniqueViews: exactUniques ? row.uniqueReaderDays : null,
    };
  }

  private engagementPoint(row: EngagementRow): EngagementPoint {
    return {
      date: dateKey(row.date),
      bookmarks: row.bookmarks,
      unbookmarks: row.unbookmarks,
      netBookmarks: row.netBookmarks,
      comments: row.comments,
    };
  }

  private followerPoint(row: FollowerRow): FollowerPoint {
    return { date: dateKey(row.date), gained: row.gained, lost: row.lost, net: row.net };
  }

  private topBlogDTO(row: TopBlogRow, exactUniques: boolean): TopBlogDTO {
    return {
      blogId: row.blogId,
      title: row.title,
      slug: row.slug,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      views: row.views,
      uniqueReaderDays: row.uniqueReaderDays,
      uniqueViews: exactUniques ? row.uniqueReaderDays : null,
      netBookmarks: row.netBookmarks,
      comments: row.comments,
      metricValue: row.metricValue,
    };
  }

  private rangeDTO(range: DateRange): { startDate: string; endDate: string } {
    return { startDate: dateKey(range.startDate), endDate: dateKey(range.endDate) };
  }

  /** The parts of a resolved range that belong in a cache key. */
  private cacheParts(range: DateRange): Record<string, unknown> {
    return {
      start: dateKey(range.startDate),
      end: dateKey(range.endDate),
      granularity: range.granularity,
    };
  }

  /**
   * This user's analytics, for the data export: their own daily aggregates plus
   * the per-blog series for everything they authored.
   *
   * Aggregates only. There is no raw event log to export — Analytics never
   * stores one (see ANALYTICS_MODULE.md): views are deduplicated in Redis and
   * flushed as daily counters, so the daily row IS the finest grain that exists.
   */
  async collectForExport(userId: string) {
    type BlogDailyExportRow = Awaited<
      ReturnType<typeof analyticsRepository.findBlogDailyForExport>
    >[number];

    const [daily, blogDaily] = await Promise.all([
      analyticsRepository.findUserDailyForExport(userId),
      collectPaged<BlogDailyExportRow>(
        (previous) =>
          analyticsRepository.findBlogDailyForExport(
            userId,
            EXPORT_PAGE_SIZE,
            previous ? { blogId: previous.blogId, date: previous.date } : undefined
          ),
        EXPORT_PAGE_SIZE,
        EXPORT_MAX_ROWS_PER_COLLECTION
      ),
    ]);

    return { daily, blogDaily };
  }
}

/** Rates are proportions, not percentages. Four decimals is plenty of precision. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export const analyticsService = new AnalyticsService();
