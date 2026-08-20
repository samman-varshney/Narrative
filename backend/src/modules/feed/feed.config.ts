/**
 * Feed configuration — every tunable number in the module, in one file.
 *
 * Kept apart from the code that applies it for the same three reasons the
 * Search module keeps `engines/ranking.ts` separate: these are the values most
 * likely to be tuned, they are the part a unit test can assert on without a
 * database, and a scoring formula reads as a formula only when the constants are
 * somewhere else.
 *
 * ── The V1 ranking position ─────────────────────────────────────────────────
 * Everything here is DETERMINISTIC and viewer-independent. Given the same
 * candidates and the same signals, every user gets the same Explore and the same
 * Trending — which is what makes those two feeds cacheable across viewers at
 * all, and what keeps "why am I seeing this?" answerable. Personalization,
 * topic affinity and behavioural signals are explicitly future work (see
 * FEED_MODULE.md § Future evolution); adding them means adding a viewer
 * dimension to the cache key in the SAME change.
 */

// ---------------------------------------------------------------------------
// Page sizes
// ---------------------------------------------------------------------------

/**
 * Maximum page size for a feed.
 *
 * Below the platform-wide `MAX_PAGE_LIMIT` of 100, and equal to Search's cap,
 * for the same reason: a feed page carries taxonomy and engagement counts for
 * every item, so page size multiplies three batched queries, not one. 50 is far
 * more than any UI renders at once.
 */
export const MAX_FEED_LIMIT = 50;
export const DEFAULT_FEED_LIMIT = 20;

// ---------------------------------------------------------------------------
// Candidate retrieval
// ---------------------------------------------------------------------------

/**
 * Rows a ranked feed considers before scoring.
 *
 * Ranked feeds are top-K, never exhaustive: Explore and Trending each pull at
 * most this many candidates, score them, and page inside the result. Without a
 * cap, "rank everything published" would be a full scan on every request, and
 * would get slower every day the platform lives.
 *
 * The consequence is a hard DEPTH LIMIT — no ranked feed can be paged past this
 * many items. That is the same trade every production ranking system makes
 * (Elasticsearch calls it `max_result_window`) and it is documented rather than
 * hidden. Chronological feeds have no such limit; they walk a keyset for as long
 * as the client keeps asking.
 */
export const CANDIDATE_LIMIT = 300;

/**
 * How far back Explore's engagement signal looks.
 *
 * Long enough that a post published a fortnight ago can still be surfaced by the
 * conversation around it, short enough that Explore is not a hall of fame.
 */
export const EXPLORE_ENGAGEMENT_WINDOW_DAYS = 14;

/**
 * Trending windows a caller may ask for, and the day count each resolves to.
 *
 * A fixed vocabulary rather than a free `days` parameter. Each value is a
 * snapshot namespace and a cache key, so an open-ended parameter would let one
 * caller mint unbounded distinct rankings — each of which costs an aggregate
 * scan to build and a Redis entry to hold.
 */
export const TRENDING_WINDOW_NAMES = ['24h', '7d', '30d'] as const;
export type TrendingWindow = (typeof TRENDING_WINDOW_NAMES)[number];

export const TRENDING_WINDOWS: Record<TrendingWindow, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

export const DEFAULT_TRENDING_WINDOW: TrendingWindow = '7d';

// ---------------------------------------------------------------------------
// Engagement weights (the Analytics query's scoring inputs)
// ---------------------------------------------------------------------------

/**
 * How much each recorded interaction contributes to a blog's engagement score.
 *
 * Ordered by how much deliberate effort the reader spent, which is also how hard
 * each is to fake: a view is one request, a completed read is minutes of
 * attention, a bookmark and a comment are deliberate acts tied to an account.
 *
 * `views` is deliberately the smallest non-zero weight rather than zero. It is
 * the only signal every post has, so dropping it would make a post with a
 * thousand readers and no comments score exactly zero.
 *
 * These are passed to the Analytics module as BOUND PARAMETERS of its ranking
 * query — Feed owns the weights, Analytics owns the data and the SQL. Neither
 * duplicates the other.
 */
