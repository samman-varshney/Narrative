import type { ChartSeriesName, RangePreset, SectionKey } from './dashboard.config';

/**
 * The Dashboard module's wire contract.
 *
 * Every type here is a DASHBOARD DTO, defined in this file even where a sibling
 * module already exposes something with the same fields. That is deliberate and
 * it is the reason the mapping code in `dashboard.sections.ts` is explicit
 * rather than a spread:
 *
 *   - This module's API is a promise to its clients. If it re-exported
 *     `BlogCardDTO`, a field added to the Blog module's card would silently
 *     appear in the dashboard payload, and a field removed would silently break
 *     a client — neither change having been reviewed as an API change.
 *   - A dashboard panel needs a fraction of what a full card carries. Shipping
 *     the whole thing eight times over is payload nobody renders.
 *
 * ── Dates are ISO STRINGS, never `Date` ─────────────────────────────────────
 * Every date-shaped field on these types is a `string`. Responses are cached as
 * JSON, and JSON has no date type — a `Date` written to Redis returns as a
 * string, so a DTO typed with `Date` would be honest on a cache miss and a lie
 * on every hit. The Analytics module reached the same conclusion for the same
 * reason. Conversion happens once, in the section builders, before anything is
 * cached.
 */

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/** Bucket size of a time series. Matches the Analytics module's vocabulary. */
export type DashboardGranularity = 'day' | 'week' | 'month';

/**
 * A resolved reporting window, echoed on every response.
 *
 * Echoed because the server fills in defaults and derives the granularity: a
 * client charting "all time" cannot label its own axis without being told which
 * days it actually got and how they were bucketed.
 */
