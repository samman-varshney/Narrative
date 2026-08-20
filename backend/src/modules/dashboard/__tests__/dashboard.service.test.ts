import { analyticsService } from '../../analytics/analytics.service';
import { blogService } from '../../blog/blog.service';
import { bookmarkService } from '../../bookmark/bookmark.service';
import { commentService } from '../../comment/comment.service';
import { followService } from '../../follow/follow.service';
import { notificationService } from '../../notification/notification.service';
import { withCache } from '../dashboard.cache';
import { DASHBOARD_SECTIONS } from '../dashboard.config';
import { dashboardService } from '../dashboard.service';
import { FIXED_NOW } from './helpers';

/**
 * Composition, with every sibling module mocked.
 *
 * What is under test is the only thing this module actually does: which service
 * it calls, whose id it calls them with, how it assembles the answers, and what
 * happens when one of them fails. Nothing here touches Postgres or Redis —
 * behaviour against real SQL lives in `dashboard.db.test.ts`, and cache
 * behaviour in `dashboard.cache.test.ts`.
 */

jest.mock('../../analytics/analytics.service');
jest.mock('../../blog/blog.service');
jest.mock('../../bookmark/bookmark.service');
jest.mock('../../comment/comment.service');
jest.mock('../../follow/follow.service');
jest.mock('../../notification/notification.service');
jest.mock('../dashboard.cache');

const analytics = analyticsService as jest.Mocked<typeof analyticsService>;
const blogs = blogService as jest.Mocked<typeof blogService>;
const bookmarks = bookmarkService as jest.Mocked<typeof bookmarkService>;
const comments = commentService as jest.Mocked<typeof commentService>;
const follows = followService as jest.Mocked<typeof followService>;
const notifications = notificationService as jest.Mocked<typeof notificationService>;
const cache = withCache as jest.MockedFunction<typeof withCache>;

const ALICE = { userId: 'alice', role: 'USER' };
const BOB = { userId: 'bob', role: 'USER' };

/** Captures what the service asked the cache to do, per call. */
let cacheCalls: { scope: string; userId: string; cacheable: boolean }[] = [];

const ANALYTICS_OVERVIEW = {
  userId: 'alice',
  range: { startDate: '2026-07-22', endDate: '2026-08-20' },
  totalBlogs: 10,
  publishedBlogs: 6,
  draftBlogs: 3,
  followers: 42,
  views: 500,
  uniqueReaderDays: 300,
  uniqueViews: null,
  bookmarks: 20,
  netBookmarks: 15,
  comments: 8,
  followersGained: 7,
  followersLost: 2,
  blogsPublishedInRange: 2,
  reading: {
    readStarts: 100,
    readCompletions: 60,
    averageReadingSeconds: 180,
    totalReadingSeconds: 10_800,
    completionRate: 0.6,
    readThroughRate: 0.12,
  },
};

const BLOG_CARD = {
  id: 'blog-1',
  title: 'A Post',
  slug: 'a-post',
  subtitle: 'Sub',
  coverImage: null,
  status: 'PUBLISHED',
  visibility: 'PUBLIC',
  readingTimeMinutes: 5,
  wordCount: 900,
  charCount: 5000,
  readingStats: { headingCount: 2, imageCount: 1, codeBlockCount: 0 },
  author: {
    id: 'alice',
    username: 'alice',
    name: 'Alice',
    avatar: null,
    bio: null,
    isVerified: false,
  },
  tags: [{ id: 't1', name: 'react', slug: 'react' }],
  categories: [],
  publishedAt: new Date('2026-08-19T00:00:00.000Z'),
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-18T00:00:00.000Z'),
};

const TOP_BLOG = {
  blogId: 'blog-1',
  title: 'A Post',
  slug: 'a-post',
  publishedAt: '2026-08-19T00:00:00.000Z',
  views: 200,
  uniqueReaderDays: 150,
  uniqueViews: null,
  netBookmarks: 9,
  comments: 4,
  metricValue: 200,
};

