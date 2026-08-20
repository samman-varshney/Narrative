import type { BlogStatus } from '@prisma/client';
import { analyticsService } from '../analytics/analytics.service';
import { blogService } from '../blog/blog.service';
import { bookmarkService } from '../bookmark/bookmark.service';
import { commentService } from '../comment/comment.service';
import { followService } from '../follow/follow.service';
import { notificationService } from '../notification/notification.service';
import type { TopBlogsMetric, UserOverviewDTO } from '../analytics/analytics.types';
import { ACTIVITY_LOOKBACK_DAYS, PANEL_LIMITS, type SectionKey } from './dashboard.config';
import {
  commentActivity,
  followerActivity,
  mergeActivity,
  publishedActivity,
  toBlogSummary,
  toNotificationSummary,
  toReadingSummary,
  toSavedBlog,
} from './dashboard.mappers';
import { toSeriesQuery, toTotalsQuery } from './dashboard.range';
import type {
  ActivityItemDTO,
  DashboardOverviewDTO,
  DashboardRangeDTO,
  TopContentItemDTO,
} from './dashboard.types';

/**
 * The section registry.
 *
 * Every panel of the dashboard is one entry in `SECTION_BUILDERS` below. Adding
 * a section — revenue, writing streaks, whatever comes next — means adding a
 * key to `DASHBOARD_SECTIONS`, a field to `DashboardOverviewDTO`, and a builder
 * here. No controller branch, no service method, no route, no cache change.
 * That is the extensibility requirement discharged structurally instead of by
 * good intentions.
 *
 * ── Builders own composition, never retrieval ───────────────────────────────
 * There is no repository in this module and no SQL in this file. Every builder
 * calls a sibling module's SERVICE and maps the result. When a panel needs data
 * no service can express, the query is added to the module that OWNS that data
 * — which is how `commentService.getReceivedComments` came to exist — never
 * here. A dashboard that queries `Comment` directly is a dashboard that will
 * disagree with the comment thread about which comments are visible, the first
 * time moderation rules change.
 *
 * ── The shared-read problem ─────────────────────────────────────────────────
 * Panels overlap: `stats` and `audience` both need follower counts, `stats` and
 * `bookmarks` both need the library. Built naively, an eight-panel overview
 * would fetch the same three things two or three times each, and the duplicates
 * would grow every time a panel was added. `DashboardContext.once` memoizes a
 * read for the life of ONE request, so overlapping panels share a single
 * in-flight promise and a panel requested alone still pays for exactly what it
 * needs.
 */

/** The authenticated requester. Same shape Analytics and Blog use. */
export interface DashboardRequester {
  userId: string;
  role: string;
}

/**
 * Per-request state shared by the section builders.
 *
 * Constructed once per request and thrown away with it. The memo MUST NOT
 * outlive the request: it holds one user's data, and a longer-lived cache keyed
 * this loosely is how one author's numbers end up on another's dashboard. This
 * is deliberately not the Redis cache — that one is keyed by user and
 * generation precisely because it does outlive the request.
 */
export class DashboardContext {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly requester: DashboardRequester,
    readonly range: DashboardRangeDTO,
    readonly now: Date = new Date()
  ) {}

  get userId(): string {
    return this.requester.userId;
  }

  /**
   * Runs `loader` at most once per key for this request.
   *
   * Stores the PROMISE, not the resolved value, so two panels starting
   * concurrently share one in-flight read rather than both missing an
   * empty cache and issuing the query. A rejected promise is evicted, so a
   * failing shared read does not condemn every later panel that wanted it —
   * one of them retries, and section isolation handles the rest.
   */
  once<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.memo.get(key);
    if (existing) return existing as Promise<T>;

    const promise = loader().catch((err) => {
      this.memo.delete(key);
      throw err;
    });
    this.memo.set(key, promise);
    return promise;
  }

  // ---- Shared reads ------------------------------------------------------

  /**
   * The Analytics module's author overview for this range.
   *
   * The single most reused read in the module: it carries blog counts, follower
   * totals, range-scoped views, engagement and reading statistics, and it is
   * cached on the Analytics side. Two panels consume it, and the naive
   * alternative — each re-deriving blog counts and follower totals from Blog
   * and Follow — is four extra queries for numbers this already contains.
   */
  analyticsOverview(): Promise<UserOverviewDTO> {
    return this.once('analytics:overview', () =>
      analyticsService.getUserOverview(this.requester, toTotalsQuery(this.range))
    );
  }

  /** Current follower/following totals, live from the follow graph. */
  followCounts(): Promise<{ followers: number; following: number }> {
    return this.once('follow:counts', () => followService.getCounts(this.userId));
  }

  /**
   * Blog counts by status, live from the Blog module.
   *
   * Read from Blog and NOT from the analytics overview, which also returns
   * them. That looks like a wasted query and is not: the analytics overview is
   * cached under the ANALYTICS generation, which only its flush worker
   * advances, so a draft saved thirty seconds ago would be missing from these
   * counters while the `drafts` panel beside them — read live — already showed
   * it. Two numbers contradicting each other on one screen is a worse defect
   * than one extra indexed `GROUP BY`, and the contradiction is the kind a user
   * reports as "the dashboard is broken".
   *
   * The engagement and audience-growth figures still come from the analytics
   * overview, because those genuinely are analytics and have no live source.
   */
  blogCounts(): Promise<Record<BlogStatus, number>> {
    return this.once('blog:counts', () => blogService.countBlogsByStatus(this.userId));
  }

  /**
   * A page of the user's bookmark library, with its total.
   *
   * Serves the `bookmarks` panel and the `library.bookmarks` counter in
   * `stats`, which is why it fetches rows even when only the count is wanted:
   * the count comes back with the page anyway, and the alternative is a second
   * call for a number already in hand.
   */
  bookmarkLibrary() {
    return this.once('bookmark:library', () =>
      bookmarkService.getUserBookmarks(
        this.userId,
        { limit: PANEL_LIMITS.bookmarks, sort: 'recent' as const },
        this.requester.role
      )
    );
  }
}

