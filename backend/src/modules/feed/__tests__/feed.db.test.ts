import {
  categorizeBlog,
  disconnectDb,
  makeBlog,
  makeBookmark,
  makeCategory,
  makeFollow,
  makeTag,
  makeUser,
  resetDb,
  tagBlog,
} from '../../../test/db';
import { prisma } from '../../../core/database/prisma';
import { clearFeedKeys, daysAgoLabel, makeAnalyticsDay, makeComment } from './helpers';
import { FEED_CACHE_SCOPES } from '../feed.cache';
import { feedService } from '../feed.service';
import { MAX_FEED_LIMIT } from '../feed.config';
import type { FeedItem, FeedPage } from '../feed.types';

/**
 * Real-SQL tests for the Feed module.
 *
 * Nothing here can be established with a mocked Prisma delegate. Eligibility is
 * enforced by literal predicates inside the query text; keyset pagination over a
 * (publishedAt, id) tuple is exactly the kind of thing that looks right and
 * walks wrong; and ranked pagination walks a Redis snapshot whose stability is
 * the whole claim. These run against the local test database and the test Redis.
 *
 * A note on the fixtures: `publishedAt` is always explicit. The ordering under
 * test IS publication time, so leaving it to a default would make the assertions
 * depend on insertion order — which is precisely the accident the id tiebreak
 * exists to survive.
 */

const day = (n: number) => new Date(`2026-03-${String(n).padStart(2, '0')}T00:00:00Z`);
const slugs = (page: FeedPage) => page.items.map((item) => item.slug);

/** Walks a feed to exhaustion, returning every slug in the order served. */
async function walk(
  fetch: (cursor?: string) => Promise<FeedPage>,
  { limit = 2, maxPages = 20 } = {}
): Promise<{ order: string[]; pages: number }> {
  const order: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page: FeedPage = await fetch(cursor);
    order.push(...slugs(page));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > maxPages) throw new Error('feed walk did not terminate');
  } while (cursor);

  void limit;
  return { order, pages };
}

