import { logger } from '../../core/utils/logger';
import { analyticsService } from '../analytics/analytics.service';
import { bookmarkService } from '../bookmark/bookmark.service';
import { commentService } from '../comment/comment.service';
import { followService } from '../follow/follow.service';
import {
  bumpGeneration,
  dropFollowingPage,
  readFollowingPage,
  readSnapshot,
  snapshotId,
  withPageCache,
  writeFollowingPage,
  writeSnapshot,
  type FeedCacheScope,
} from './feed.cache';
import {
  CANDIDATE_LIMIT,
  ENGAGEMENT_WEIGHTS,
  EXPLORE_ENGAGEMENT_WINDOW_DAYS,
  RANKING_BUCKET_SECONDS,
  TRENDING_WINDOWS,
  type TrendingWindow,
} from './feed.config';
import {
  decodeChronologicalCursor,
  decodeRankedCursor,
  encodeChronologicalCursor,
  encodeRankedCursor,
  feedFingerprint,
  type RankedPosition,
} from './feed.cursor';
import { applyDiversity, rank, scoreExplore, scoreTrending } from './feed.ranking';
import { feedRepository, type FeedTaxonomy } from './feed.repository';
import type {
  FeedBlogRow,
  FeedFilters,
  FeedItem,
  FeedPage,
  FeedType,
  RankingSignals,
} from './feed.types';
import type {
  ExploreFeedQuery,
  FollowingFeedQuery,
  LatestFeedQuery,
  TrendingFeedQuery,
} from './feed.validator';

/**
 * Feed & Explore orchestration.
 *
 * This module OWNS no data. Every fact it serves belongs to someone else — blogs
 * and their lifecycle to Blog, the follow graph to Follow, engagement to
 * Analytics, comment and bookmark counts to Comment and Bookmark — and the
 * service's whole job is to compose them into four feeds without reimplementing
 * any of it.
 *
 * ── The pipeline, in the same order for every feed ──────────────────────────
 *
 *   1. RETRIEVE   candidates                (feed.repository — the only SQL)
 *   2. ELIGIBLE   status/visibility/author  (feed.eligibility — inside that SQL)
 *   3. RANK       score + diversify         (feed.ranking — pure functions)
 *   4. BUILD      DTOs + batched hydration  (here)
 *
 * Chronological feeds skip step 3 because their ordering IS the data. Ranked
 * feeds run all four and freeze the result as a snapshot so pagination is exact.
 *
 * ── Hydration is always batched ─────────────────────────────────────────────
 * A page needs tags, categories, comment counts and bookmark counts for every
 * item. All four are loaded for the WHOLE page in four queries, never per row.
 * A feed is the single easiest place in a codebase to introduce an N+1, so the
 * only path that builds items is `hydrate` below.
 */

/** Longest excerpt shipped per card. Keeps a 50-item page's payload bounded. */
const MAX_EXCERPT_LENGTH = 200;

/**
 * How many snapshot ids are re-checked against the database at a time while
 * filling a ranked page.
 *
 * A snapshot can contain ids that have since been archived, deleted or filtered
 * out for this viewer, so filling a page of N may need to walk more than N. It
 * is walked in batches rather than all at once so a page that fills immediately
 * — the overwhelming majority — costs exactly one query.
 */
const SNAPSHOT_SCAN_BATCH = 25;

export class FeedService {
  // ---- Following ---------------------------------------------------------

  /**
   * Recently published content from the authors a viewer follows.
   *
   * `viewerId` is the authenticated user, always — there is no parameter for
   * whose feed to fetch, which is what makes "you cannot read someone else's
   * following feed" a property of the API's shape rather than a check that could
   * be forgotten.
   *
   * Eligibility is the SAME as every other feed's: PUBLIC content only. Being
   * authenticated widens who is asking, not what is discoverable — see
   * `feed.eligibility.ts` for why UNLISTED and MEMBERS_ONLY stay out.
   *
   * ── Fan-out on read ──────────────────────────────────────────────────────
   * The query is a semi-join against the follow graph, not a materialized feed.
   * That is the V1 position the PRD sets out, and it holds well: with the
   * partial indexes in `prisma/sql/feed_indexes.sql` the planner picks between
   * walking the published-blog index in publication order (fast for a viewer
   * who follows many authors) and walking each followed author's own index
   * (fast for a viewer who follows few). Neither degrades into the sort-
   * everything plan that an inlined list of thousands of author ids would force.
   *
   * ── Caching ──────────────────────────────────────────────────────────────
   * Only the FIRST page of an UNFILTERED feed is cached, keyed by viewer. That
   * is the request every client makes on every app open, while a deep page is
   * walked once by one person and would only grow the keyspace. Follow and
   * unfollow drop the entry immediately (see `feed.subscriber.ts`), so the TTL
   * is a backstop rather than the mechanism.
   */
  async getFollowingFeed(viewerId: string, query: FollowingFeedQuery): Promise<FeedPage> {
    const filters = toFilters(query);
    const fingerprint = feedFingerprint({ feed: 'following', viewerId, filters });
    const cacheable = !query.cursor && Object.keys(filters).length === 0;

    if (cacheable) {
      const hit = await readFollowingPage(viewerId);
      if (hit) return hit;
    }

    const page = await this.chronologicalPage({
      fingerprint,
      cursor: query.cursor,
      limit: query.limit,
      filters,
      authorScope: followService.followedAuthorIdsSql(viewerId),
    });

    if (cacheable) await writeFollowingPage(viewerId, page);
    return page;
  }

