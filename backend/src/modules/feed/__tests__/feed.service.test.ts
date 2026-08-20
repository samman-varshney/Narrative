import { analyticsService } from '../../analytics/analytics.service';
import { bookmarkService } from '../../bookmark/bookmark.service';
import { commentService } from '../../comment/comment.service';
import { followService } from '../../follow/follow.service';
import { feedRepository } from '../feed.repository';
import { feedService } from '../feed.service';
import { clearFeedKeys } from './helpers';
import type { FeedBlogRow } from '../feed.types';

/**
 * Composition tests: the collaborators are mocked, so what is under test is how
 * the service ORCHESTRATES them — which queries it issues, how many times, in
 * what order, and what it does when one of them fails.
 *
 * The things asserted here are invisible to the database suite (which sees only
 * results) and to the route suite (which sees only envelopes): the absence of an
 * N+1, the reuse of a ranked snapshot across pages, and the cache decisions that
 * keep a viewer-conditional page out of a shared entry.
 *
 * Redis is real — snapshot and page caching are the behaviour under test, and
 * mocking them would leave the tests asserting the mock.
 */

jest.mock('../feed.repository');
jest.mock('../../analytics/analytics.service');
jest.mock('../../comment/comment.service');
jest.mock('../../bookmark/bookmark.service');
jest.mock('../../follow/follow.service');

const repository = feedRepository as jest.Mocked<typeof feedRepository>;
const analytics = analyticsService as jest.Mocked<typeof analyticsService>;
const comments = commentService as jest.Mocked<typeof commentService>;
const bookmarks = bookmarkService as jest.Mocked<typeof bookmarkService>;
const follows = followService as jest.Mocked<typeof followService>;

const PUBLISHED = new Date('2026-06-01T00:00:00Z');

const row = (id: string, overrides: Partial<FeedBlogRow> = {}): FeedBlogRow => ({
  id,
  title: `Blog ${id}`,
  slug: id,
  subtitle: null,
  coverImage: null,
  readingTimeMinutes: 5,
  publishedAt: PUBLISHED,
  sortAt: PUBLISHED,
  authorId: 'author-1',
  authorUsername: 'grace',
  authorName: 'Grace',
  authorAvatar: null,
  authorVerified: false,
  ...overrides,
});

const ROWS = [row('b1'), row('b2', { authorId: 'author-2' }), row('b3')];

/** One row of an Analytics engagement ranking. */
const engagementRow = (blogId: string, engagementScore: number) => ({
  blogId,
  views: 0,
  uniqueReaderDays: 0,
  readCompletions: 0,
  netBookmarks: 0,
  comments: 0,
  engagementScore,
});

beforeEach(async () => {
  jest.clearAllMocks();
  await clearFeedKeys();

  repository.findChronologicalPage.mockResolvedValue(ROWS);
  repository.findRecentCandidates.mockResolvedValue(ROWS);
  repository.findEligibleByIds.mockImplementation(async ({ ids }) =>
    ROWS.filter((candidate) => ids.includes(candidate.id))
  );
  repository.loadTaxonomy.mockResolvedValue({ tags: new Map(), categories: new Map() });

  analytics.buildEngagementWindow.mockImplementation(({ weights, now }) => ({
    startDate: new Date('2026-05-25T00:00:00Z'),
    endDate: now ?? new Date('2026-06-01T00:00:00Z'),
    weights,
  }));
  analytics.getEngagementRanking.mockResolvedValue([]);
  analytics.getEngagementForBlogs.mockResolvedValue(new Map());

  comments.getCommentCounts.mockResolvedValue(new Map([['b1', 4]]));
  bookmarks.getBookmarkCounts.mockResolvedValue(new Map([['b1', 2]]));
  follows.followedAuthorIdsSql.mockReturnValue({ sql: 'FOLLOW_SCOPE', values: [] } as never);
  follows.getFollowedSubset.mockResolvedValue(new Set());
});

afterAll(async () => {
  await clearFeedKeys();
});

