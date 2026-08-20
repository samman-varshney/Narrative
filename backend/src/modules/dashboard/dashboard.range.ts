import { analyticsService } from '../analytics/analytics.service';
import { PRESET_DAYS, type RangePreset } from './dashboard.config';
import type { DashboardGranularity, DashboardRangeDTO } from './dashboard.types';

/**
 * Turns a range preset into the window the Analytics API accepts.
 *
 * ── Why this is not just a lookup table ─────────────────────────────────────
 * Two of the three things it produces cannot be constants:
 *
 *   `all` has no fixed length. It means "as far back as the aggregates still
 *   go", which is the Analytics module's retention setting — an operational
 *   knob. Hardcoded here, lowering retention would make this module ask for
 *   rows the prune job had already deleted (a 400 from Analytics), and raising
 *   it would silently stop offering data that exists.
 *
 *   The granularity depends on the length. A series response is capped at
 *   `maxBuckets` points, so a 400-day range CANNOT be served daily — asking for
 *   it is a 400, not a slow query. The caller does not choose granularity for
 *   exactly this reason: it is a consequence of the range, and offering it as a
 *   knob would mean advertising combinations that always fail.
 *
 * ── The offset ──────────────────────────────────────────────────────────────
 * Day boundaries come from `analyticsService.buildReportingWindow`, never from
 * `new Date()` arithmetic here. Aggregates are bucketed on the configured
 * reporting calendar, so computing UTC dates in this module would shift every
 * window by up to a day the moment that setting is non-zero — a bug that is
 * invisible in a UTC-configured dev environment and permanent in production.
 */

/**
 * Days in a range, inclusive of both ends.
 *
 * The bounds are date LABELS (`YYYY-MM-DD`), so this is plain calendar
 * arithmetic on UTC midnights — no offset is applied, and none should be. They
 * have already been placed on the reporting calendar by the Analytics module.
 */
export function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * Buckets a range produces at a granularity.
 *
 * Mirrors the Analytics module's own estimate, including its deliberate
 * over-count of one for `week` and `month` (a range can straddle one more
 * bucket boundary than its length implies). Kept identical on purpose: this
 * function decides what to ASK for and Analytics decides what to ACCEPT, so an
 * estimate that ran lower than theirs would produce requests that are rejected.
 */
export function estimateBuckets(days: number, granularity: DashboardGranularity): number {
  if (granularity === 'day') return days;
  if (granularity === 'week') return Math.ceil(days / 7) + 1;
  return Math.ceil(days / 28) + 1;
}

/**
 * The finest granularity whose bucket count fits inside the cap.
 *
 * Finest-first because resolution is what a reader wants: a 90-day chart is far
 * more useful daily than weekly, and coarsening it "to be safe" throws away
 * detail the cap would have allowed. Falls through to `month`, which fits any
 * range the retention horizon permits — a decade of daily rows is 131 monthly
 * buckets.
 */
export function pickGranularity(days: number, maxBuckets: number): DashboardGranularity {
  const candidates: DashboardGranularity[] = ['day', 'week', 'month'];
  for (const granularity of candidates) {
    if (estimateBuckets(days, granularity) <= maxBuckets) return granularity;
  }
  return 'month';
}

/**
 * Resolves a preset into a concrete, validated-by-construction window.
 *
 * `now` is injectable so tests can pin a window without freezing the clock
 * globally — the same seam the Analytics module provides.
 */
export function resolveRange(preset: RangePreset, now: Date = new Date()): DashboardRangeDTO {
  const { maxLookbackDays, maxBuckets } = analyticsService.getReportingLimits();

  // `+ 1` because the window is INCLUSIVE of both ends: a start exactly
  // `maxLookbackDays` days ago spans that many days plus today, and it is the
  // oldest start Analytics accepts. One more and every `all` request would 400.
  const days = preset === 'all' ? maxLookbackDays + 1 : PRESET_DAYS[preset];

  const { startDate, endDate } = analyticsService.buildReportingWindow(days, now);

  return {
    preset,
    startDate,
    endDate,
    // Derived from the ACTUAL span rather than from `days`. The two agree today,
    // but the window is the thing the series will be built over, so measuring it
    // is what keeps this correct if window construction ever clamps.
    granularity: pickGranularity(inclusiveDayCount(startDate, endDate), maxBuckets),
  };
}

/** The range as the Analytics series API wants it. */
export function toSeriesQuery(range: DashboardRangeDTO): {
  startDate: string;
  endDate: string;
  granularity: DashboardGranularity;
} {
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    granularity: range.granularity,
  };
}

/** The range as the Analytics totals API wants it — no granularity. */
export function toTotalsQuery(range: DashboardRangeDTO): {
  startDate: string;
  endDate: string;
} {
  return { startDate: range.startDate, endDate: range.endDate };
}