  // ---- Latest ------------------------------------------------------------

  /**
   * Every discoverable blog, newest first.
   *
   * Public and viewer-independent, so one cached page is correct for every
   * caller including anonymous ones — the property that makes the shared cache
   * safe. Ordering is purely `(publishedAt, id)`: no ranking, no personalization,
   * nothing that could make two callers disagree about what page 2 is.
   */
  getLatestFeed(query: LatestFeedQuery): Promise<FeedPage> {
    const filters = toFilters(query);
    const fingerprint = feedFingerprint({ feed: 'latest', filters });

    return withPageCache(
      'latest',
      { filters, cursor: query.cursor ?? null, limit: query.limit },
      () =>
        this.chronologicalPage({
          fingerprint,
          cursor: query.cursor,
          limit: query.limit,
          filters,
        })
    );
  }

  // ---- Explore -----------------------------------------------------------

  /**
   * A ranked mixture of recent and well-received content.
   *
   * Deliberately NOT "latest with extra steps": its candidate pool has two
   * sources — the newest eligible posts, and the platform's most-engaged posts
   * over a two-week window — so a good post from ten days ago can appear above a
   * post from an hour ago, which the Latest feed can never do. Ranking then
   * balances recency against engagement, and the diversity pass stops one author
   * or one topic owning the first screen.
   *
   * `excludeFollowing` is the one viewer-conditional behaviour in the module and
   * is opt-in: it filters the shared ranking rather than changing it, so the
   * snapshot every viewer walks stays identical and only the page assembly
   * differs. Pages served with it set are never written to the shared cache.
   */
  async getExploreFeed(query: ExploreFeedQuery, viewerId?: string): Promise<FeedPage> {
    const filters = toFilters(query);
    const excludeFollowing = query.excludeFollowing && !!viewerId;
    const fingerprint = feedFingerprint({
      feed: 'explore',
      filters,
      options: { excludeFollowing },
    });

    const load = () =>
      this.rankedPage({
        feed: 'explore',
        fingerprint,
        cursor: query.cursor,
        limit: query.limit,
        filters,
        snapshotParts: { window: EXPLORE_ENGAGEMENT_WINDOW_DAYS },
        build: (at) => this.buildExploreSnapshot(filters, at),
        ...(excludeFollowing && viewerId ? { excludeFollowedOf: viewerId } : {}),
      });

    // A viewer-filtered page is not shareable, so it bypasses the cross-viewer
    // cache entirely rather than being written under a key that omits the
    // dimension that made it different.
    if (excludeFollowing) return load();

    return withPageCache(
      'explore',
      { filters, cursor: query.cursor ?? null, limit: query.limit },
      load
    );
  }

  // ---- Trending ----------------------------------------------------------

  /**
   * Content gaining engagement right now.
   *
   * Two guards keep an all-time favourite off this list. The engagement half is
   * WINDOWED — only interactions inside the requested window count, so a post's
   * history is invisible here — and the score is then multiplied by a
   * publication-recency boost with a floor, so a genuine surge on older writing
   * still trends while a permanently-popular post does not permanently sit at
   * the top. See `feed.ranking.ts` for the shape and `feed.config.ts` for the
   * constants.
   *
   * The engagement data itself comes from the Analytics module; this module
   * neither collects nor stores any of it.
   */
  getTrendingFeed(query: TrendingFeedQuery): Promise<FeedPage> {
    const filters = toFilters(query);
    const fingerprint = feedFingerprint({
      feed: 'trending',
      filters,
      options: { window: query.window },
    });

    return withPageCache(
      'trending',
      { filters, window: query.window, cursor: query.cursor ?? null, limit: query.limit },
      () =>
        this.rankedPage({
          feed: 'trending',
          fingerprint,
          cursor: query.cursor,
          limit: query.limit,
          filters,
          snapshotParts: { window: query.window },
          build: (at) => this.buildTrendingSnapshot(filters, query.window, at),
        })
    );
  }