/**
 * A section builder. Returns the section's payload, or throws — a throw becomes
 * `null` plus an entry in `degradedSections`, never a failed request.
 */
export type SectionBuilder<K extends SectionKey> = (
  ctx: DashboardContext
) => Promise<NonNullable<DashboardOverviewDTO[K]>>;

export const SECTION_BUILDERS: { [K in SectionKey]: SectionBuilder<K> } = {
  /**
   * The headline numbers.
   *
   * Five reads, four of them shared with other panels and collapsed by the
   * per-request memo.
   *
   * The split is deliberate and is the module's central correctness rule:
   * COUNTS that have a live source are read from it (blogs from Blog, follows
   * from Follow, saved items from Bookmark, unread from Notification), while
   * only figures that cannot be reconstructed — views, reads, engagement,
   * audience deltas — come from the analytics aggregates. A counter read live
   * agrees with the panel beside it that lists the same rows; one read from a
   * cache invalidated on a different schedule does not.
   */
  stats: async (ctx) => {
    const [overview, counts, follow, library, unread] = await Promise.all([
      ctx.analyticsOverview(),
      ctx.blogCounts(),
      ctx.followCounts(),
      ctx.bookmarkLibrary(),
      notificationService.unreadCount(ctx.userId),
    ]);

    return {
      content: {
        // DELETED is excluded from the total rather than added in: a
        // soft-deleted blog is gone as far as its author is concerned, and a
        // "total blogs" that silently counts the trash is a number nobody can
        // reconcile against what they see in any panel.
        total: counts.DRAFT + counts.PUBLISHED + counts.ARCHIVED,
        published: counts.PUBLISHED,
        drafts: counts.DRAFT,
        archived: counts.ARCHIVED,
      },
      audience: {
        followers: follow.followers,
        following: follow.following,
      },
      engagement: {
        views: overview.views,
        uniqueReaderDays: overview.uniqueReaderDays,
        uniqueViews: overview.uniqueViews,
        comments: overview.comments,
        netBookmarks: overview.netBookmarks,
        reading: toReadingSummary(overview.reading),
      },
      library: { bookmarks: library.totalCount },
      notifications: { unread: unread.unreadCount },
    };
  },

  /** The author's most recently published posts. */
  recentBlogs: async (ctx) => {
    const blogs = await ctx.once('blog:published:panel', () =>
      blogService.listMyBlogs(ctx.userId, {
        statuses: ['PUBLISHED'],
        order: 'published',
        limit: PANEL_LIMITS.recentBlogs,
      })
    );
    return blogs.map(toBlogSummary);
  },

  /**
   * Drafts, most recently EDITED first.
   *
   * `updated`, not `created` — a writer opening their dashboard is looking for
   * the draft they were working on, and creation order buries it under every
   * newer stub. The reading metadata each row carries (`readingTimeMinutes`,
   * `wordCount`) comes from the Blog module's own content parsing, so a draft
   * panel can show progress without this module ever touching the content JSON.
   */
  drafts: async (ctx) => {
    const drafts = await blogService.listMyBlogs(ctx.userId, {
      statuses: ['DRAFT'],
      order: 'updated',
      limit: PANEL_LIMITS.drafts,
    });
    return drafts.map(toBlogSummary);
  },

  /**
   * Best-performing posts over the range. See `buildTopContent`.
   */
  topContent: async (ctx) =>
    (await buildTopContent(ctx, { limit: PANEL_LIMITS.topContent })).items,

  /**
   * Audience size and movement.
   *
   * The totals are live from the follow graph; the deltas are range-scoped from
   * the daily aggregates. Neither is derived from the other, and that is the
   * point — see `AudienceDTO`.
   */
  audience: async (ctx) => {
    const [overview, follow] = await Promise.all([
      ctx.analyticsOverview(),
      ctx.followCounts(),
    ]);

    return {
      followers: follow.followers,
      following: follow.following,
      growth: {
        gained: overview.followersGained,
        lost: overview.followersLost,
        net: overview.followersGained - overview.followersLost,
      },
    };
  },

  /** The user's own reading list. Their saved content, not their audience's. */
  bookmarks: async (ctx) => {
    const library = await ctx.bookmarkLibrary();
    return {
      total: library.totalCount,
      items: library.items.map(toSavedBlog),
    };
  },

  /**
   * Unread count and the newest notifications.
   *
   * Straight from the Notification module — this module creates nothing, marks
   * nothing read, and applies no preferences of its own. It is a read-only
   * window onto a system that already exists.
   */
  notifications: async (ctx) => {
    const page = await notificationService.list(ctx.userId, {
      limit: PANEL_LIMITS.notifications,
      sort: 'recent' as const,
    });

    return {
      unread: page.unreadCount,
      items: page.items.map(toNotificationSummary),
    };
  },

  /**
   * What happened lately. See `buildActivity`.
   */
  activity: (ctx) => buildActivity(ctx, PANEL_LIMITS.activity),
};

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------
//
// Two panels have a standalone endpoint that takes its own paging parameters,
// so their assembly lives in a function both entry points call. The alternative
// — a section builder and a near-identical service method — is two definitions
// of one panel, and they diverge the first time either is changed.

