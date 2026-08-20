/**
 * Shared vocabulary for the Analytics module.
 *
 * This file is the contract between four layers that must not know each other's
 * internals:
 *
 *   subscribers / ingest API ──▶ AnalyticsEvent
 *   IAnalyticsIngestionService ▶ buffering + validation
 *   IAnalyticsStore            ▶ durable aggregate writes
 *   AnalyticsRepository        ▶ reporting queries ──▶ DTOs
 *
 * Nothing here mentions Redis, BullMQ or PostgreSQL. That is the point: the
 * migration path in ANALYTICS_MODULE.md (to ClickHouse, TimescaleDB or a Kafka
 * pipeline) replaces the implementations behind these types and leaves the
 * domain modules, the service and the HTTP contract untouched.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Every analytics event the platform records.
 *
 * These are ANALYTICS event types, deliberately not the same set as the domain
 * events in `core/events/eventBus`. Some are converted from a domain event by a
 * subscriber (BLOG_VIEWED, BLOG_BOOKMARKED, USER_FOLLOWED); the reading events
 * have no domain counterpart because nothing in the domain changes when a
 * reader scrolls — they arrive as client telemetry through the ingest endpoint.
 *
 * BLOG_LIKED is ABSENT ON PURPOSE. The `Like` table exists in the schema but no
 * Like module does: nothing likes, unlikes or emits. Adding the event here would
 * mean shipping an API field that permanently reads zero. See
 * ANALYTICS_MODULE.md § "Deliberate scope exclusion: likes".
 */
export const ANALYTICS_EVENT_TYPES = [
  'BLOG_VIEWED',
  'BLOG_READ_STARTED',
  'BLOG_READ_COMPLETED',
  'BLOG_BOOKMARKED',
  'BLOG_UNBOOKMARKED',
  'BLOG_COMMENTED',
  'BLOG_PUBLISHED',
  'USER_FOLLOWED',
  'USER_UNFOLLOWED',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/** What an event is *about*. Widened when a new entity gains analytics. */
export type AnalyticsEntityType = 'BLOG' | 'USER';

/**
 * Extra, event-specific fields.
 *
 * A discriminated union rather than `Record<string, unknown>`: the ingestion
 * service branches on event type and reads these, so a typo would otherwise be
 * a silent zero instead of a compile error. `unknown`-typed metadata is how
 * analytics pipelines rot.
 */
export type AnalyticsEventMetadata =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'read';
      /** Client-generated id tying READ_STARTED to its READ_COMPLETED. */
      readonly sessionId: string;
      /** Claimed, unvalidated. Clamped by the ingestion service. */
      readonly durationSeconds?: number;
    };

/**
 * One thing that happened, as analytics sees it.
 *
 * `userId` and `anonymousId` are the only identity fields, and neither reaches
 * PostgreSQL — the ingestion service hashes them into short-lived Redis keys and
 * discards them. IP addresses are deliberately absent: they are security data
 * under the existing architecture, not an analytics identity.
 */
export interface AnalyticsEvent {
  /**
   * Idempotency key. For a converted domain event this is the bus's
   * `DomainEventMeta.eventId`, which BullMQ holds fixed across retries; for
   * client telemetry it is minted at the edge from the request.
   */
  readonly eventId: string;
  readonly eventType: AnalyticsEventType;
  readonly occurredAt: Date;

  readonly userId?: string;
  readonly anonymousId?: string;

  readonly entityType: AnalyticsEntityType;
  readonly entityId: string;

  /**
   * The user whose dashboard this event rolls up to — a blog's author, or the
   * followed user. Resolved by the subscriber (or by the cached blog resolver)
   * so the ingestion path never has to query PostgreSQL per event.
   */
  readonly ownerId?: string;

  readonly metadata?: AnalyticsEventMetadata;
}

/** Why an event was not counted. Returned for logging and for tests. */
export type IngestionOutcome =
  | 'recorded'
  | 'duplicate-event'
  | 'duplicate-view'
  | 'self-action'
  | 'invalid'
  | 'unresolved-owner'
  | 'out-of-order'
  | 'buffer-unavailable';

