/**
 * Shared vocabulary for the Search & Discovery module.
 *
 * These types are the contract between the three layers that must NOT know
 * about each other's internals:
 *
 *   controller  ──▶ validated request shapes
 *   service     ──▶ orchestration, caching, DTO mapping
 *   ISearchEngine ▶ the actual retrieval + ranking backend
 *
 * Nothing here mentions PostgreSQL, tsvector, or trigrams — that is precisely
 * the point. Swapping `PostgresSearchEngine` for an OpenSearch/Meilisearch
 * implementation must not require touching this file.
 */

/** Result ordering. `relevance` is the default; the others are recency walks. */
export type SearchSort = 'relevance' | 'newest' | 'oldest';

/**
 * A user query after normalization. Built once by `normalizeQuery` and passed
 * down unchanged, so every engine sees the same canonical form and cache keys
 * derived from it are stable.
 */
export interface NormalizedQuery {
  /**
   * Trimmed, whitespace-collapsed, length-capped original casing. This is what
   * goes to full-text parsing, which does its own case folding and stemming.
   */
  raw: string;
  /**
   * Lowercased form used for equality, `LIKE`, and trigram similarity — none of
   * which fold case for us. Also the cache-key and search-history value.
   */
  normalized: string;
  /**
   * `normalized` with LIKE metacharacters escaped and a trailing `%`, i.e. an
   * anchored prefix pattern. Precomputed here so no query site can forget the
   * escaping and turn a user-supplied `%` into a full table scan.
   */
  prefixPattern: string;
  /** Whitespace-separated tokens of `normalized`, capped. Used for diagnostics. */
  tokens: string[];
}

/** Structured filters for blog search. All optional; all narrowing. */
export interface BlogSearchFilters {
  /** Author username (exact, case-insensitive). */
  author?: string;
  /** Tag slugs — a blog matches if it carries ANY of them. */
  tags?: string[];
  /** Category slugs — a blog matches if it belongs to ANY of them. */
  categories?: string[];
  /** Inclusive lower bound on `publishedAt`. */
  from?: Date;
  /** Inclusive upper bound on `publishedAt`. */
  to?: Date;
  /** Inclusive bounds on `readingTimeMinutes`. */
  minReadingTime?: number;
  maxReadingTime?: number;
}

/** Pagination + ordering, common to every search endpoint. */
export interface SearchPageRequest {
  cursor?: string;
  limit: number;
  sort: SearchSort;
}

/**
 * One page of engine results.
 *
 * `hasMore` is derived from a sentinel row (the engine fetches `limit + 1`),
 * never from a second COUNT query — the same trick `buildCursorPage` uses for
 * the rest of the platform.
 */
export interface EnginePage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Public author fields embedded in a blog hit. Mirrors `blogAuthorSelect`. */
export interface SearchAuthorSummary {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  isVerified: boolean;
}

/** Lightweight tag/category reference embedded in a blog hit. */
export interface SearchTermSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * A blog search result.
 *
 * Deliberately NOT `BlogCardDTO`: no Tiptap `content`, no SEO block, no word/
 * char counts. A search page returns up to MAX_SEARCH_LIMIT of these, and
 * shipping the content JSON for each would dwarf everything else on the wire.
 *
 * `publishedAt` is an ISO string rather than a `Date` so a cache hit and a cache
 * miss serialize to byte-identical JSON — a `Date` survives the first response
 * but comes back from Redis as a string, and the difference would leak to
 * clients as an intermittent type change.
 */
export interface BlogHit {
  id: string;
  title: string;
  slug: string;
  /** Short plain-text summary. Derived from the subtitle — never the body. */
  excerpt: string | null;
  coverImage: string | null;
  author: SearchAuthorSummary;
  tags: SearchTermSummary[];
  categories: SearchTermSummary[];
  readingTimeMinutes: number;
  publishedAt: string | null;
  /** Ranking score. Comparable only within one result set, never across queries. */
  score: number;
}

export interface UserHit {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  bio: string | null;
  isVerified: boolean;
  score: number;
}

export interface TagHit {
  id: string;
  name: string;
  slug: string;
  /** Number of publicly visible published blogs carrying this tag. */
  blogCount: number;
  score: number;
}

export type CategoryHit = TagHit;

/** Where a suggestion came from, so the client can label/route it. */
export type SuggestionSource = 'POPULAR' | 'TAG' | 'CATEGORY' | 'USER' | 'BLOG';

export interface Suggestion {
  /** The text to put in the search box when the user picks this. */
  text: string;
  source: SuggestionSource;
  /** Slug for TAG/CATEGORY/BLOG, username for USER. Absent for POPULAR. */
  slug?: string;
}

/** One recorded search from a user's private history. */
export interface SearchHistoryEntry {
  query: string;
  /** ISO timestamp of the most recent time this query was run. */
  searchedAt: string;
}

/** The `GET /search` overview payload — a capped slice of every entity type. */
export interface GlobalSearchResult {
  query: string;
  blogs: BlogHit[];
  users: UserHit[];
  tags: TagHit[];
  categories: CategoryHit[];
}