beforeEach(() => {
  jest.clearAllMocks();
  cacheCalls = [];

  // A pass-through cache that records what it was asked to do, so the tests can
  // assert on caching DECISIONS (notably: never cache a degraded response)
  // without a Redis round trip.
  cache.mockImplementation(async (scope, userId, _parts, loader, options) => {
    const value = await loader();
    cacheCalls.push({
      scope,
      userId,
      cacheable: options?.cacheable?.(value) ?? true,
    });
    return value;
  });

  // Range resolution is exercised for real in `dashboard.range.test.ts`; here
  // it only has to produce a window.
  analytics.getReportingLimits.mockReturnValue({ maxLookbackDays: 400, maxBuckets: 370 });
  analytics.buildReportingWindow.mockReturnValue({
    startDate: '2026-08-14',
    endDate: '2026-08-20',
  });

  analytics.getUserOverview.mockResolvedValue(ANALYTICS_OVERVIEW as never);
  analytics.getUserTopBlogs.mockResolvedValue({
    range: {} as never,
    metric: 'views',
    items: [TOP_BLOG],
    nextCursor: 'CURSOR',
    hasNextPage: true,
  } as never);
  analytics.getUserViews.mockResolvedValue({
    range: {} as never,
    points: [{ date: '2026-08-20', views: 12, uniqueReaderDays: 9, uniqueViews: 9 }],
  } as never);
  analytics.getUserEngagement.mockResolvedValue({
    range: {} as never,
    points: [
      { date: '2026-08-20', bookmarks: 2, unbookmarks: 1, netBookmarks: 1, comments: 3 },
    ],
  } as never);
  analytics.getUserFollowers.mockResolvedValue({
    range: {} as never,
    currentFollowers: 42,
    points: [{ date: '2026-08-20', gained: 2, lost: 0, net: 2 }],
  } as never);

  blogs.countBlogsByStatus.mockResolvedValue({
    DRAFT: 3,
    PUBLISHED: 6,
    ARCHIVED: 1,
    // Soft-deleted blogs exist in the table and must not reach the total.
    DELETED: 2,
  } as never);
  blogs.listMyBlogs.mockResolvedValue([BLOG_CARD] as never);
  blogs.getMyBlogCards.mockResolvedValue(new Map([['blog-1', BLOG_CARD]]) as never);
  blogs.getMyDrafts.mockResolvedValue({
    items: [BLOG_CARD],
    nextCursor: null,
    hasNextPage: false,
    totalCount: 1,
  } as never);

  bookmarks.getUserBookmarks.mockResolvedValue({
    items: [
      {
        bookmarkId: 'bm-1',
        bookmarkedAt: new Date('2026-08-17T00:00:00.000Z'),
        isAvailable: true,
        blog: {
          id: 'blog-9',
          title: 'Saved',
          slug: 'saved',
          coverImage: null,
          readingTimeMinutes: 3,
          author: {
            id: 'carol',
            username: 'carol',
            name: 'Carol',
            avatar: null,
            isVerified: false,
          },
          publishedAt: new Date('2026-08-10T00:00:00.000Z'),
          visibility: 'PUBLIC',
        },
      },
    ],
    nextCursor: null,
    hasNextPage: false,
    totalCount: 4,
  } as never);

  comments.getReceivedComments.mockResolvedValue([
    {
      id: 'c1',
      content: 'Nice post',
      blogId: 'blog-1',
      authorId: 'bob',
      parentId: null,
      depth: 0,
      author: {
        id: 'bob',
        username: 'bob',
        name: 'Bob',
        avatar: null,
        bio: null,
        isVerified: false,
      },
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      isHidden: false,
      createdAt: new Date('2026-08-20T10:00:00.000Z'),
      updatedAt: new Date('2026-08-20T10:00:00.000Z'),
      replyCount: 0,
      blog: { id: 'blog-1', title: 'A Post', slug: 'a-post' },
    },
  ] as never);

  follows.getCounts.mockResolvedValue({ followers: 42, following: 11 });
  follows.getFollowers.mockResolvedValue({
    items: [
      {
        id: 'dora',
        username: 'dora',
        name: 'Dora',
        avatar: null,
        bio: null,
        isVerified: false,
        followedAt: new Date('2026-08-20T11:00:00.000Z'),
      },
    ],
    nextCursor: null,
    hasNextPage: false,
    totalCount: 42,
  } as never);

  notifications.unreadCount.mockResolvedValue({ unreadCount: 5 });
  notifications.list.mockResolvedValue({
    items: [
      {
        id: 'n1',
        type: 'FOLLOW',
        actor: {
          id: 'dora',
          username: 'dora',
          name: 'Dora',
          avatar: null,
          isVerified: false,
        },
        entityType: 'USER',
        entityId: 'dora',
        metadata: null,
        isRead: false,
        readAt: null,
        createdAt: new Date('2026-08-20T11:00:00.000Z'),
      },
    ],
    nextCursor: null,
    hasNextPage: false,
    totalCount: 1,
    unreadCount: 5,
  } as never);
});