export interface IngestionResult {
  readonly outcome: IngestionOutcome;
  /** Present when `outcome` is not `recorded`, for logs and tests. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Aggregates (the shape moved from Redis into PostgreSQL)
// ---------------------------------------------------------------------------

/**
 * Additive per-blog deltas for one day, drained from Redis.
 *
 * Every field except `uniqueViews` is a DELTA to be added to the stored row.
 * `uniqueViews` is an ABSOLUTE day-to-date count read from a HyperLogLog, which
 * only grows within a day — so the store takes the greater of stored and
 * incoming rather than adding. Mixing the two semantics in one struct is
 * deliberate and is the single subtlety in the flush path; it is why the field
 * is named separately in `IAnalyticsStore`.
 */
export interface BlogDailyDelta {
  blogId: string;
  authorId: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  views: number;
  uniqueViews: number;
  readStarts: number;
  readCompletions: number;
  totalReadingSeconds: number;
  bookmarks: number;
  unbookmarks: number;
  comments: number;
}

/** Additive per-user deltas for one day. No absolute fields. */
export interface UserDailyDelta {
  userId: string;
  date: string;
  followersGained: number;
  followersLost: number;
  blogsPublished: number;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Time-series bucket size. Only `day` is stored; `week` and `month` are
 * `date_trunc` aggregations over daily rows at query time.
 */
export type Granularity = 'day' | 'week' | 'month';

/** A validated, normalized reporting window. Always UTC, always inclusive. */
export interface DateRange {
  readonly startDate: Date;
  readonly endDate: Date;
  readonly granularity: Granularity;
}

/** One point in a views time series. */
export interface ViewsPoint {
  /** Bucket start, `YYYY-MM-DD`. */
  date: string;
  views: number;
  uniqueViews: number;
}

/** One point in an engagement time series. */
export interface EngagementPoint {
  date: string;
  bookmarks: number;
  unbookmarks: number;
  /** `bookmarks - unbookmarks` — the change in saved count for the bucket. */
  netBookmarks: number;
  comments: number;
}

/** One point in an audience-growth time series. */
export interface FollowerPoint {
  date: string;
  gained: number;
  lost: number;
  net: number;
}

/** Reading behaviour for a blog or an author, over a range. */
export interface ReadingStatsDTO {
  readStarts: number;
  readCompletions: number;
  /** Seconds, over completed reads only. `null` when nothing completed. */
  averageReadingSeconds: number | null;
  totalReadingSeconds: number;
  /** completions / starts, 0–1. `null` when nothing started. */
  completionRate: number | null;
  /** completions / views, 0–1 — how many openers finished. `null` when no views. */
  readThroughRate: number | null;
}

/** Lifetime-to-range totals for one blog. */
export interface BlogOverviewDTO {
  blogId: string;
  title: string;
  slug: string;
  status: string;
  publishedAt: string | null;
  range: { startDate: string; endDate: string };
  views: number;
  uniqueViews: number;
  bookmarks: number;
  netBookmarks: number;
  comments: number;
  reading: ReadingStatsDTO;
}

/** Author dashboard headline numbers. */
export interface UserOverviewDTO {
  userId: string;
  range: { startDate: string; endDate: string };
  /** Live from Blog, not summed from aggregates — see ANALYTICS_MODULE.md. */
  totalBlogs: number;
  publishedBlogs: number;
  draftBlogs: number;
  /** Live from Follow — the current count, not a sum of daily deltas. */
  followers: number;
  /** Range-scoped, from the daily aggregates. */
  views: number;
  uniqueViews: number;
  bookmarks: number;
  netBookmarks: number;
  comments: number;
  followersGained: number;
  followersLost: number;
  blogsPublishedInRange: number;
  reading: ReadingStatsDTO;
}

/** One row of the author's best-performing blogs. */
export interface TopBlogDTO {
  blogId: string;
  title: string;
  slug: string;
  publishedAt: string | null;
  views: number;
  uniqueViews: number;
  netBookmarks: number;
  comments: number;
  /** The value of the metric this list was ranked by. */
  metricValue: number;
}

/** Metrics a top-blogs list can be ranked by. */
export type TopBlogsMetric = 'views' | 'uniqueViews' | 'bookmarks' | 'comments' | 'readCompletions';