/**
 * Best-performing posts over the range, ranked by one analytics metric.
 *
 * The ranking is entirely the Analytics module's: this module supplies no
 * scoring, no weights and no tiebreaker, and the metric it passes through is
 * that module's own vocabulary. A second ranking system beside the one that
 * owns the data is how two "top posts" lists end up disagreeing on one page.
 * Changing how "top" is decided is therefore a change in Analytics, and every
 * consumer of it moves together.
 *
 * What this adds is HYDRATION. The ranking returns ids, titles and numbers,
 * while a content card also wants a cover image, a status and a reading time —
 * fetched for the whole page in ONE batched call, because the per-row
 * alternative is an N+1 that grows with the page size.
 */
export async function buildTopContent(
  ctx: DashboardContext,
  options: { limit: number; metric?: TopBlogsMetric; cursor?: string }
): Promise<{ items: TopContentItemDTO[]; nextCursor: string | null; hasNextPage: boolean }> {
  const top = await analyticsService.getUserTopBlogs(ctx.requester, {
    ...toSeriesQuery(ctx.range),
    metric: options.metric ?? 'views',
    limit: options.limit,
    ...(options.cursor && { cursor: options.cursor }),
  });

  const cards = await blogService.getMyBlogCards(
    ctx.userId,
    top.items.map((item) => item.blogId)
  );

  const items = top.items.flatMap((item) => {
    const card = cards.get(item.blogId);
    // A blog can be deleted between the ranking and the hydration. Dropping the
    // row is the only honest option: a "top post" the author cannot open is
    // worse than a four-item list.
    if (!card) return [];
    return [
      {
        blog: toBlogSummary(card),
        views: item.views,
        uniqueReaderDays: item.uniqueReaderDays,
        uniqueViews: item.uniqueViews,
        netBookmarks: item.netBookmarks,
        comments: item.comments,
        metricValue: item.metricValue,
      },
    ];
  });

  // The cursor and the has-more flag come from Analytics untouched. Recomputing
  // them from the hydrated list would be wrong: a row dropped above is still a
  // row the ranking paged past, and re-deriving the cursor from what survived
  // would make the next page repeat it.
  return { items, nextCursor: top.nextCursor, hasNextPage: top.hasNextPage };
}

/**
 * Recent activity, merged from three sources.
 *
 * Each source is read in parallel and bounded by the SAME limit as the final
 * feed. Fetching the full limit from every source is what makes the merge
 * correct: take fewer, and a burst of comments could push a follower that
 * belongs in the feed out of the candidate set entirely.
 *
 * There is no activity table and no activity writer anywhere in this module.
 * Every row is read from whichever module already records the thing — which is
 * why a comment its author deletes disappears from this feed with no
 * invalidation logic in between.
 */
export async function buildActivity(
  ctx: DashboardContext,
  limit: number
): Promise<ActivityItemDTO[]> {
  const since = new Date(ctx.now.getTime() - ACTIVITY_LOOKBACK_DAYS * 86_400_000);

  const [comments, followers, published] = await Promise.all([
    commentService.getReceivedComments(ctx.userId, { limit, since }),
    // No viewer id: this is the author's own follower list, and the
    // `isFollowedByViewer` annotation it would otherwise compute is a second
    // query for a flag no activity row renders.
    followService.getFollowers(ctx.userId, { limit }),
    blogService.listMyBlogs(ctx.userId, {
      statuses: ['PUBLISHED'],
      order: 'published',
      limit,
    }),
  ]);

  return mergeActivity(
    [
      comments.map(commentActivity),
      followers.items.map(followerActivity),
      published.map(publishedActivity),
    ],
    limit
  );
}