const overviewQuery = (sections = [...DASHBOARD_SECTIONS]) => ({
  range: '30d' as const,
  sections,
});

describe('overview composition', () => {
  it('returns every section when none are named', async () => {
    const result = await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);

    for (const key of DASHBOARD_SECTIONS) {
      expect(result.overview).toHaveProperty(key);
      expect(result.overview[key]).not.toBeNull();
    }
    expect(result.degradedSections).toEqual([]);
  });

  it('omits sections that were not requested', async () => {
    const result = await dashboardService.getOverview(
      ALICE,
      overviewQuery(['stats', 'drafts']),
      FIXED_NOW
    );

    // Absent, not null: "you did not ask for this" is a different fact from
    // "this failed to load".
    expect(result.overview).toHaveProperty('stats');
    expect(result.overview).toHaveProperty('drafts');
    expect(result.overview).not.toHaveProperty('activity');
    expect(result.overview).not.toHaveProperty('topContent');
  });

  it('builds sections in a canonical order whatever order was asked for', async () => {
    const forwards = await dashboardService.getOverview(
      ALICE,
      overviewQuery(['drafts', 'stats']),
      FIXED_NOW
    );
    expect(forwards.sections).toEqual(['stats', 'drafts']);
  });

  it('echoes the resolved range', async () => {
    const result = await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);

    expect(result.range).toMatchObject({
      preset: '30d',
      startDate: '2026-08-14',
      endDate: '2026-08-20',
    });
    expect(result.overview.range).toEqual(result.range);
  });
});

describe('stats', () => {
  it('counts content live from Blog, and engagement from Analytics', async () => {
    const { stats } = await dashboardService.getStats(ALICE, { range: '30d' }, FIXED_NOW);

    // Counts with a live source are read from it, so they agree with the panels
    // that list the same rows. The analytics overview also returns blog counts,
    // but behind a cache only its flush worker invalidates — a draft saved
    // moments ago would be missing from the counter while the drafts panel
    // beside it already showed it.
    expect(blogs.countBlogsByStatus).toHaveBeenCalledWith('alice');
    expect(stats.content).toEqual({ total: 10, published: 6, drafts: 3, archived: 1 });

    // Figures that cannot be reconstructed live still come from Analytics.
    expect(stats.engagement.views).toBe(500);
    expect(stats.engagement.netBookmarks).toBe(15);
  });

  it('excludes soft-deleted blogs from the total', async () => {
    const { stats } = await dashboardService.getStats(ALICE, { range: '30d' }, FIXED_NOW);

    // DELETED is 2 in the fixture. A "total blogs" that counts the trash is a
    // number the author cannot reconcile against anything they can see.
    expect(stats.content.total).toBe(10);
  });

  it('preserves null reading rates instead of defaulting them to zero', async () => {
    analytics.getUserOverview.mockResolvedValue({
      ...ANALYTICS_OVERVIEW,
      reading: {
        readStarts: 0,
        readCompletions: 0,
        averageReadingSeconds: null,
        totalReadingSeconds: 0,
        completionRate: null,
        readThroughRate: null,
      },
    } as never);

    const { stats } = await dashboardService.getStats(ALICE, { range: '30d' }, FIXED_NOW);

    // "Nobody has opened this yet" must not render as "0% of readers finish it".
    expect(stats.engagement.reading.completionRate).toBeNull();
    expect(stats.engagement.reading.averageSeconds).toBeNull();
    expect(stats.engagement.reading.starts).toBe(0);
  });
});

