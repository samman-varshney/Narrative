/**
 * Dashboard configuration — every tunable number in the module, in one file.
 *
 * Same separation the Feed module makes for the same reasons: these are the
 * values most likely to be changed, they are the part a unit test can assert on
 * without a database, and a composition reads as a composition only when the
 * page sizes and TTLs are somewhere else.
 */

// ---------------------------------------------------------------------------
// Time ranges
// ---------------------------------------------------------------------------

/**
 * The range vocabulary, and the number of days each covers.
 *
 * A FIXED vocabulary rather than free `startDate`/`endDate` parameters, which
 * the Analytics API does accept. Two reasons, and the first is the important
 * one:
 *
 *   Every value here is a cache key. An open-ended date parameter lets a single
 *   caller mint unbounded distinct entries, each costing an aggregate scan to
 *   build and a Redis entry to hold — the same reasoning behind Feed's fixed
 *   `TRENDING_WINDOWS`. Four presets means at most four entries per user per
 *   scope.
 *
 *   A dashboard is a fixed set of panels, not a query builder. Anyone who
 *   genuinely needs an arbitrary window is asking an analytics question, and the
 *   Analytics API answers it with validation this module would only be
 *   duplicating.
 *
 * `all` is resolved at request time from the Analytics module's retention
 * horizon rather than being a constant here — see `dashboard.range.ts`. Written
 * as a constant it would silently exceed (or fall short of) what the aggregates
 * still hold the moment an operator changed retention.
 */
export const RANGE_PRESETS = ['7d', '30d', '90d', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** Days each fixed preset covers, inclusive of today. `all` is resolved live. */
export const PRESET_DAYS: Record<Exclude<RangePreset, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export const DEFAULT_RANGE: RangePreset = '30d';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The sections `GET /dashboard/overview` can return.
 *
 * Adding a section means adding a key here and a builder in
 * `dashboard.sections.ts`. Nothing else in the module changes — no controller
 * branch, no service method, no route. That is the extensibility requirement
 * discharged by construction rather than by intention.
 *
 * Charts are deliberately NOT a section. They are the heaviest thing the
 * dashboard can ask for (three time series), a client typically renders them
 * below the fold, and putting them in the landing payload would make every
 * dashboard open pay for them. They have their own endpoint, which a client
 * calls when it is ready to draw.
 */
export const DASHBOARD_SECTIONS = [
  'stats',
  'recentBlogs',
  'drafts',
  'topContent',
  'audience',
  'bookmarks',
  'notifications',
  'activity',
] as const;

export type SectionKey = (typeof DASHBOARD_SECTIONS)[number];

/** Sections returned when the caller does not name any. */
export const DEFAULT_SECTIONS: readonly SectionKey[] = DASHBOARD_SECTIONS;

// ---------------------------------------------------------------------------
// Panel sizes
// ---------------------------------------------------------------------------

/**
 * How many rows each overview panel carries.
 *
 * Small, and fixed rather than caller-supplied. An overview is a set of
 * previews with a "see all" link behind each one; a caller who wants more asks
 * the section endpoint, which pages properly. Letting the composite endpoint
 * take a limit per panel would multiply the cache keyspace by every combination
 * of eight numbers.
 */
export const PANEL_LIMITS = {
  recentBlogs: 5,
  drafts: 5,
  topContent: 5,
  bookmarks: 5,
  notifications: 5,
  activity: 10,
} as const;

/** Page size bounds for the standalone section endpoints. */
export const MAX_SECTION_LIMIT = 50;
export const DEFAULT_SECTION_LIMIT = 20;

/** Longest comment excerpt carried on an activity row. Keeps the payload bounded. */
export const MAX_EXCERPT_LENGTH = 160;

/**
 * How far back the activity feed looks.
 *
 * Required, not optional: it is what keeps the comments-received query
 * proportional to recent activity rather than to an author's entire history.
 * Ninety days comfortably exceeds the window in which anyone scrolls an
 * activity panel, and an author whose newest activity is older than this sees
 * an empty panel — which is the honest answer to "what happened lately".
 */
export const ACTIVITY_LOOKBACK_DAYS = 90;

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** Time series `GET /dashboard/charts` can return. */
export const CHART_SERIES = ['views', 'engagement', 'followers'] as const;
export type ChartSeriesName = (typeof CHART_SERIES)[number];

export const DEFAULT_CHART_SERIES: readonly ChartSeriesName[] = CHART_SERIES;

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/** Cached response families. Each gets its own TTL. */
export type DashboardCacheScope =
  | 'overview'
  | 'stats'
  | 'charts'
  | 'top-content'
  | 'drafts'
  | 'activity';

/**
 * Per-scope TTLs, in seconds.
 *
 * Kept SHORT because the generation counters do the real invalidating: a TTL
 * here is the backstop for the one case generations cannot cover — a change
 * made by a process that never emitted an event this module subscribes to.
 *
 * They are also short for a second reason. This cache wraps a payload that
 * embeds the Analytics module's own cached reports, so a long TTL here would
 * stack on top of that one. The analytics generation is part of every key
 * (see `dashboard.cache.ts`), which removes the stacking for anything a flush
 * touches; these values bound what is left.
 */
export const CACHE_TTL_SECONDS: Record<DashboardCacheScope, number> = {
  overview: 60,
  stats: 60,
  charts: 120,
  'top-content': 120,
  drafts: 30,
  activity: 30,
};

/**
 * How long a generation may be reused from process memory.
 *
 * Identical to the Analytics and Feed modules' memo window, for the identical
 * reason: reading the counter from Redis on every request would double the round
 * trips on a path whose entire purpose is to avoid work. The cost is up to this
 * many seconds of extra staleness after an invalidation raised on ANOTHER
 * instance.
 */
export const GENERATION_MEMO_MS = 5_000;
