import { z } from 'zod';
import {
  CHART_SERIES,
  DASHBOARD_SECTIONS,
  DEFAULT_CHART_SERIES,
  DEFAULT_RANGE,
  DEFAULT_SECTION_LIMIT,
  DEFAULT_SECTIONS,
  MAX_SECTION_LIMIT,
  RANGE_PRESETS,
} from './dashboard.config';

/**
 * Zod schemas for the Dashboard module.
 *
 * Everything here validates a QUERY STRING, so the controller parses with a
 * local `parseOrThrow` rather than the `validateRequest` body middleware —
 * Express 5 makes `req.query` a read-only getter, so a middleware that parses
 * and assigns cannot work. The Blog, Notification, Search, Feed and Analytics
 * controllers all handle their list endpoints the same way.
 *
 * The module has no write endpoints and therefore no body schemas. That is not
 * an omission: a dashboard reads, and every mutation a user might launch from
 * one (mark a notification read, publish a draft) belongs to the module that
 * owns it and already has an endpoint for it.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * A comma-separated list of enum values.
 *
 * `?sections=stats,drafts` rather than repeated `?sections=stats&sections=drafts`:
 * Express parses the repeated form into a string for one value and an array for
 * two, so every consumer would need to normalize it, and a single-element
 * request would take a different code path from a two-element one. One string,
 * one parse.
 *
 * An unknown value is a 400, not a silent drop. A client asking for a section
 * that does not exist has a bug — most likely a typo or a version mismatch —
 * and answering with a payload that quietly omits what it asked for turns that
 * into a mystery rather than an error message.
 */
function csvEnum<T extends string>(allowed: readonly T[], label: string) {
  const permitted = new Set<string>(allowed);

  return z.string().transform((raw, ctx): T[] => {
    const values = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    if (values.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: `${label} must name at least one value`,
      });
      return z.NEVER;
    }

    const unknown = values.filter((value) => !permitted.has(value));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `Unknown ${label}: ${unknown.join(', ')}. ` +
          `Expected one of: ${allowed.join(', ')}`,
      });
      return z.NEVER;
    }

    // Deduped so `?sections=stats,stats` is one section, not two — and, more to
    // the point, so it produces the SAME cache key as `?sections=stats`.
    return [...new Set(values)] as T[];
  });
}

/**
 * The range preset.
 *
 * A closed vocabulary, not `startDate`/`endDate`. See `RANGE_PRESETS` in
 * `dashboard.config.ts` for why — briefly: every value is a cache key, and a
 * dashboard is a fixed set of panels rather than a query builder. Arbitrary
 * windows are what the Analytics API is for.
 */
export const rangeSchema = z.enum(RANGE_PRESETS).default(DEFAULT_RANGE);

/** Page size for the standalone section endpoints. */
const sectionLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_SECTION_LIMIT)
  .default(DEFAULT_SECTION_LIMIT);

// ---------------------------------------------------------------------------
// Endpoint queries
// ---------------------------------------------------------------------------

export const rangeQuerySchema = z.object({
  range: rangeSchema,
});
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export const overviewQuerySchema = z.object({
  range: rangeSchema,
  sections: csvEnum(DASHBOARD_SECTIONS, 'section').default([...DEFAULT_SECTIONS]),
});
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;

export const chartsQuerySchema = z.object({
  range: rangeSchema,
  series: csvEnum(CHART_SERIES, 'series').default([...DEFAULT_CHART_SERIES]),
});
export type ChartsQuery = z.infer<typeof chartsQuerySchema>;

/**
 * Top-content ranking parameters.
 *
 * `metric` is the ANALYTICS module's vocabulary, passed through unchanged. It
 * is deliberately not re-declared with a dashboard-flavoured spelling: the
 * ranking is computed there, and a translation layer between two enums that
 * must stay in lockstep is a mapping table waiting to fall out of date.
 *
 * `uniqueReaderDays`, and not a "unique readers" option, because ranking spans
 * the whole range and an exact unique-reader count only exists for a single
 * day. That constraint belongs to Analytics; this schema just does not offer
 * the option Analytics cannot honour.
 */
export const topContentQuerySchema = z.object({
  range: rangeSchema,
  metric: z
    .enum(['views', 'uniqueReaderDays', 'bookmarks', 'comments', 'readCompletions'])
    .default('views'),
  limit: sectionLimitSchema,
  cursor: z.string().min(1).max(512).optional(),
});
export type TopContentQuery = z.infer<typeof topContentQuerySchema>;

export const draftsQuerySchema = z.object({
  limit: sectionLimitSchema,
  cursor: z.string().min(1).optional(),
});
export type DraftsQuery = z.infer<typeof draftsQuerySchema>;

/**
 * Activity parameters — a limit and nothing else.
 *
 * No cursor, deliberately. The feed is a merge of three independently-ordered
 * sources, so a correct cursor would have to carry a position in each of them
 * and stay valid as all three grow. That is real work for a panel whose entire
 * purpose is "what happened lately", and it is recorded as a known limitation
 * rather than half-built. See DASHBOARD_MODULE.md § Known limitations.
 */
export const activityQuerySchema = z.object({
  limit: sectionLimitSchema,
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