describe('shared reads', () => {
  it('fetches an overlapping upstream read once per request', async () => {
    await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);

    // `stats` and `audience` both need these; the per-request memo collapses
    // them. Without it, every added panel multiplies the same query.
    expect(analytics.getUserOverview).toHaveBeenCalledTimes(1);
    expect(follows.getCounts).toHaveBeenCalledTimes(1);
    expect(bookmarks.getUserBookmarks).toHaveBeenCalledTimes(1);
    expect(blogs.countBlogsByStatus).toHaveBeenCalledTimes(1);
  });

  it('does not fetch what an unrequested section would have needed', async () => {
    await dashboardService.getOverview(ALICE, overviewQuery(['drafts']), FIXED_NOW);

    expect(analytics.getUserOverview).not.toHaveBeenCalled();
    expect(follows.getCounts).not.toHaveBeenCalled();
    expect(notifications.list).not.toHaveBeenCalled();
    expect(blogs.countBlogsByStatus).not.toHaveBeenCalled();
  });
});

describe('section isolation', () => {
  it('nulls a failed section and keeps the rest', async () => {
    notifications.list.mockRejectedValue(new Error('notifications down'));

    const result = await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);

    expect(result.overview.notifications).toBeNull();
    expect(result.degradedSections).toEqual(['notifications']);
    // Everything else still loaded — one subsystem does not blank the page.
    expect(result.overview.drafts).not.toBeNull();
    expect(result.overview.stats).not.toBeNull();
  });

  it('degrades every section that depended on a failed shared read', async () => {
    analytics.getUserOverview.mockRejectedValue(new Error('analytics down'));

    const result = await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);

    expect(result.degradedSections).toEqual(
      expect.arrayContaining(['stats', 'audience'])
    );
    expect(result.overview.drafts).not.toBeNull();
    expect(result.overview.bookmarks).not.toBeNull();
  });

  it('refuses to cache a degraded response', async () => {
    notifications.list.mockRejectedValue(new Error('notifications down'));

    await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);

    const overviewCall = cacheCalls.find((call) => call.scope === 'overview');
    // A two-second blip must not become a minute of empty panels.
    expect(overviewCall?.cacheable).toBe(false);
  });

  it('caches a healthy response', async () => {
    await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);
    expect(cacheCalls.find((call) => call.scope === 'overview')?.cacheable).toBe(true);
  });
});