export const ENGAGEMENT_WEIGHTS = {
  views: 1,
  uniqueReaders: 2,
  readCompletions: 4,
  bookmarks: 6,
  comments: 8,
} as const;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Explore's scoring weights. Both components are normalized to [0, 1] before
 * weighting, so a weight IS that component's maximum contribution and the two
 * can be read against each other directly.
 *
 * Engagement outweighs recency, but not by enough to bury a fresh post: a
 * brand-new post with no engagement at all scores 1.0, which beats a
 * three-week-old post that has not saturated the engagement curve.
 */
export const EXPLORE_WEIGHTS = {
  RECENCY: 1.0,
  ENGAGEMENT: 1.4,
} as const;

/**
 * Half-life of Explore's recency component, in days.
 *
 * A post published today scores 1.0, one from a week ago 0.5, one from a month
 * ago ~0.05. Shorter than Search's 180-day decay on purpose: search is answering
 * "what is most relevant", where evergreen writing should win; Explore is
 * answering "what is worth reading now".
 */
export const EXPLORE_RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Saturation constant for the engagement curve, `e / (e + K)`.
 *
 * A bounded, order-preserving transform with no dependence on the rest of the
 * candidate set — which is what makes a score stable when the candidate set
 * shifts between two pages of the same walk. Normalizing against the set's
 * maximum instead would make every score in the feed move when one viral post
 * arrived or aged out.
 *
 * At K, a post scores 0.5. The value is roughly "one comment plus a bookmark
 * plus a handful of finished reads" — i.e. the point at which a post has
 * demonstrably resonated with someone.
 */
export const ENGAGEMENT_SATURATION = 20;

/**
 * Trending's recency shape.
 *
 * Trending multiplies windowed engagement by a publication-recency boost. The
 * engagement half is already recency-bounded (it only counts the window), so
 * this exists for a second, narrower purpose: to stop an older post that is
 * being steadily read from permanently outranking a new post that is genuinely
 * surging.
 *
 * The FLOOR is what keeps that from becoming censorship of older work. At 0.25
 * an old post with four times the current engagement of a new one still wins —
 * a real surge on an archive piece trends, a merely-popular-forever one does
 * not.
 */
export const TRENDING_RECENCY_HALF_LIFE_DAYS = 7;
export const TRENDING_RECENCY_FLOOR = 0.25;

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

/**
 * Caps applied to the HEAD of a ranked feed.
 *
 * Nothing is ever dropped: an item over its author's or topic's cap is DEFERRED
 * to the tail of the ranking, not removed. So a prolific author's fifth post is
 * still reachable by paging — it simply does not occupy a slot on the first
 * screen that a different voice could fill.
 *
 * Two per author and three per topic means a 20-item first page can be filled by
 * at most 10 authors' worth of concentration, in practice far more.
 */
export const DIVERSITY = {
  MAX_PER_AUTHOR: 2,
  MAX_PER_TOPIC: 3,
} as const;

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * TTLs in seconds, per cached artifact.
 *
 * All short. These are an upper bound on staleness only in the ABSENCE of
 * events — a blog being published, updated or withdrawn bumps a generation and
 * invalidates immediately (see `feed.cache.ts`).
 */
export const CACHE_TTL_SECONDS = {
  /** A rendered page of a shared, viewer-independent feed. */
  page: 30,
  /** A viewer's own following feed, first page only. */
  following: 30,
  /** A ranked snapshot: the frozen ordering a ranked cursor walks. */
  snapshot: 300,
} as const;

/**
 * Quantization of "now" for ranked feeds, in seconds.
 *
 * A ranked snapshot is identified by the request parameters plus a time bucket.
 * Without quantization every request would mint a distinct snapshot — the cache
 * would never hit, and a rebuild after eviction could not reproduce the ordering
 * the client is paging through because its window bounds would have moved.
 *
 * 60 seconds means at most one snapshot build per minute per distinct filter
 * combination, and a rebuild uses byte-identical window bounds to the original.
 */
export const RANKING_BUCKET_SECONDS = 60;
