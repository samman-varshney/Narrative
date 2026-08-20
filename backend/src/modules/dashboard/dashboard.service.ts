import { logger } from '../../core/utils/logger';
import { analyticsService } from '../analytics/analytics.service';
import { blogService } from '../blog/blog.service';
import { withCache } from './dashboard.cache';
import { DASHBOARD_SECTIONS, type SectionKey } from './dashboard.config';
import { toBlogSummary } from './dashboard.mappers';
import { resolveRange, toSeriesQuery } from './dashboard.range';
import {
  DashboardContext,
  SECTION_BUILDERS,
  buildActivity,
  buildTopContent,
  type DashboardRequester,
} from './dashboard.sections';
import { denseSeries } from './dashboard.series';
import type {
  ActivityItemDTO,
  BlogSummaryDTO,
  DashboardChartsDTO,
  DashboardOverviewDTO,
  DashboardRangeDTO,
  DashboardStatsDTO,
  EngagementChartPoint,
  FollowersChartPoint,
  TopContentItemDTO,
  ViewsChartPoint,
} from './dashboard.types';
import type {
  ActivityQuery,
  ChartsQuery,
  DraftsQuery,
  OverviewQuery,
  RangeQuery,
  TopContentQuery,
} from './dashboard.validator';

/**
 * The Dashboard module's application service.
 *
 * Owns three things and delegates everything else: range resolution, caching,
 * and section composition. It holds no SQL — there is no repository in this
 * module, by design — and no business rules about blogs, comments, follows or
 * analytics. Every fact it returns was produced by the module that owns it.
 *
 * ── Authorization is the API's shape, not a check ───────────────────────────
 * Every method takes a `DashboardRequester` and uses `requester.userId` for
 * every read. There is NO parameter anywhere in this file for whose dashboard
 * to build, on any method, at any layer. "User A cannot read User B's
 * dashboard" is therefore not a rule that could be forgotten in a new
 * endpoint — there is nothing to pass. Admins are not exempt, and that is
 * deliberate: an admin needing platform numbers is a different feature with
 * different auditing, not a query parameter on this one.
 *
 * The sibling modules re-check anyway. `analyticsService` authorizes against
 * its own rules, `blogService.getMyBlogCards` filters by author, and
 * `commentService.getReceivedComments` scopes by blog ownership. Nothing here
 * relies on being the only line of defence.
 */
export class DashboardService {
  // ---- Composite ---------------------------------------------------------

  /**
   * The whole landing payload, in one request.
   *
   * ── Section isolation ────────────────────────────────────────────────────
   * `allSettled`, not `all`. A dashboard aggregates six subsystems, so `all`
   * means the entire page fails whenever any one of them does — a notification
   * table lock would blank the author's blog stats, which is a strictly worse
   * outcome than a missing panel. A failed section becomes `null` and is named
   * in `degradedSections`; the response is still a 200 and the other panels are
   * still correct.
   *
   * A degraded response is deliberately NOT cached (see `cacheable` below), so
   * a two-second blip does not become a minute of empty panels.
   */
  async getOverview(
    requester: DashboardRequester,
    query: OverviewQuery,
    now: Date = new Date()
  ): Promise<{
    overview: DashboardOverviewDTO;
    range: DashboardRangeDTO;
    sections: SectionKey[];
    degradedSections: SectionKey[];
  }> {
    const range = resolveRange(query.range, now);
    // Canonical order, whatever order the client listed them in: the section
    // list is part of the cache key, and `?sections=drafts,stats` must not
    // occupy a different entry from `?sections=stats,drafts`.
    const sections = DASHBOARD_SECTIONS.filter((key) => query.sections.includes(key));

    const built = await withCache(
      'overview',
      requester.userId,
      { range: query.range, sections },
      async () => {
        // One context for the whole request, so panels that need the same
        // upstream read share it. See `DashboardContext.once`.
        const ctx = new DashboardContext(requester, range, now);

        const settled = await Promise.allSettled(
          sections.map((key) => SECTION_BUILDERS[key](ctx))
        );

        // Accumulated in a loose record and cast ONCE at the end. Each
        // builder's return type is pinned to its own key by `SECTION_BUILDERS`,
        // but TypeScript cannot carry that correspondence through an array
        // position, so a per-assignment cast would be eight casts instead of
        // one — and eight places for the correspondence to be broken silently.
        const built: Record<string, unknown> = {};
        const degradedSections: SectionKey[] = [];

        settled.forEach((result, index) => {
          const key = sections[index]!;

          if (result.status === 'fulfilled') {
            built[key] = result.value;
            return;
          }

          // `null`, not absent: the key WAS requested, and a client has to be
          // able to tell "failed" from "you did not ask for this".
          built[key] = null;
          degradedSections.push(key);
          logger.warn(
            { err: result.reason, section: key, userId: requester.userId },
            'dashboard: section failed'
          );
        });

        const overview = { range, ...built } as DashboardOverviewDTO;
        return { overview, degradedSections };
      },
      { cacheable: (value) => value.degradedSections.length === 0 }
    );

    return {
      overview: built.overview,
      range,
      sections: [...sections],
      degradedSections: built.degradedSections,
    };
  }

  // ---- Sections ----------------------------------------------------------

  /** The headline counters on their own — the cheap, poll-friendly endpoint. */
  async getStats(
    requester: DashboardRequester,
    query: RangeQuery,
    now: Date = new Date()
  ): Promise<{ stats: DashboardStatsDTO; range: DashboardRangeDTO }> {
    const range = resolveRange(query.range, now);

    const stats = await withCache('stats', requester.userId, { range: query.range }, () =>
      SECTION_BUILDERS.stats(new DashboardContext(requester, range, now))
    );

    return { stats, range };
  }