describe('empty dashboard', () => {
  beforeEach(() => {
    analytics.getUserOverview.mockResolvedValue({
      ...ANALYTICS_OVERVIEW,
      totalBlogs: 0,
      publishedBlogs: 0,
      draftBlogs: 0,
      followers: 0,
      views: 0,
      uniqueReaderDays: 0,
      bookmarks: 0,
      netBookmarks: 0,
      comments: 0,
      followersGained: 0,
      followersLost: 0,
      reading: {
        readStarts: 0,
        readCompletions: 0,
        averageReadingSeconds: null,
        totalReadingSeconds: 0,
        completionRate: null,
        readThroughRate: null,
      },
    } as never);
    analytics.getUserTopBlogs.mockResolvedValue({
      range: {} as never,
      metric: 'views',
      items: [],
      nextCursor: null,
      hasNextPage: false,
    } as never);
    blogs.countBlogsByStatus.mockResolvedValue({
      DRAFT: 0,
      PUBLISHED: 0,
      ARCHIVED: 0,
      DELETED: 0,
    } as never);
    blogs.listMyBlogs.mockResolvedValue([] as never);
    blogs.getMyBlogCards.mockResolvedValue(new Map() as never);
    bookmarks.getUserBookmarks.mockResolvedValue({
      items: [],
      nextCursor: null,
      hasNextPage: false,
      totalCount: 0,
    } as never);
    comments.getReceivedComments.mockResolvedValue([] as never);
    follows.getCounts.mockResolvedValue({ followers: 0, following: 0 });
    follows.getFollowers.mockResolvedValue({
      items: [],
      nextCursor: null,
      hasNextPage: false,
      totalCount: 0,
    } as never);
    notifications.unreadCount.mockResolvedValue({ unreadCount: 0 });
    notifications.list.mockResolvedValue({
      items: [],
      nextCursor: null,
      hasNextPage: false,
      totalCount: 0,
      unreadCount: 0,
    } as never);
  });

  it('returns empty collections and zeros, never nulls', async () => {
    const result = await dashboardService.getOverview(ALICE, overviewQuery(), FIXED_NOW);

    // Every section present and non-null: a brand-new author has an EMPTY
    // dashboard, not a broken one.
    expect(result.degradedSections).toEqual([]);
    expect(result.overview.recentBlogs).toEqual([]);
    expect(result.overview.drafts).toEqual([]);
    expect(result.overview.topContent).toEqual([]);
    expect(result.overview.activity).toEqual([]);
    expect(result.overview.bookmarks).toEqual({ total: 0, items: [] });
    expect(result.overview.stats?.content.total).toBe(0);
    expect(result.overview.audience).toEqual({
      followers: 0,
      following: 0,
      growth: { gained: 0, lost: 0, net: 0 },
    });
  });
});

describe('user isolation', () => {
  it('passes the requester\'s own id to every collaborator', async () => {
    await dashboardService.getOverview(BOB, overviewQuery(), FIXED_NOW);

    expect(analytics.getUserOverview).toHaveBeenCalledWith(BOB, expect.anything());
    expect(follows.getCounts).toHaveBeenCalledWith('bob');
    expect(comments.getReceivedComments).toHaveBeenCalledWith('bob', expect.anything());
    expect(notifications.list).toHaveBeenCalledWith('bob', expect.anything());
    expect(blogs.listMyBlogs).toHaveBeenCalledWith('bob', expect.anything());
    expect(blogs.countBlogsByStatus).toHaveBeenCalledWith('bob');
    expect(bookmarks.getUserBookmarks).toHaveBeenCalledWith(
      'bob',
      expect.anything(),
      'USER'
    );
  });

  it('keys the cache by the requester', async () => {
    await dashboardService.getOverview(BOB, overviewQuery(), FIXED_NOW);
    expect(cacheCalls.every((call) => call.userId === 'bob')).toBe(true);
  });
});

describe('top content', () => {
  it('hydrates ranked ids with blog cards in one batched call', async () => {
    const result = await dashboardService.getTopContent(
      ALICE,
      { range: '30d', metric: 'views', limit: 5 },
      FIXED_NOW
    );

    expect(blogs.getMyBlogCards).toHaveBeenCalledTimes(1);
    expect(blogs.getMyBlogCards).toHaveBeenCalledWith('alice', ['blog-1']);
    expect(result.items[0]?.blog.title).toBe('A Post');
    expect(result.items[0]?.views).toBe(200);
  });

  it('drops a ranked row whose blog no longer exists', async () => {
    blogs.getMyBlogCards.mockResolvedValue(new Map() as never);

    const result = await dashboardService.getTopContent(
      ALICE,
      { range: '30d', metric: 'views', limit: 5 },
      FIXED_NOW
    );

    // A "top post" the author cannot open is worse than a shorter list.
    expect(result.items).toEqual([]);
  });

  it('passes the Analytics cursor through untouched', async () => {
    const result = await dashboardService.getTopContent(
      ALICE,
      { range: '30d', metric: 'views', limit: 5 },
      FIXED_NOW
    );

    // Re-deriving it from the hydrated list would make the next page repeat a
    // row that was dropped above.
    expect(result.nextCursor).toBe('CURSOR');
    expect(result.hasNextPage).toBe(true);
  });

  it('forwards the requested ranking metric to Analytics', async () => {
    await dashboardService.getTopContent(
      ALICE,
      { range: '30d', metric: 'comments', limit: 5 },
      FIXED_NOW
    );

    expect(analytics.getUserTopBlogs).toHaveBeenCalledWith(
      ALICE,
      expect.objectContaining({ metric: 'comments' })
    );
  });
});