export interface DashboardRangeDTO {
  preset: RangePreset;
  /** Inclusive, `YYYY-MM-DD`, on the analytics reporting calendar. */
  startDate: string;
  endDate: string;
  granularity: DashboardGranularity;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Reading behaviour over the range.
 *
 * Every rate is `number | null`, and the `null` is load-bearing: "no completion
 * rate because nobody started reading" and "a 0% completion rate" are different
 * facts, and collapsing them puts a red zero on the dashboard of a post nobody
 * has opened yet. Carried through from the Analytics module, which draws the
 * same distinction.
 */
export interface ReadingSummaryDTO {
  starts: number;
  completions: number;
  /** Seconds, over completed reads only. `null` when nothing completed. */
  averageSeconds: number | null;
  totalSeconds: number;
  /** completions / starts, 0–1. `null` when nothing started. */
  completionRate: number | null;
  /** completions / views, 0–1. `null` when there were no views. */
  readThroughRate: number | null;
}

/**
 * The headline numbers.
 *
 * Split into groups that answer different questions, because a flat bag of
 * fifteen counters is how `views` and `followers` end up looking like the same
 * kind of number. `content`, `audience` and `library` are CURRENT totals, live
 * from their owning tables; `engagement` is RANGE-SCOPED and comes from the
 * daily aggregates. Mixing the two in one object without saying so is the
 * classic dashboard bug — a "total views" that silently means "views this
 * month".
 */
export interface DashboardStatsDTO {
  /** Current blog counts. `total` excludes soft-deleted blogs. */
  content: {
    total: number;
    published: number;
    drafts: number;
    archived: number;
  };
  /** Current relationship totals, live from the follow graph. */
  audience: {
    followers: number;
    following: number;
  };
  /** Range-scoped, from the daily aggregates. */
  engagement: {
    views: number;
    /** Σ of daily unique readers. One reader on three days counts three. */
    uniqueReaderDays: number;
    /** Exact distinct readers. Non-null only when the range is a single day. */
    uniqueViews: number | null;
    comments: number;
    /** bookmarks minus unbookmarks — the change in saved count over the range. */
    netBookmarks: number;
    reading: ReadingSummaryDTO;
  };
  /** The user's own saved content. Their reading list, not their audience's. */
  library: {
    bookmarks: number;
  };
  notifications: {
    unread: number;
  };
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** A tag or category as it appears on a dashboard card. */
export interface LabelDTO {
  id: string;
  name: string;
  slug: string;
}

/**
 * One of the author's own blogs, as a dashboard panel row.
 *
 * Carries what a panel renders and what a click needs — never `content`. A
 * dashboard that loaded eight blog bodies to show eight titles would be the
 * single most expensive page on the platform.
 */
export interface BlogSummaryDTO {
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  coverImage: string | null;
  status: string;
  visibility: string;
  readingTimeMinutes: number;
  wordCount: number;
  tags: LabelDTO[];
  /** ISO. Null for anything never published. */
  publishedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

/** One row of the top-performing list: the blog, plus how it performed. */
export interface TopContentItemDTO {
  blog: BlogSummaryDTO;
  views: number;
  uniqueReaderDays: number;
  uniqueViews: number | null;
  netBookmarks: number;
  comments: number;
  /** The value of the metric this list was ranked by. */
  metricValue: number;
}

/** A blog the user has SAVED — someone else's content, on their reading list. */
export interface SavedBlogDTO {
  bookmarkId: string;
  /** ISO. */
  bookmarkedAt: string;
  /**
   * Null when the blog was deleted or its visibility was tightened after it was
   * saved. The row is still returned so the UI can offer to remove it, but
   * nothing about the now-hidden blog is disclosed.
   */
  blog: {
    id: string;
    title: string;
    slug: string;
    coverImage: string | null;
    readingTimeMinutes: number;
    author: { id: string; username: string; name: string; avatar: string | null };
  } | null;
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/**
 * Audience size and how it moved.
 *
 * `followers` is the live count; `gained`/`lost`/`net` are range-scoped deltas
 * from the aggregates. The two are deliberately not derived from each other —
 * a total summed from deltas drifts permanently the moment one delta is lost,
 * while a delta inferred from two totals cannot distinguish "no activity" from
 * "ten followed, ten left".
 */
export interface AudienceDTO {
  followers: number;
  following: number;
  growth: {
    gained: number;
    lost: number;
    net: number;
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationSummaryItemDTO {
  id: string;
  type: string;
  /** Null for SYSTEM notifications, or when the actor's account is gone. */
  actor: { id: string; username: string; name: string; avatar: string | null } | null;
  entityType: string | null;
  entityId: string | null;
  /** Render inputs (blogTitle, commentExcerpt, …), never rendered copy. */
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  /** ISO. */
  createdAt: string;
}

export interface NotificationsPanelDTO {
  unread: number;
  items: NotificationSummaryItemDTO[];
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * What kinds of thing show up in the activity feed.
 *
 * Three, because three are what the platform actually records about an author's
 * audience today. Notably absent: "someone saved your post". The Bookmark table
 * has no index supporting "bookmarks on blogs by author X" and bookmarking
 * raises no notification, so surfacing it would mean either a scan or a new
 * write path — see DASHBOARD_MODULE.md § Known limitations. The aggregate
 * number still appears in stats and on the engagement chart.
 */
export type ActivityType = 'COMMENT_RECEIVED' | 'FOLLOWER_GAINED' | 'BLOG_PUBLISHED';

/**
 * One thing that happened, from the author's point of view.
 *
 * A single shape across all three sources rather than a discriminated union
 * with three payloads: every consumer renders these in one list, and a union
 * would make the common case (icon, actor, text, timestamp, link) the awkward
 * one. Fields that do not apply to a source are `null` — `actor` for the
 * author's own publishes, `blog` for a new follower.
 */
export interface ActivityItemDTO {
  /**
   * Stable and source-prefixed (`comment:<id>`, `follow:<id>`, `blog:<id>`).
   * Prefixed because ids are only unique within their own table, and a React
   * key colliding across sources is a silently mis-rendered list.
   */
  id: string;
  type: ActivityType;
  /** ISO. The merge key — the whole feed is ordered by this, descending. */
  occurredAt: string;
  /** Who did it. Null when the actor is the dashboard's own owner. */
  actor: {
    id: string;
    username: string;
    name: string;
    avatar: string | null;
    isVerified: boolean;
  } | null;
  /** What it was about. Null for follows, which are about the author. */
  blog: { id: string; title: string; slug: string } | null;
  /** Truncated comment text. Null for every other activity type. */
  excerpt: string | null;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/**
 * Chart data is plain arrays of `{ date, ...numbers }`.
 *
 * No series objects, no axis config, no colours, no library-specific shape.
 * Recharts, Chart.js, D3 and a plain `<table>` can all consume this, which is
 * the requirement: the backend says what happened, the frontend decides how to
 * draw it.
 *
 * Every bucket in the range is present, including empty ones — see
 * `denseSeries` in `dashboard.series.ts`. That is the one transformation this
 * module applies on top of the Analytics series, and it is a presentation
 * decision, which is why it lives here and not in Analytics.
 */
export interface ViewsChartPoint {
  date: string;
  views: number;
  uniqueReaderDays: number;
  /** Exact distinct readers. Non-null only at daily granularity. */
  uniqueViews: number | null;
}

export interface EngagementChartPoint {
  date: string;
  comments: number;
  bookmarks: number;
  unbookmarks: number;
  netBookmarks: number;
}

export interface FollowersChartPoint {
  date: string;
  gained: number;
  lost: number;
  net: number;
}

export interface DashboardChartsDTO {
  range: DashboardRangeDTO;
  views?: { points: ViewsChartPoint[] };
  engagement?: { points: EngagementChartPoint[] };
  followers?: { current: number; points: FollowersChartPoint[] };
}

/** Which series a charts request asked for. */
export type ChartSeriesSelection = readonly ChartSeriesName[];

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * The composite payload.
 *
 * Each section key has THREE meaningful states, and keeping them apart is the
 * point of the shape:
 *
 *   absent  — not requested. `?sections=stats` returns `stats` and nothing else.
 *   `null`  — requested, and it FAILED. The key is also in `degradedSections`.
 *   value   — requested and loaded. An author with no posts gets `[]`.
 *
 * The `null`-versus-`[]` distinction is the one that matters to a user: "you
 * haven't written anything yet" and "we couldn't load your posts" are different
 * messages, and a single empty array can only produce the first — which is how
 * a dashboard cheerfully tells an author with fifty posts that they have none.
 *
 * The whole response is still a 200 when a section fails. One subsystem being
 * down is not a reason to show a signed-in author an error page instead of the
 * seven panels that loaded perfectly well.
 */
export interface DashboardOverviewDTO {
  range: DashboardRangeDTO;
  stats?: DashboardStatsDTO | null;
  recentBlogs?: BlogSummaryDTO[] | null;
  drafts?: BlogSummaryDTO[] | null;
  topContent?: TopContentItemDTO[] | null;
  audience?: AudienceDTO | null;
  bookmarks?: { total: number; items: SavedBlogDTO[] } | null;
  notifications?: NotificationsPanelDTO | null;
  activity?: ActivityItemDTO[] | null;
}

/** Response metadata for the composite endpoint. */
export interface DashboardOverviewMeta {
  range: DashboardRangeDTO;
  /** Sections actually requested and attempted. */
  sections: SectionKey[];
  /** Sections that failed and were returned as `null`. Empty on a healthy read. */
  degradedSections: SectionKey[];
}