  /**
   * Chart-ready time series.
   *
   * Every series is delegated to the Analytics module and then GAP-FILLED here
   * (see `dashboard.series.ts`) — the one transformation this module applies to
   * analytics data, and a presentation decision, which is why it lives on this
   * side of the boundary.
   *
   * Requesting several series in one call is the entire reason this endpoint
   * exists: a dashboard draws three charts, and three round trips to draw one
   * screen is what the composite endpoints of this module are for. They are
   * fetched concurrently, and a client that wants one asks for one.
   *
   * Unlike the overview, a failure here propagates. There is no partial answer
   * worth giving when the only subsystem involved is the one that is down, and
   * an `AppError` from Analytics (an over-long range, say) is a 400 the caller
   * needs to see rather than a silently empty chart.
   */
  async getCharts(
    requester: DashboardRequester,
    query: ChartsQuery,
    now: Date = new Date()
  ): Promise<DashboardChartsDTO> {
    const range = resolveRange(query.range, now);
    const wanted = new Set(query.series);

    return withCache(
      'charts',
      requester.userId,
      { range: query.range, series: [...query.series].sort() },
      async () => {
        const seriesQuery = toSeriesQuery(range);

        const [views, engagement, followers] = await Promise.all([
          wanted.has('views')
            ? analyticsService.getUserViews(requester, seriesQuery)
            : null,
          wanted.has('engagement')
            ? analyticsService.getUserEngagement(requester, seriesQuery)
            : null,
          wanted.has('followers')
            ? analyticsService.getUserFollowers(requester, seriesQuery)
            : null,
        ]);

        const charts: DashboardChartsDTO = { range };

        if (views) {
          charts.views = {
            points: denseSeries<ViewsChartPoint>(
              views.points.map((point) => ({
                date: point.date,
                views: point.views,
                uniqueReaderDays: point.uniqueReaderDays,
                uniqueViews: point.uniqueViews,
              })),
              range,
              (date) => ({
                date,
                views: 0,
                uniqueReaderDays: 0,
                // Zero, not null, at daily granularity: a day with no rows
                // genuinely had zero distinct readers, and that IS exact. Above
                // a day the field is not reportable at all, which `null` says
                // and `0` would misstate — the same rule Analytics applies to
                // buckets that do have rows.
                uniqueViews: range.granularity === 'day' ? 0 : null,
              })
            ),
          };
        }

        if (engagement) {
          charts.engagement = {
            points: denseSeries<EngagementChartPoint>(
              engagement.points.map((point) => ({
                date: point.date,
                comments: point.comments,
                bookmarks: point.bookmarks,
                unbookmarks: point.unbookmarks,
                netBookmarks: point.netBookmarks,
              })),
              range,
              (date) => ({
                date,
                comments: 0,
                bookmarks: 0,
                unbookmarks: 0,
                netBookmarks: 0,
              })
            ),
          };
        }

        if (followers) {
          charts.followers = {
            current: followers.currentFollowers,
            points: denseSeries<FollowersChartPoint>(
              followers.points.map((point) => ({
                date: point.date,
                gained: point.gained,
                lost: point.lost,
                net: point.net,
              })),
              range,
              (date) => ({ date, gained: 0, lost: 0, net: 0 })
            ),
          };
        }

        return charts;
      }
    );
  }

  /** Top-performing content, paginated by the Analytics module's own cursor. */
  async getTopContent(
    requester: DashboardRequester,
    query: TopContentQuery,
    now: Date = new Date()
  ): Promise<{
    range: DashboardRangeDTO;
    metric: TopContentQuery['metric'];
    items: TopContentItemDTO[];
    nextCursor: string | null;
    hasNextPage: boolean;
  }> {
    const range = resolveRange(query.range, now);

    const page = await withCache(
      'top-content',
      requester.userId,
      {
        range: query.range,
        metric: query.metric,
        limit: query.limit,
        cursor: query.cursor,
      },
      () =>
        buildTopContent(new DashboardContext(requester, range, now), {
          limit: query.limit,
          metric: query.metric,
          ...(query.cursor && { cursor: query.cursor }),
        })
    );

    return { range, metric: query.metric, ...page };
  }

  /**
   * The author's drafts, paginated.
   *
   * Delegates to the Blog module including its cursor — this module does not
   * page a list it did not query, and re-deriving a cursor from a mapped page
   * is how a "load more" starts skipping rows.
   */
  async getDrafts(
    requester: DashboardRequester,
    query: DraftsQuery
  ): Promise<{
    items: BlogSummaryDTO[];
    nextCursor: string | null;
    hasNextPage: boolean;
    totalCount: number;
  }> {
    return withCache(
      'drafts',
      requester.userId,
      { limit: query.limit, cursor: query.cursor },
      async () => {
        const page = await blogService.getMyDrafts(
          requester.userId,
          { limit: query.limit, ...(query.cursor && { cursor: query.cursor }) },
          'updated'
        );

        return {
          items: page.items.map(toBlogSummary),
          nextCursor: page.nextCursor,
          hasNextPage: page.hasNextPage,
          totalCount: page.totalCount,
        };
      }
    );
  }

  /** Recent activity across comments, followers and the author's own publishing. */
  async getActivity(
    requester: DashboardRequester,
    query: ActivityQuery,
    now: Date = new Date()
  ): Promise<{ items: ActivityItemDTO[] }> {
    // The activity feed spans no reporting window — it is "the last N things",
    // not "things in this range" — so it is built against the default range
    // purely to satisfy the context, which activity never reads.
    const range = resolveRange('30d', now);

    const items = await withCache(
      'activity',
      requester.userId,
      { limit: query.limit },
      () => buildActivity(new DashboardContext(requester, range, now), query.limit)
    );

    return { items };
  }
}

export const dashboardService = new DashboardService();