describe('Feed module (real database)', () => {
  let grace: Awaited<ReturnType<typeof makeUser>>;
  let alan: Awaited<ReturnType<typeof makeUser>>;
  let reader: Awaited<ReturnType<typeof makeUser>>;
  let suspended: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await clearFeedKeys();

    grace = await makeUser({ username: 'gracehopper', name: 'Grace Hopper' });
    alan = await makeUser({ username: 'alanturing', name: 'Alan Turing' });
    reader = await makeUser({ username: 'reader', name: 'Reader' });
    suspended = await makeUser({ username: 'ghost', name: 'Ghost', status: 'SUSPENDED' });
  });

  afterAll(async () => {
    await clearFeedKeys();
    await disconnectDb();
  });

  // -------------------------------------------------------------------------
  // Content eligibility — the rules every feed shares
  // -------------------------------------------------------------------------

  describe('content eligibility', () => {
    beforeEach(async () => {
      await makeBlog(grace.id, { slug: 'public-published', publishedAt: day(10) });
      await makeBlog(grace.id, { slug: 'draft', status: 'DRAFT' });
      await makeBlog(grace.id, { slug: 'archived', status: 'ARCHIVED', publishedAt: day(9) });
      await makeBlog(grace.id, { slug: 'deleted', status: 'DELETED', publishedAt: day(8) });
      await makeBlog(grace.id, { slug: 'private', visibility: 'PRIVATE', publishedAt: day(7) });
      await makeBlog(grace.id, { slug: 'unlisted', visibility: 'UNLISTED', publishedAt: day(6) });
      await makeBlog(grace.id, {
        slug: 'members-only',
        visibility: 'MEMBERS_ONLY',
        publishedAt: day(5),
      });
      await makeBlog(suspended.id, { slug: 'by-suspended', publishedAt: day(11) });
      await makeBlog(grace.id, { slug: 'no-published-at', publishedAt: null });
    });

    it('surfaces only published, public content by active authors in Latest', async () => {
      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(slugs(page)).toEqual(['public-published']);
    });

    it('never surfaces UNLISTED content, which is reachable by link but not advertised', async () => {
      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(slugs(page)).not.toContain('unlisted');
    });

    it('excludes a published blog with no publication instant', async () => {
      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(slugs(page)).not.toContain('no-published-at');
    });

    it('applies the same rules to Explore', async () => {
      const page = await feedService.getExploreFeed({ limit: 20, excludeFollowing: false });
      expect(slugs(page)).toEqual(['public-published']);
    });

    it('applies exactly the same rules to the Following feed', async () => {
      await makeFollow(reader.id, grace.id);
      await makeFollow(reader.id, suspended.id);

      const page = await feedService.getFollowingFeed(reader.id, { limit: 20 });

      // Being authenticated widens WHO is asking, not WHAT is discoverable.
      // MEMBERS_ONLY stays out even though `canView` would grant it to any
      // signed-in reader — that grant is a placeholder for a real membership
      // check, and a feed must not advertise gated content on the strength of it.
      expect(slugs(page)).toEqual(['public-published']);
      expect(slugs(page)).not.toContain('members-only');
      expect(slugs(page)).not.toContain('by-suspended');
    });

    it('never leaks a suspended author into a public feed', async () => {
      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(slugs(page)).not.toContain('by-suspended');
    });
  });

  // -------------------------------------------------------------------------
  // Following feed
  // -------------------------------------------------------------------------

  describe('following feed', () => {
    beforeEach(async () => {
      await makeBlog(grace.id, { slug: 'grace-new', publishedAt: day(20) });
      await makeBlog(grace.id, { slug: 'grace-old', publishedAt: day(10) });
      await makeBlog(alan.id, { slug: 'alan-mid', publishedAt: day(15) });
      await makeFollow(reader.id, grace.id);
    });

    it('contains only content from followed authors', async () => {
      const page = await feedService.getFollowingFeed(reader.id, { limit: 20 });
      expect(slugs(page)).toEqual(['grace-new', 'grace-old']);
    });

    it('picks up a new follow', async () => {
      await makeFollow(reader.id, alan.id);
      await feedService.invalidateFollowingFeed(reader.id);

      const page = await feedService.getFollowingFeed(reader.id, { limit: 20 });
      expect(slugs(page)).toEqual(['grace-new', 'alan-mid', 'grace-old']);
    });

    it('is empty for a viewer who follows nobody', async () => {
      const page = await feedService.getFollowingFeed(alan.id, { limit: 20 });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
      expect(page.hasMore).toBe(false);
    });

    it('is scoped to the viewer — two viewers see different feeds', async () => {
      await makeFollow(alan.id, alan.id).catch(() => undefined);
      const readerFeed = await feedService.getFollowingFeed(reader.id, { limit: 20 });
      const otherFeed = await feedService.getFollowingFeed(grace.id, { limit: 20 });

      expect(slugs(readerFeed)).not.toEqual(slugs(otherFeed));
      expect(otherFeed.items).toEqual([]);
    });

    it('orders newest first', async () => {
      await makeFollow(reader.id, alan.id);
      await feedService.invalidateFollowingFeed(reader.id);

      const page = await feedService.getFollowingFeed(reader.id, { limit: 20 });
      expect(slugs(page)).toEqual(['grace-new', 'alan-mid', 'grace-old']);
    });

    it('paginates without duplicates or gaps', async () => {
      await makeFollow(reader.id, alan.id);

      const { order } = await walk((cursor) =>
        feedService.getFollowingFeed(reader.id, { limit: 1, ...(cursor ? { cursor } : {}) })
      );

      expect(order).toEqual(['grace-new', 'alan-mid', 'grace-old']);
      expect(new Set(order).size).toBe(order.length);
    });

    it('stays correct for a viewer following many authors', async () => {
      // The scale case the brief calls out: a semi-join, not an inlined id list.
      const authors = await Promise.all(
        Array.from({ length: 40 }, (_, i) => makeUser({ username: `bulk-author-${i}` }))
      );
      await Promise.all(authors.map((author) => makeFollow(alan.id, author.id)));
      await Promise.all(
        authors.map((author, i) =>
          makeBlog(author.id, { slug: `bulk-${i}`, publishedAt: new Date(2026, 0, i + 1) })
        )
      );

      const { order } = await walk(
        (cursor) =>
          feedService.getFollowingFeed(alan.id, { limit: 10, ...(cursor ? { cursor } : {}) }),
        { maxPages: 10 }
      );

      expect(order).toHaveLength(40);
      expect(new Set(order).size).toBe(40);
      // Newest first: bulk-39 was published last.
      expect(order[0]).toBe('bulk-39');
      expect(order[39]).toBe('bulk-0');
    });

    it('supports filtering', async () => {
      const react = await makeTag('react');
      const graceNew = await makeBlog(grace.id, { slug: 'grace-react', publishedAt: day(21) });
      await tagBlog(graceNew.id, react.id);

      const page = await feedService.getFollowingFeed(reader.id, { limit: 20, tag: ['react'] });
      expect(slugs(page)).toEqual(['grace-react']);
    });

    it('does not serve one viewer a cached page belonging to another', async () => {
      await feedService.getFollowingFeed(reader.id, { limit: 20 });
      const other = await feedService.getFollowingFeed(alan.id, { limit: 20 });
      expect(other.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Latest feed
  // -------------------------------------------------------------------------

  describe('latest feed', () => {
    beforeEach(async () => {
      await makeBlog(grace.id, { slug: 'third', publishedAt: day(3), readingTimeMinutes: 3 });
      await makeBlog(alan.id, { slug: 'first', publishedAt: day(1), readingTimeMinutes: 12 });
      await makeBlog(grace.id, { slug: 'second', publishedAt: day(2), readingTimeMinutes: 7 });
    });

    it('orders strictly newest first', async () => {
      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(slugs(page)).toEqual(['third', 'second', 'first']);
    });

    it('excludes MEMBERS_ONLY, as every feed does', async () => {
      await makeBlog(grace.id, { slug: 'members', visibility: 'MEMBERS_ONLY', publishedAt: day(4) });
      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(slugs(page)).not.toContain('members');
    });

    it('paginates without duplicates or gaps', async () => {
      const { order, pages } = await walk((cursor) =>
        feedService.getLatestFeed({ limit: 1, ...(cursor ? { cursor } : {}) })
      );

      expect(order).toEqual(['third', 'second', 'first']);
      expect(pages).toBe(3);
    });

    it('keeps a total order when publication times collide', async () => {
      // Same instant on purpose: without the id tiebreak the database is free to
      // order these differently on each page request, which is how a walk starts
      // repeating and skipping rows.
      const same = day(9);
      await Promise.all(
        ['tie-a', 'tie-b', 'tie-c'].map((slug) =>
          makeBlog(alan.id, { slug, publishedAt: same })
        )
      );

      const { order } = await walk(
        (cursor) => feedService.getLatestFeed({ limit: 1, ...(cursor ? { cursor } : {}) }),
        { maxPages: 12 }
      );

      const ties = order.filter((slug) => slug.startsWith('tie-'));
      expect(ties).toHaveLength(3);
      expect(new Set(ties).size).toBe(3);
    });

    it('reports hasMore honestly at the boundary', async () => {
      const exact = await feedService.getLatestFeed({ limit: 3 });
      expect(exact.items).toHaveLength(3);
      expect(exact.hasMore).toBe(false);
      expect(exact.nextCursor).toBeNull();

      const partial = await feedService.getLatestFeed({ limit: 2 });
      expect(partial.hasMore).toBe(true);
      expect(partial.nextCursor).not.toBeNull();
    });

    it('filters by tag', async () => {
      const react = await makeTag('react');
      const tagged = await makeBlog(grace.id, { slug: 'tagged', publishedAt: day(5) });
      await tagBlog(tagged.id, react.id);

      const page = await feedService.getLatestFeed({ limit: 20, tag: ['react'] });
      expect(slugs(page)).toEqual(['tagged']);
    });

    it('returns a blog carrying several requested tags exactly once', async () => {
      const react = await makeTag('react');
      const node = await makeTag('node');
      const both = await makeBlog(grace.id, { slug: 'both-tags', publishedAt: day(6) });
      await tagBlog(both.id, react.id);
      await tagBlog(both.id, node.id);

      const page = await feedService.getLatestFeed({ limit: 20, tag: ['react', 'node'] });
      expect(slugs(page)).toEqual(['both-tags']);
    });

    it('filters by category', async () => {
      const frontend = await makeCategory('Frontend');
      const blog = await makeBlog(alan.id, { slug: 'categorised', publishedAt: day(7) });
      await categorizeBlog(blog.id, frontend.id);

      const page = await feedService.getLatestFeed({ limit: 20, category: ['frontend'] });
      expect(slugs(page)).toEqual(['categorised']);
    });

    it('filters by author, case-insensitively', async () => {
      const page = await feedService.getLatestFeed({ limit: 20, author: 'GraceHopper' });
      expect(slugs(page)).toEqual(['third', 'second']);
    });

    it('filters by reading time', async () => {
      const page = await feedService.getLatestFeed({
        limit: 20,
        minReadingTime: 5,
        maxReadingTime: 10,
      });
      expect(slugs(page)).toEqual(['second']);
    });

    it('paginates correctly with a filter applied', async () => {
      const { order } = await walk((cursor) =>
        feedService.getLatestFeed({ limit: 1, author: 'gracehopper', ...(cursor ? { cursor } : {}) })
      );
      expect(order).toEqual(['third', 'second']);
    });

    it('serves a cached page until an event invalidates it', async () => {
      // The freshness contract: feeds are eventually consistent, and the domain
      // event is what makes "eventually" short. Both halves are asserted here
      // because a cache that never went stale would prove nothing about the
      // invalidation path, and one that never invalidated would look identical
      // to a broken one on a slow test.
      const first = await feedService.getLatestFeed({ limit: 20 });
      expect(slugs(first)).toEqual(['third', 'second', 'first']);

      await makeBlog(alan.id, { slug: 'just-published', publishedAt: day(28) });
      expect(slugs(await feedService.getLatestFeed({ limit: 20 }))).toEqual(slugs(first));

      await feedService.invalidateSharedFeeds(FEED_CACHE_SCOPES);
      expect(slugs(await feedService.getLatestFeed({ limit: 20 }))[0]).toBe('just-published');
    });

    it('accepts the maximum page size', async () => {
      const page = await feedService.getLatestFeed({ limit: MAX_FEED_LIMIT });
      expect(page.items).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Explore feed
  // -------------------------------------------------------------------------

  describe('explore feed', () => {
    it('surfaces brand-new content that has no engagement at all', async () => {
      await makeBlog(grace.id, { slug: 'fresh', publishedAt: new Date() });

      const page = await feedService.getExploreFeed({ limit: 20, excludeFollowing: false });
      expect(slugs(page)).toContain('fresh');
    });

    it('ranks an engaged post above an equally old one with no engagement', async () => {
      const quiet = await makeBlog(grace.id, { slug: 'quiet', publishedAt: daysAgoLabel(5) });
      const loved = await makeBlog(alan.id, { slug: 'loved', publishedAt: daysAgoLabel(5) });
      await makeAnalyticsDay(loved.id, alan.id, {
        views: 500,
        uniqueViews: 300,
        readCompletions: 100,
        bookmarks: 40,
        comments: 25,
      });
      void quiet;

      const page = await feedService.getExploreFeed({ limit: 20, excludeFollowing: false });
      expect(slugs(page).indexOf('loved')).toBeLessThan(slugs(page).indexOf('quiet'));
    });

    it('reaches past the newest posts for content people are reading', async () => {
      // The engagement candidate source: an older, well-received post is a
      // candidate even when plenty of newer posts exist.
      const older = await makeBlog(alan.id, { slug: 'older-gem', publishedAt: daysAgoLabel(10) });
      await makeAnalyticsDay(older.id, alan.id, {
        views: 900,
        uniqueViews: 700,
        readCompletions: 300,
        bookmarks: 90,
        comments: 60,
      });
      for (let i = 0; i < 5; i += 1) {
        await makeBlog(grace.id, { slug: `newer-${i}`, publishedAt: daysAgoLabel(1) });
      }

      const page = await feedService.getExploreFeed({ limit: 20, excludeFollowing: false });
      expect(slugs(page)).toContain('older-gem');
    });

    it('does not let one author own the head of the feed', async () => {
      // Six posts by one author, one by another, all equally fresh: the
      // diversity cap must interleave rather than serve six of the same voice.
      for (let i = 0; i < 6; i += 1) {
        await makeBlog(grace.id, { slug: `grace-${i}`, publishedAt: daysAgoLabel(1) });
      }
      await makeBlog(alan.id, { slug: 'alan-only', publishedAt: daysAgoLabel(2) });

      const page = await feedService.getExploreFeed({ limit: 3, excludeFollowing: false });
      const authors = page.items.map((item) => item.author.username);

      expect(authors.filter((u) => u === 'gracehopper')).toHaveLength(2);
      expect(authors).toContain('alanturing');
    });

    it('never surfaces an ineligible post, however engaged it is', async () => {
      const archived = await makeBlog(grace.id, {
        slug: 'archived-but-loved',
        status: 'ARCHIVED',
        publishedAt: daysAgoLabel(2),
      });
      await makeAnalyticsDay(archived.id, grace.id, {
        views: 5000,
        uniqueViews: 4000,
        bookmarks: 500,
        comments: 300,
      });
      await makeBlog(alan.id, { slug: 'ordinary', publishedAt: daysAgoLabel(2) });

      const page = await feedService.getExploreFeed({ limit: 20, excludeFollowing: false });
      expect(slugs(page)).toEqual(['ordinary']);
    });

    it('paginates a ranked feed without duplicates or gaps', async () => {
      for (let i = 0; i < 7; i += 1) {
        await makeBlog(i % 2 === 0 ? grace.id : alan.id, {
          slug: `ranked-${i}`,
          publishedAt: daysAgoLabel(i),
        });
      }

      const { order } = await walk(
        (cursor) =>
          feedService.getExploreFeed({ limit: 2, excludeFollowing: false, ...(cursor ? { cursor } : {}) }),
        { maxPages: 10 }
      );

      expect(order).toHaveLength(7);
      expect(new Set(order).size).toBe(7);
    });

    it('hides followed authors when the viewer opts in', async () => {
      await makeBlog(grace.id, { slug: 'from-followed', publishedAt: daysAgoLabel(1) });
      await makeBlog(alan.id, { slug: 'from-stranger', publishedAt: daysAgoLabel(2) });
      await makeFollow(reader.id, grace.id);

      const filtered = await feedService.getExploreFeed(
        { limit: 20, excludeFollowing: true },
        reader.id
      );
      expect(slugs(filtered)).toEqual(['from-stranger']);

      const unfiltered = await feedService.getExploreFeed(
        { limit: 20, excludeFollowing: false },
        reader.id
      );
      expect(slugs(unfiltered).sort()).toEqual(['from-followed', 'from-stranger']);
    });

    it('ignores the opt-in for an anonymous caller rather than failing', async () => {
      await makeBlog(grace.id, { slug: 'anon-visible', publishedAt: daysAgoLabel(1) });
      const page = await feedService.getExploreFeed({ limit: 20, excludeFollowing: true });
      expect(slugs(page)).toEqual(['anon-visible']);
    });

    it('applies filters to the ranked candidates', async () => {
      const react = await makeTag('react');
      const tagged = await makeBlog(grace.id, { slug: 'explore-react', publishedAt: daysAgoLabel(1) });
      await tagBlog(tagged.id, react.id);
      await makeBlog(alan.id, { slug: 'explore-other', publishedAt: daysAgoLabel(1) });

      const page = await feedService.getExploreFeed({
        limit: 20,
        excludeFollowing: false,
        tag: ['react'],
      });
      expect(slugs(page)).toEqual(['explore-react']);
    });

    it('returns an empty page rather than failing when nothing is eligible', async () => {
      const page = await feedService.getExploreFeed({ limit: 20, excludeFollowing: false });
      expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
    });
  });

  // -------------------------------------------------------------------------
  // Trending feed
  // -------------------------------------------------------------------------

  describe('trending feed', () => {
    it('contains only content with engagement in the window', async () => {
      const hot = await makeBlog(grace.id, { slug: 'hot', publishedAt: daysAgoLabel(1) });
      await makeBlog(alan.id, { slug: 'silent', publishedAt: daysAgoLabel(1) });
      await makeAnalyticsDay(hot.id, grace.id, { views: 200, comments: 10 });

      const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });
      expect(slugs(page)).toEqual(['hot']);
    });

    it('ranks by how much engagement, not merely whether there is any', async () => {
      const big = await makeBlog(grace.id, { slug: 'big', publishedAt: daysAgoLabel(1) });
      const small = await makeBlog(alan.id, { slug: 'small', publishedAt: daysAgoLabel(1) });
      await makeAnalyticsDay(big.id, grace.id, { views: 1000, comments: 50, bookmarks: 80 });
      await makeAnalyticsDay(small.id, alan.id, { views: 10 });

      const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });
      expect(slugs(page)).toEqual(['big', 'small']);
    });

    it('prefers the newer of two posts with identical engagement', async () => {
      const newer = await makeBlog(grace.id, { slug: 'newer', publishedAt: daysAgoLabel(0) });
      const older = await makeBlog(alan.id, { slug: 'older', publishedAt: daysAgoLabel(60) });
      await makeAnalyticsDay(newer.id, grace.id, { views: 100, comments: 5 });
      await makeAnalyticsDay(older.id, alan.id, { views: 100, comments: 5 });

      const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });
      expect(slugs(page)).toEqual(['newer', 'older']);
    });

    it('does not let historic engagement keep old content on the list', async () => {
      // The engagement half is windowed, so a post that was huge two months ago
      // and is quiet now simply is not a candidate.
      const past = await makeBlog(grace.id, { slug: 'yesterdays-hit', publishedAt: daysAgoLabel(60) });
      await makeAnalyticsDay(past.id, grace.id, {
        date: daysAgoLabel(45),
        views: 10_000,
        comments: 800,
        bookmarks: 900,
      });
      const now = await makeBlog(alan.id, { slug: 'todays-story', publishedAt: daysAgoLabel(1) });
      await makeAnalyticsDay(now.id, alan.id, { views: 20 });

      const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });
      expect(slugs(page)).toEqual(['todays-story']);
    });

    it('honours the requested window', async () => {
      const blog = await makeBlog(grace.id, { slug: 'ten-days-ago', publishedAt: daysAgoLabel(10) });
      await makeAnalyticsDay(blog.id, grace.id, { date: daysAgoLabel(10), views: 500, comments: 30 });

      expect(slugs(await feedService.getTrendingFeed({ limit: 20, window: '24h' }))).toEqual([]);
      expect(slugs(await feedService.getTrendingFeed({ limit: 20, window: '7d' }))).toEqual([]);
      expect(slugs(await feedService.getTrendingFeed({ limit: 20, window: '30d' }))).toEqual([
        'ten-days-ago',
      ]);
    });

    it('never surfaces an ineligible post that has engagement rows', async () => {
      const deleted = await makeBlog(grace.id, {
        slug: 'deleted-but-hot',
        status: 'DELETED',
        publishedAt: daysAgoLabel(1),
      });
      await makeAnalyticsDay(deleted.id, grace.id, { views: 9000, comments: 500 });

      const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });
      expect(slugs(page)).toEqual([]);
    });

    it('paginates without duplicates or gaps', async () => {
      for (let i = 0; i < 6; i += 1) {
        const blog = await makeBlog(i % 2 === 0 ? grace.id : alan.id, {
          slug: `trend-${i}`,
          publishedAt: daysAgoLabel(1),
        });
        await makeAnalyticsDay(blog.id, i % 2 === 0 ? grace.id : alan.id, {
          views: (6 - i) * 100,
        });
      }

      const { order } = await walk(
        (cursor) =>
          feedService.getTrendingFeed({ limit: 2, window: '7d', ...(cursor ? { cursor } : {}) }),
        { maxPages: 8 }
      );

      expect(order).toHaveLength(6);
      expect(new Set(order).size).toBe(6);
    });

    it('gives a stable ranking across repeated requests', async () => {
      for (let i = 0; i < 4; i += 1) {
        const blog = await makeBlog(grace.id, { slug: `stable-${i}`, publishedAt: daysAgoLabel(i) });
        await makeAnalyticsDay(blog.id, grace.id, { views: 100 });
      }

      const first = slugs(await feedService.getTrendingFeed({ limit: 4, window: '7d' }));
      const second = slugs(await feedService.getTrendingFeed({ limit: 4, window: '7d' }));
      expect(second).toEqual(first);
    });

    it('returns an empty page when nothing is trending', async () => {
      await makeBlog(grace.id, { slug: 'no-engagement', publishedAt: daysAgoLabel(1) });
      const page = await feedService.getTrendingFeed({ limit: 20, window: '7d' });
      expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
    });
  });

  // -------------------------------------------------------------------------
  // Feed items
  // -------------------------------------------------------------------------

  describe('feed items', () => {
    let item: FeedItem;

    beforeEach(async () => {
      const react = await makeTag('react');
      const frontend = await makeCategory('Frontend');
      const blog = await makeBlog(grace.id, {
        slug: 'card',
        title: 'A Card',
        subtitle: 'The subtitle a card shows',
        publishedAt: day(12),
        readingTimeMinutes: 6,
      });
      await tagBlog(blog.id, react.id);
      await categorizeBlog(blog.id, frontend.id);
      await makeComment(blog.id, alan.id);
      await makeComment(blog.id, reader.id);
      await makeBookmark(reader.id, blog.id);

      const page = await feedService.getLatestFeed({ limit: 20 });
      item = page.items[0]!;
    });

    it('carries everything a blog card renders', () => {
      expect(item).toMatchObject({
        title: 'A Card',
        slug: 'card',
        excerpt: 'The subtitle a card shows',
        readingTimeMinutes: 6,
        author: { username: 'gracehopper', name: 'Grace Hopper', isVerified: false },
        tags: [{ slug: 'react' }],
        categories: [{ slug: 'frontend' }],
      });
      expect(item.publishedAt).toBe(day(12).toISOString());
    });

    it('never ships the blog body, internal lifecycle state, or a ranking score', () => {
      expect(item).not.toHaveProperty('content');
      expect(item).not.toHaveProperty('status');
      expect(item).not.toHaveProperty('visibility');
      expect(item).not.toHaveProperty('score');
      expect(item).not.toHaveProperty('wordCount');
    });

    it('exposes no private author fields', () => {
      expect(item.author).not.toHaveProperty('email');
      expect(item.author).not.toHaveProperty('passwordHash');
      expect(Object.keys(item.author).sort()).toEqual([
        'avatar',
        'id',
        'isVerified',
        'name',
        'username',
      ]);
    });

    it('shows public engagement counts, and no analytics figures', () => {
      expect(item.engagement).toEqual({ comments: 2, bookmarks: 1 });
      // View counts are author-private; a public feed must not print them.
      expect(item.engagement).not.toHaveProperty('views');
    });

    it('resolves counts for every item on a multi-item page', async () => {
      // Behavioural half of the no-N+1 requirement; the query-count assertion
      // itself lives in feed.service.test.ts, where Prisma is observable.
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          makeBlog(alan.id, { slug: `batch-${i}`, publishedAt: day(13 + i) })
        )
      );
      await feedService.invalidateSharedFeeds(FEED_CACHE_SCOPES);

      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(page.items).toHaveLength(6);
      for (const entry of page.items) {
        expect(entry.engagement).toBeDefined();
      }
    });

    it('excludes deleted comments from the count', async () => {
      const blog = await makeBlog(alan.id, { slug: 'with-tombstone', publishedAt: day(19) });
      const comment = await makeComment(blog.id, reader.id);
      await makeComment(blog.id, grace.id);
      await prisma.comment.update({
        where: { id: comment.id },
        data: { deletedAt: new Date() },
      });
      await feedService.invalidateSharedFeeds(FEED_CACHE_SCOPES);

      const page = await feedService.getLatestFeed({ limit: 20 });
      const withTombstone = page.items.find((entry) => entry.slug === 'with-tombstone');
      expect(withTombstone?.engagement.comments).toBe(1);
    });

    it('leaves the excerpt null when a post has no subtitle', async () => {
      await makeBlog(alan.id, { slug: 'no-subtitle', subtitle: null, publishedAt: day(25) });
      await feedService.invalidateSharedFeeds(FEED_CACHE_SCOPES);

      const page = await feedService.getLatestFeed({ limit: 20 });
      expect(page.items[0]).toMatchObject({ slug: 'no-subtitle', excerpt: null });
    });
  });
});
