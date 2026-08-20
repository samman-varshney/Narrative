import type { BlogVisibility } from '@prisma/client';

/**
 * Shared vocabulary for the Feed & Explore module.
 *
 * These types are the contract between the layers that must not know each
 * other's internals:
 *
 *   controller  ──▶ validated request shapes
 *   service     ──▶ composition, caching, ranking, DTO mapping
 *   repository  ──▶ candidate retrieval + eligibility (the only SQL)
 *   ranking     ──▶ pure scoring/diversity functions over signals
 *
 * Nothing here mentions Redis, Prisma or a table name. That is deliberate: the
 * migration path in FEED_MODULE.md (materialized feeds, fan-out on write, a
 * dedicated ranking service) replaces implementations behind these types and
 * leaves the HTTP contract untouched.
 */

// ---------------------------------------------------------------------------
// Feed identity
// ---------------------------------------------------------------------------

/**
 * The four feeds. Used as a cursor/cache namespace as well as a route name, so
 * a cursor minted for one feed can never be replayed against another.
 */
export type FeedType = 'following' | 'latest' | 'explore' | 'trending';

/**
 * How a feed paginates.
 *
 *   chronological — keyset over `(publishedAt, id)`; the dataset itself is the
 *                   ordering, so pages are stable however long the walk takes.
 *   ranked        — offset into a RANKED SNAPSHOT of candidate ids; the ordering
 *                   is computed, so it is frozen once and paged from there.
 *
 * See `feed.cursor.ts` for why a computed ordering cannot use a plain keyset.
 */
export type FeedPagination = 'chronological' | 'ranked';

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/**
 * Discovery filters. All optional, all narrowing, all index-backed or bounded.
 *
 * Deliberately a subset of what Search accepts: `from`/`to` are absent because a
 * feed is a recency-ordered window by construction — a client that wants an
 * arbitrary date range is running a search, not reading a feed.
 */
export interface FeedFilters {
  /** Tag slugs — a blog matches if it carries ANY of them. */
  tags?: string[];
  /** Category slugs — a blog matches if it belongs to ANY of them. */
  categories?: string[];
  /** Author username (exact, case-insensitive). */
  author?: string;
  /** Inclusive bounds on `readingTimeMinutes`. */
  minReadingTime?: number;
  maxReadingTime?: number;
}

/** Pagination request common to every feed endpoint. */
export interface FeedPageRequest {
  cursor?: string;
  limit: number;
}

/**
 * The requesting viewer, when there is one.
 *
 * Feeds never take a user id from the request: `userId` here always comes from
 * the verified access token, which is what makes "you cannot request another
 * user's following feed" a structural property rather than a check that could be
 * forgotten. See FEED_MODULE.md § Security.
 */
export interface FeedViewer {
  userId: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Public author fields embedded in a feed item. Mirrors `blogAuthorSelect`. */
export interface FeedAuthorSummary {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  isVerified: boolean;
}

/** Lightweight tag/category reference embedded in a feed item. */
export interface FeedTermSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * Publicly visible engagement on a feed card.
 *
 * Sourced from the Comment and Bookmark modules — the DOMAIN tables — and never
 * from Analytics. That is a privacy decision, not a convenience one: the
 * Analytics module holds view counts and reading behaviour as author-private
 * data (see ANALYTICS_MODULE.md § Authorization), and a public feed that
 * printed them would quietly undo that. These two counts, by contrast, are
 * derivable from data the platform already serves publicly — anyone can count
 * the comments on a post.
 *
 * Analytics signals DO influence the ORDER of the ranked feeds; they are simply
 * never serialized. See `FeedItem.score`.
 */
export interface FeedEngagement {
  comments: number;
  bookmarks: number;
}

/**
 * One card in a feed.
 *
 * Everything the UI needs to render a blog card and nothing else. Explicitly
 * absent: the Tiptap `content` body (a page of 50 of these would be dwarfed by
 * it), `status`/`visibility` (internal lifecycle state), word/char counts, SEO,
 * and any author field beyond the public five.
 *
 * `score` is ABSENT ON PURPOSE for ranked feeds. Search publishes its relevance
 * score because it is computed from the query and public text; a feed score is
 * computed partly from private analytics, and publishing it would leak an
 * invertible signal about view counts. Order is the product feature; the number
 * behind it is not.
 *
 * `publishedAt` is an ISO string rather than a `Date` so a cache hit and a cache
 * miss serialize to byte-identical JSON — the same reason `BlogHit` does it.
 */
export interface FeedItem {
  id: string;
  title: string;
  slug: string;
  /** Short plain-text summary. Derived from the subtitle — never the body. */
  excerpt: string | null;
  coverImage: string | null;
  author: FeedAuthorSummary;
  tags: FeedTermSummary[];
  categories: FeedTermSummary[];
  readingTimeMinutes: number;
  publishedAt: string | null;
  engagement: FeedEngagement;
}

/**
 * One page of a feed.
 *
 * `hasMore` is derived from a sentinel row (chronological feeds fetch
 * `limit + 1`) or from the snapshot length (ranked feeds) — never from a second
 * COUNT query, matching `core/utils/pagination` and the Search module.
 */
export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Internal (never serialized)
// ---------------------------------------------------------------------------

/**
 * A blog row as the repository returns it: the card fields, plus the two
 * columns ranking and pagination need (`authorId`, `sortAt`) that never reach
 * the wire.
 *
 * Columns are aliased to camelCase in SQL so this is already nearly the DTO —
 * the mapping in the service is then a shape change, not a rename table.
 */
export interface FeedBlogRow {
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  coverImage: string | null;
  readingTimeMinutes: number;
  publishedAt: Date | null;
  /**
   * The keyset's time component. Identical to `publishedAt` — eligibility
   * already guarantees one exists — and kept as its own field so the cursor
   * code never has to know which column the ordering came from.
   */
  sortAt: Date;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorAvatar: string | null;
  authorVerified: boolean;
}

/**
 * The signals a ranking function is allowed to see.
 *
 * Assembled by the service from three owners — Blog (recency, author), Analytics
 * (engagement) and the taxonomy join (topic) — and handed to a PURE function.
 * That separation is what makes ranking unit-testable without a database and
 * replaceable without touching retrieval.
 */
export interface RankingSignals {
  blogId: string;
  authorId: string;
  /** The blog's publication instant, for recency decay. */
  publishedAt: Date;
  /**
   * Weighted engagement over the ranking window, from the Analytics module.
   * Unbounded and un-normalized; the ranking functions decide how to scale it.
   */
  engagementScore: number;
  /**
   * The blog's first tag slug, if any — the diversity pass's notion of "topic".
   * First by `addedAt`, so it is the tag the author chose first.
   */
  primaryTopic: string | null;
}

/** A scored candidate. `score` is comparable only within one ranking run. */
export interface RankedCandidate {
  blogId: string;
  authorId: string;
  primaryTopic: string | null;
  score: number;
}

/**
 * Which of the Blog module's visibilities a feed may surface.
 *
 * A set rather than a single value because the type describes the *shape* of the
 * rule, not its current content — which is PUBLIC alone, for every feed. See
 * `feed.eligibility.ts` for why UNLISTED and MEMBERS_ONLY are excluded.
 */
export type FeedVisibilitySet = readonly BlogVisibility[];