describe('charts', () => {
  it('returns only the requested series', async () => {
    const charts = await dashboardService.getCharts(
      ALICE,
      { range: '7d', series: ['views'] },
      FIXED_NOW
    );

    expect(charts.views).toBeDefined();
    expect(charts.engagement).toBeUndefined();
    expect(charts.followers).toBeUndefined();
    expect(analytics.getUserEngagement).not.toHaveBeenCalled();
  });

  it('fills every bucket in the range, not just the ones with data', async () => {
    const charts = await dashboardService.getCharts(
      ALICE,
      { range: '7d', series: ['views'] },
      FIXED_NOW
    );

    // The window is 2026-08-14..2026-08-20 and Analytics returned one point.
    expect(charts.views?.points).toHaveLength(7);
    expect(charts.views?.points[0]).toEqual({
      date: '2026-08-14',
      views: 0,
      uniqueReaderDays: 0,
      uniqueViews: 0,
    });
    expect(charts.views?.points.at(-1)).toEqual({
      date: '2026-08-20',
      views: 12,
      uniqueReaderDays: 9,
      uniqueViews: 9,
    });
  });

  it('carries the live follower total alongside the growth series', async () => {
    const charts = await dashboardService.getCharts(
      ALICE,
      { range: '7d', series: ['followers'] },
      FIXED_NOW
    );

    expect(charts.followers?.current).toBe(42);
    expect(charts.followers?.points).toHaveLength(7);
  });

  it('fetches several series concurrently in one request', async () => {
    await dashboardService.getCharts(
      ALICE,
      { range: '7d', series: ['views', 'engagement', 'followers'] },
      FIXED_NOW
    );

    expect(analytics.getUserViews).toHaveBeenCalledTimes(1);
    expect(analytics.getUserEngagement).toHaveBeenCalledTimes(1);
    expect(analytics.getUserFollowers).toHaveBeenCalledTimes(1);
  });

  it('propagates an Analytics failure rather than drawing an empty chart', async () => {
    analytics.getUserViews.mockRejectedValue(new Error('range too large'));

    await expect(
      dashboardService.getCharts(ALICE, { range: '7d', series: ['views'] }, FIXED_NOW)
    ).rejects.toThrow('range too large');
  });
});

describe('drafts and activity', () => {
  it('asks Blog for drafts ordered by last edit, and pages with its cursor', async () => {
    const result = await dashboardService.getDrafts(ALICE, { limit: 20 });

    expect(blogs.getMyDrafts).toHaveBeenCalledWith('alice', { limit: 20 }, 'updated');
    expect(result.items[0]?.id).toBe('blog-1');
    expect(result.totalCount).toBe(1);
  });

  it('merges activity from all three sources', async () => {
    const result = await dashboardService.getActivity(ALICE, { limit: 20 }, FIXED_NOW);

    expect(result.items.map((row) => row.type)).toEqual([
      'FOLLOWER_GAINED', // 11:00
      'COMMENT_RECEIVED', // 10:00
      'BLOG_PUBLISHED', // 2026-08-19
    ]);
  });

  it('bounds the comments-received read by a lookback window', async () => {
    await dashboardService.getActivity(ALICE, { limit: 20 }, FIXED_NOW);

    const [, options] = comments.getReceivedComments.mock.calls[0]!;
    expect(options.since).toBeInstanceOf(Date);
    expect(options.since.getTime()).toBeLessThan(FIXED_NOW.getTime());
    expect(options.limit).toBe(20);
  });

  it('does not compute a follow annotation no activity row renders', async () => {
    await dashboardService.getActivity(ALICE, { limit: 20 }, FIXED_NOW);
    expect(follows.getFollowers).toHaveBeenCalledWith('alice', { limit: 20 });
  });
});