  // ---- Invalidation (called by the subscribers) --------------------------

  /** Drops every cached page of the shared feeds. */
  invalidateSharedFeeds(scopes: FeedCacheScope[]): Promise<void> {
    return bumpGeneration(scopes);
  }

  /** Drops one viewer's cached following feed. */
  invalidateFollowingFeed(viewerId: string): Promise<void> {
    return dropFollowingPage(viewerId);
  }

  // ---- Chronological assembly --------------------------------------------

  /**
   * One keyset page: fetch `limit + 1`, trim the sentinel, mint the next cursor.
   *
   * Hydration runs AFTER the trim, so the extra row fetched to detect `hasMore`
   * never costs a taxonomy or count lookup for an item nobody will see.
   */
  private async chronologicalPage(params: {
    fingerprint: string;
    cursor?: string;
    limit: number;
    filters: FeedFilters;
    authorScope?: ReturnType<typeof followService.followedAuthorIdsSql>;
  }): Promise<FeedPage> {
    const position = params.cursor
      ? decodeChronologicalCursor(params.cursor, params.fingerprint)
      : undefined;

    const rows = await feedRepository.findChronologicalPage({
      filters: params.filters,
      limit: params.limit,
      ...(position ? { position } : {}),
      ...(params.authorScope ? { authorScope: params.authorScope } : {}),
    });

    const hasMore = rows.length > params.limit;
    const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
      items: await this.hydrate(pageRows),
      nextCursor:
        hasMore && last
          ? encodeChronologicalCursor({
              fingerprint: params.fingerprint,
              sortAt: last.sortAt,
              id: last.id,
            })
          : null,
      hasMore,
    };
  }

  // ---- Ranked assembly ---------------------------------------------------

  /**
   * One page of a ranked feed, walked from a frozen snapshot.
   *
   * The snapshot is built at most once per ranking bucket per filter
   * combination; every page after the first reuses it, which is what makes the
   * walk free of duplicates and gaps even though the underlying signals are
   * moving. If it has expired, it is REBUILT against the bucket the cursor
   * carries — same window, same weights, same candidate query — so the ordering
   * is reproduced rather than replaced.
   *
   * Ids are re-checked against the database as they are consumed, so a post
   * archived or deleted since the snapshot was built silently drops out instead
   * of 404-ing a reader who clicks it.
   */
  private async rankedPage(params: {
    feed: FeedType;
    fingerprint: string;
    cursor?: string;
    limit: number;
    filters: FeedFilters;
    snapshotParts: Record<string, unknown>;
    build: (bucketAt: Date) => Promise<string[]>;
    excludeFollowedOf?: string;
  }): Promise<FeedPage> {
    const position: RankedPosition | undefined = params.cursor
      ? decodeRankedCursor(params.cursor, params.fingerprint)
      : undefined;

    const bucketAt = position ? position.bucketAt : currentBucket();
    const id =
      position?.snapshotId ??
      snapshotId({
        feed: params.feed,
        filters: params.filters,
        ...params.snapshotParts,
        bucket: bucketAt.toISOString(),
      });

    let ids = await readSnapshot(id);
    if (!ids) {
      ids = await params.build(bucketAt);
      await writeSnapshot(id, ids);
    }

    const { rows, nextOffset } = await this.walkSnapshot(ids, {
      offset: position?.offset ?? 0,
      limit: params.limit,
      filters: params.filters,
      ...(params.excludeFollowedOf ? { excludeFollowedOf: params.excludeFollowedOf } : {}),
    });

    const hasMore = nextOffset < ids.length;

    return {
      items: await this.hydrate(rows),
      nextCursor: hasMore
        ? encodeRankedCursor({
            fingerprint: params.fingerprint,
            snapshotId: id,
            offset: nextOffset,
            bucketAt,
          })
        : null,
      hasMore,
    };
  }

  /**
   * Consumes snapshot ids until the page is full or the snapshot is exhausted.
   *
   * `nextOffset` is the exact index to resume from — the position AFTER the last
   * item placed, not after the last id inspected — which is what keeps a page
   * boundary from swallowing the ids that were fetched but did not fit.
   */
  private async walkSnapshot(
    ids: string[],
    opts: {
      offset: number;
      limit: number;
      filters: FeedFilters;
      excludeFollowedOf?: string;
    }
  ): Promise<{ rows: FeedBlogRow[]; nextOffset: number }> {
    const rows: FeedBlogRow[] = [];
    let cursor = Math.min(opts.offset, ids.length);

    while (rows.length < opts.limit && cursor < ids.length) {
      const window = ids.slice(cursor, cursor + Math.max(opts.limit, SNAPSHOT_SCAN_BATCH));
      const eligible = await this.eligibleById(window, opts);

      let consumed = 0;
      for (const blogId of window) {
        consumed += 1;
        const row = eligible.get(blogId);
        if (row) rows.push(row);
        if (rows.length >= opts.limit) break;
      }
      cursor += consumed;
    }

    return { rows, nextOffset: cursor };
  }

  /**
   * Re-checks a window of candidate ids and returns the survivors by id.
   *
   * The eligibility SQL is the same one every other feed query uses, so a
   * candidate suggested by Analytics is held to exactly the rules a candidate
   * found by Blog is. The optional follow filter is applied on top, from one
   * batched lookup rather than per row.
   */
  private async eligibleById(
    ids: string[],
    opts: { filters: FeedFilters; excludeFollowedOf?: string }
  ): Promise<Map<string, FeedBlogRow>> {
    const rows = await feedRepository.findEligibleByIds({ ids, filters: opts.filters });

    if (!opts.excludeFollowedOf || rows.length === 0) {
      return new Map(rows.map((row) => [row.id, row]));
    }

    const followed = await followService.getFollowedSubset(
      opts.excludeFollowedOf,
      [...new Set(rows.map((row) => row.authorId))]
    );
    return new Map(
      rows.filter((row) => !followed.has(row.authorId)).map((row) => [row.id, row])
    );
  }

  // ---- Snapshot builders -------------------------------------------------

  /**
   * Explore's candidate pool: recency ∪ engagement, scored and diversified.
   *
   * Two sources rather than one is what makes Explore differ from Latest. The
   * recency source guarantees new writing is always considered — a platform
   * where only already-popular posts are candidates can never surface anything
   * new. The engagement source reaches back past the newest N posts for work
   * people are actually reading.
   */
  private async buildExploreSnapshot(filters: FeedFilters, at: Date): Promise<string[]> {
    const window = analyticsService.buildEngagementWindow({
      windowDays: EXPLORE_ENGAGEMENT_WINDOW_DAYS,
      weights: ENGAGEMENT_WEIGHTS,
      now: at,
    });

    const [recent, ranking] = await Promise.all([
      feedRepository.findRecentCandidates({ filters, limit: CANDIDATE_LIMIT }),
      analyticsService.getEngagementRanking(window, CANDIDATE_LIMIT),
    ]);

    const seen = new Set(recent.map((row) => row.id));
    const engagementOnly = ranking.map((row) => row.blogId).filter((id) => !seen.has(id));

    const extra = await feedRepository.findEligibleByIds({
      ids: engagementOnly.slice(0, CANDIDATE_LIMIT),
      filters,
    });

    const rows = [...recent, ...extra];
    if (rows.length === 0) return [];

    const blogIds = rows.map((row) => row.id);
    const [engagement, taxonomy] = await Promise.all([
      analyticsService.getEngagementForBlogs(blogIds, window),
      feedRepository.loadTaxonomy(blogIds),
    ]);

    const signals = rows.map((row) =>
      toSignals(row, taxonomy, engagement.get(row.id)?.engagementScore ?? 0)
    );

    return applyDiversity(rank(signals, scoreExplore, at))
      .slice(0, CANDIDATE_LIMIT)
      .map((candidate) => candidate.blogId);
  }

  /**
   * Trending's candidate pool: the window's most-engaged posts, re-checked for
   * eligibility and re-scored with the recency boost.
   *
   * Analytics ranks by engagement alone; this module owns the recency half, so a
   * post that led the window on volume can still be overtaken by a newer one
   * that is climbing faster. Candidates with no engagement in the window are
   * never considered — that is what distinguishes this feed from Explore.
   */
  private async buildTrendingSnapshot(
    filters: FeedFilters,
    windowName: TrendingWindow,
    at: Date
  ): Promise<string[]> {
    const window = analyticsService.buildEngagementWindow({
      windowDays: TRENDING_WINDOWS[windowName],
      weights: ENGAGEMENT_WEIGHTS,
      now: at,
    });

    const ranking = await analyticsService.getEngagementRanking(window, CANDIDATE_LIMIT);
    if (ranking.length === 0) return [];

    const rows = await feedRepository.findEligibleByIds({
      ids: ranking.map((row) => row.blogId),
      filters,
    });
    if (rows.length === 0) return [];

    const scores = new Map(ranking.map((row) => [row.blogId, row.engagementScore]));
    const taxonomy = await feedRepository.loadTaxonomy(rows.map((row) => row.id));

    const signals = rows.map((row) => toSignals(row, taxonomy, scores.get(row.id) ?? 0));

    return applyDiversity(rank(signals, scoreTrending, at))
      .slice(0, CANDIDATE_LIMIT)
      .map((candidate) => candidate.blogId);
  }

  // ---- Hydration & DTO mapping -------------------------------------------

  /**
   * Turns rows into cards, loading everything a card needs in four queries for
   * the whole page.
   *
   * The counts come from the Comment and Bookmark modules — never from
   * Analytics. Analytics holds view counts and reading behaviour as
   * author-private data, and a public feed printing them would quietly undo
   * that; these two are derivable from what the platform already serves
   * publicly. See `feed.types.ts` § FeedEngagement.
   *
   * A failure loading counts degrades to zeros rather than failing the feed: the
   * cards are still correct and complete, and a number beside them is not worth
   * a 500.
   */
  private async hydrate(rows: FeedBlogRow[]): Promise<FeedItem[]> {
    if (rows.length === 0) return [];
    const blogIds = rows.map((row) => row.id);

    const [taxonomy, comments, bookmarks] = await Promise.all([
      feedRepository.loadTaxonomy(blogIds),
      commentService.getCommentCounts(blogIds).catch((err) => {
        logger.warn({ err }, 'feed: comment counts unavailable');
        return new Map<string, number>();
      }),
      bookmarkService.getBookmarkCounts(blogIds).catch((err) => {
        logger.warn({ err }, 'feed: bookmark counts unavailable');
        return new Map<string, number>();
      }),
    ]);

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      excerpt: truncate(row.subtitle, MAX_EXCERPT_LENGTH),
      coverImage: row.coverImage,
      author: {
        id: row.authorId,
        username: row.authorUsername,
        name: row.authorName,
        avatar: row.authorAvatar,
        isVerified: row.authorVerified,
      },
      tags: taxonomy.tags.get(row.id) ?? [],
      categories: taxonomy.categories.get(row.id) ?? [],
      readingTimeMinutes: Number(row.readingTimeMinutes),
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      engagement: {
        comments: comments.get(row.id) ?? 0,
        bookmarks: bookmarks.get(row.id) ?? 0,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps a validated query onto the filter bag.
 *
 * Only keys the caller actually supplied are present. An `undefined` entry would
 * change the canonicalized cache key and cursor fingerprint for a request that
 * is semantically identical to one without it — the same trap the Search module
 * documents.
 */
function toFilters(query: {
  tag?: string[];
  category?: string[];
  author?: string;
  minReadingTime?: number;
  maxReadingTime?: number;
}): FeedFilters {
  return {
    ...(query.tag?.length ? { tags: query.tag } : {}),
    ...(query.category?.length ? { categories: query.category } : {}),
    ...(query.author ? { author: query.author } : {}),
    ...(query.minReadingTime !== undefined ? { minReadingTime: query.minReadingTime } : {}),
    ...(query.maxReadingTime !== undefined ? { maxReadingTime: query.maxReadingTime } : {}),
  };
}

/**
 * Assembles the signals a ranking function sees.
 *
 * `primaryTopic` is the blog's FIRST tag by `addedAt` — the one its author
 * reached for first — which makes the diversity pass's notion of "topic" a
 * stable property of the post rather than whichever tag happened to sort first.
 */
function toSignals(
  row: FeedBlogRow,
  taxonomy: FeedTaxonomy,
  engagementScore: number
): RankingSignals {
  return {
    blogId: row.id,
    authorId: row.authorId,
    publishedAt: row.publishedAt ?? row.sortAt,
    engagementScore,
    primaryTopic: taxonomy.tags.get(row.id)?.[0]?.slug ?? null,
  };
}

/**
 * The instant a ranking is scored against, quantized to the ranking bucket.
 *
 * Quantized so that two requests moments apart resolve to the same snapshot —
 * and so a rebuild after eviction uses byte-identical window bounds. At full
 * resolution every request would mint its own ordering and ranked pagination
 * would have nothing stable to walk.
 */
function currentBucket(now: Date = new Date()): Date {
  const bucketMs = RANKING_BUCKET_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export const feedService = new FeedService();