describe('hydration', () => {
  it('loads taxonomy and both counts once per page, never per item', async () => {
    const page = await feedService.getLatestFeed({ limit: 20 });

    expect(page.items).toHaveLength(3);
    expect(repository.loadTaxonomy).toHaveBeenCalledTimes(1);
    expect(comments.getCommentCounts).toHaveBeenCalledTimes(1);
    expect(bookmarks.getBookmarkCounts).toHaveBeenCalledTimes(1);
    expect(comments.getCommentCounts).toHaveBeenCalledWith(['b1', 'b2', 'b3']);
  });

  it('treats a missing count as zero rather than omitting the field', async () => {
    const page = await feedService.getLatestFeed({ limit: 20 });

    expect(page.items[0]!.engagement).toEqual({ comments: 4, bookmarks: 2 });
    expect(page.items[1]!.engagement).toEqual({ comments: 0, bookmarks: 0 });
  });

  it('degrades to zero counts rather than failing the feed', async () => {
    comments.getCommentCounts.mockRejectedValue(new Error('comment module down'));
    bookmarks.getBookmarkCounts.mockRejectedValue(new Error('bookmark module down'));

    const page = await feedService.getLatestFeed({ limit: 20 });

    expect(page.items).toHaveLength(3);
    expect(page.items[0]!.engagement).toEqual({ comments: 0, bookmarks: 0 });
  });

  it('hydrates nothing for an empty page', async () => {
    repository.findChronologicalPage.mockResolvedValue([]);

    const page = await feedService.getLatestFeed({ limit: 20 });

    expect(page.items).toEqual([]);
    expect(repository.loadTaxonomy).not.toHaveBeenCalled();
    expect(comments.getCommentCounts).not.toHaveBeenCalled();
  });

  it('does not hydrate the sentinel row fetched to detect the next page', async () => {
    repository.findChronologicalPage.mockResolvedValue([row('a'), row('b'), row('c')]);

    const page = await feedService.getLatestFeed({ limit: 2 });

    expect(page.hasMore).toBe(true);
    expect(repository.loadTaxonomy).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('following feed', () => {
  it('scopes the query to the follow graph through the Follow module', async () => {
    await feedService.getFollowingFeed('viewer-1', { limit: 20 });

    expect(follows.followedAuthorIdsSql).toHaveBeenCalledWith('viewer-1');
    expect(repository.findChronologicalPage).toHaveBeenCalledWith(
      expect.objectContaining({
        authorScope: expect.objectContaining({ sql: 'FOLLOW_SCOPE' }),
      })
    );
  });

  it('caches the first unfiltered page per viewer', async () => {
    await feedService.getFollowingFeed('viewer-1', { limit: 20 });
    await feedService.getFollowingFeed('viewer-1', { limit: 20 });

    expect(repository.findChronologicalPage).toHaveBeenCalledTimes(1);
  });

  it('keeps one viewer out of another viewer\u2019s cached page', async () => {
    await feedService.getFollowingFeed('viewer-1', { limit: 20 });
    await feedService.getFollowingFeed('viewer-2', { limit: 20 });

    expect(repository.findChronologicalPage).toHaveBeenCalledTimes(2);
    expect(follows.followedAuthorIdsSql).toHaveBeenCalledWith('viewer-2');
  });

  it('does not cache a filtered feed, which would multiply the keyspace', async () => {
    await feedService.getFollowingFeed('viewer-1', { limit: 20, tag: ['react'] });
    await feedService.getFollowingFeed('viewer-1', { limit: 20, tag: ['react'] });

    expect(repository.findChronologicalPage).toHaveBeenCalledTimes(2);
  });

  it('drops the cached page on invalidation', async () => {
    await feedService.getFollowingFeed('viewer-1', { limit: 20 });
    await feedService.invalidateFollowingFeed('viewer-1');
    await feedService.getFollowingFeed('viewer-1', { limit: 20 });

    expect(repository.findChronologicalPage).toHaveBeenCalledTimes(2);
  });
});

describe('ranked snapshots', () => {
  it('builds a snapshot once and pages the rest of the walk from it', async () => {
    const first = await feedService.getExploreFeed({ limit: 2, excludeFollowing: false });
    expect(first.hasMore).toBe(true);

    await feedService.getExploreFeed({
      limit: 2,
      excludeFollowing: false,
      cursor: first.nextCursor!,
    });

    // One candidate retrieval for the whole walk — the second page read the
    // frozen ordering out of Redis rather than re-ranking.
    expect(repository.findRecentCandidates).toHaveBeenCalledTimes(1);
  });

  it('serves consecutive pages without overlap', async () => {
    const first = await feedService.getExploreFeed({ limit: 2, excludeFollowing: false });
    const second = await feedService.getExploreFeed({
      limit: 2,
      excludeFollowing: false,
      cursor: first.nextCursor!,
    });

    const firstIds = first.items.map((item) => item.id);
    const secondIds = second.items.map((item) => item.id);

    expect(firstIds).toHaveLength(2);
    expect(secondIds).toHaveLength(1);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect(second.hasMore).toBe(false);
  });

  it('rebuilds an evicted snapshot against the ranking clock the cursor carries', async () => {
    const first = await feedService.getExploreFeed({ limit: 2, excludeFollowing: false });
    const builtWith = analytics.buildEngagementWindow.mock.calls[0]![0].now;

    await clearFeedKeys(); // the snapshot expires mid-walk
    analytics.buildEngagementWindow.mockClear();

    const second = await feedService.getExploreFeed({
      limit: 2,
      excludeFollowing: false,
      cursor: first.nextCursor!,
    });

    // Same window bounds as the original build, so the rebuilt ordering is the
    // one the client is walking — not a fresh ranking against a moved clock.
    expect(analytics.buildEngagementWindow).toHaveBeenCalledWith(
      expect.objectContaining({ now: builtWith })
    );
    // Ranking ties break on descending id, so the walk is b3, b2, then b1.
    expect(second.items.map((item) => item.id)).toEqual(['b1']);
  });

  it('skips candidates that went ineligible after the snapshot was built', async () => {
    // A snapshot outlives the content it references: a post archived since it
    // was built must vanish from the page rather than 404 the reader who clicks
    // it. `g*` are the withdrawn ones. Ties break on descending id, so the
    // surviving order is b3, b2, b1.
    const wide = [row('g1'), row('b1'), row('g2'), row('b2'), row('b3')];
    repository.findRecentCandidates.mockResolvedValue(wide);
    repository.findEligibleByIds.mockImplementation(async ({ ids }) =>
      wide.filter((candidate) => ids.includes(candidate.id) && !candidate.id.startsWith('g'))
    );

    const first = await feedService.getExploreFeed({ limit: 2, excludeFollowing: false });
    expect(first.items.map((item) => item.id)).toEqual(['b3', 'b2']);

    // And the offset accounting survives the skips: page 2 resumes after the
    // last item PLACED, not after the last id inspected, so nothing is lost in
    // the gap the withdrawn posts left behind.
    const second = await feedService.getExploreFeed({
      limit: 2,
      excludeFollowing: false,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual(['b1']);
  });

  it('re-checks every Analytics-suggested candidate through the shared eligibility query', async () => {
    // Analytics knows nothing about blog lifecycle — an archived or withdrawn
    // post still has yesterday's engagement rows. Every id it suggests goes back
    // through the SAME query as every other feed, so there is exactly one place
    // where "may this be seen" is decided. Here `withdrawn` no longer passes it.
    analytics.getEngagementRanking.mockResolvedValue([
      engagementRow('withdrawn', 900),
      engagementRow('b1', 100),
    ]);

    const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });

    expect(repository.findEligibleByIds).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['withdrawn', 'b1'] })
    );
    expect(page.items.map((item) => item.id)).toEqual(['b1']);
  });
});

describe('explore personalization', () => {
  it('filters followed authors out through the Follow module when opted in', async () => {
    follows.getFollowedSubset.mockResolvedValue(new Set(['author-1']));

    const page = await feedService.getExploreFeed(
      { limit: 20, excludeFollowing: true },
      'viewer-1'
    );

    expect(follows.getFollowedSubset).toHaveBeenCalledWith('viewer-1', expect.any(Array));
    expect(page.items.map((item) => item.id)).toEqual(['b2']);
  });

  it('never serves a viewer-filtered page from the shared cache', async () => {
    follows.getFollowedSubset.mockResolvedValue(new Set(['author-1']));
    await feedService.getExploreFeed({ limit: 20, excludeFollowing: true }, 'viewer-1');

    follows.getFollowedSubset.mockResolvedValue(new Set());
    const shared = await feedService.getExploreFeed({ limit: 20, excludeFollowing: false });

    // The filtered request must not have written the entry the shared one reads.
    expect(shared.items.map((item) => item.id)).toEqual(['b3', 'b2', 'b1']);
  });

  it('ignores the opt-in without a viewer, rather than calling the follow graph', async () => {
    await feedService.getExploreFeed({ limit: 20, excludeFollowing: true });
    expect(follows.getFollowedSubset).not.toHaveBeenCalled();
  });
});

describe('trending composition', () => {
  it('asks Analytics for the ranking and never aggregates engagement itself', async () => {
    analytics.getEngagementRanking.mockResolvedValue([
      engagementRow('b2', 900),
      engagementRow('b1', 10),
    ]);

    const page = await feedService.getTrendingFeed({ limit: 20, window: '24h' });

    expect(analytics.buildEngagementWindow).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 1 })
    );
    expect(page.items.map((item) => item.id)).toEqual(['b2', 'b1']);
    expect(repository.findRecentCandidates).not.toHaveBeenCalled();
  });

  it('never publishes an analytics figure or a ranking score on a card', async () => {
    analytics.getEngagementRanking.mockResolvedValue([
      {
        blogId: 'b1',
        views: 9999,
        uniqueReaderDays: 8888,
        readCompletions: 777,
        netBookmarks: 66,
        comments: 5,
        engagementScore: 1234,
      },
    ]);

    const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });
    const item = page.items[0]!;

    expect(item).not.toHaveProperty('score');
    expect(item).not.toHaveProperty('views');
    expect(item.engagement).toEqual({ comments: 4, bookmarks: 2 });
  });

  it('short-circuits when nothing has engagement in the window', async () => {
    analytics.getEngagementRanking.mockResolvedValue([]);

    const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });

    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
    expect(repository.findEligibleByIds).not.toHaveBeenCalled();
  });
});
