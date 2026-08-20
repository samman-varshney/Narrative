import { env } from '../../core/config/env';
import type { DateRange, Granularity } from './analytics.types';

/**
 * Date handling for analytics.
 *
 * ── The distinction this file exists to enforce ──────────────────────────────
 * There are two kinds of `Date` in this module and confusing them is the whole
 * bug class:
 *
 *   INSTANT — a real moment (`event.occurredAt`, `new Date()`). Which calendar
 *             day it belongs to depends on the reporting offset.
 *   LABEL   — a calendar day with no time and no zone, carried as midnight UTC
 *             because JavaScript has no date-only type. Range bounds, `date_trunc`
 *             output and the `DATE` column are all labels.
 *
 * Only INSTANT → LABEL applies the offset. Label arithmetic and label formatting
 * must not, or the shift is applied twice and every range slides by a day. The
 * naming here is the guard rail: anything called `reporting*` takes an instant
 * and is offset-aware; `dateKey`, `parseDateKey` and the counting helpers are
 * pure label operations.
 *
 * ── Why an offset rather than UTC ────────────────────────────────────────────
 * A day has to mean one thing for a metric to be comparable across a range, and
 * that meaning is fixed at ingest — a view increments a bucket before anyone has
 * asked who is looking, so bucketing per-author cannot work at this layer. UTC
 * satisfies "one meaning" but picks a boundary that is only quiet for about
 * UTC±3; at +9 it cuts the working morning, at -8 it splits the evening peak.
 * `ANALYTICS_REPORTING_UTC_OFFSET_MINUTES` moves the boundary to the audience
 * the numbers are actually for. Default 0, which is exactly the previous
 * behaviour.
 *
 * Per-author timezones remain a future QUERY-side feature, and remain blocked on
 * the same thing they always were: a daily grain cannot be re-sliced into a
 * different day boundary after the fact. See ANALYTICS_MODULE.md § "Known
 * limitations".
 */

/**
 * The configured boundary, in minutes east of UTC.
 *
 * Read once at module load. Every function below also takes it as a defaulted
 * parameter so tests can exercise a boundary without mutating global config —
 * the same seam `now` already provides for the clock.
 */
export const REPORTING_OFFSET_MINUTES = env.ANALYTICS_REPORTING_UTC_OFFSET_MINUTES;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Label operations — pure, never offset-aware
// ---------------------------------------------------------------------------

/**
 * Formats a LABEL as `YYYY-MM-DD`.
 *
 * Takes a label, not an instant: applying the offset here would double-shift
 * every range bound, which already went through `startOfReportingDay`. To turn
 * a real moment into a day, use `reportingDateKey`.
 */
export function dateKey(label: Date): string {
  return label.toISOString().slice(0, 10);
}

/** Parses `YYYY-MM-DD` into a LABEL. Returns null if it is not a real date. */
export function parseDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects overflow like 2026-02-31, which `Date` would silently roll forward
  // into March and then report as a perfectly valid range bound.
  if (dateKey(parsed) !== value) return null;
  return parsed;
}

/** Whole days between two labels, inclusive of both ends. */
export function inclusiveDayCount(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

/** A LABEL `days` before another label. Exact — UTC midnights have no DST. */
export function shiftDays(label: Date, days: number): Date {
  const shifted = new Date(label.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

// ---------------------------------------------------------------------------
// Instant → label — the only offset-aware conversions
// ---------------------------------------------------------------------------

/**
 * The reporting day an INSTANT falls in, as `YYYY-MM-DD`.
 *
 * This is the buffer's bucket key and the value written to the `DATE` column.
 */
export function reportingDateKey(
  instant: Date,
  offsetMinutes: number = REPORTING_OFFSET_MINUTES
): string {
  return dateKey(new Date(instant.getTime() + offsetMinutes * MS_PER_MINUTE));
}

/**
 * The reporting day an INSTANT falls in, as a LABEL.
 *
 * Returns midnight UTC of that calendar day — the label convention — NOT the
 * instant at which the reporting day began. Range bounds are compared against a
 * `DATE` column, so a label is what they need; a real instant here would be off
 * by the offset in every query.
 */
export function startOfReportingDay(
  instant: Date,
  offsetMinutes: number = REPORTING_OFFSET_MINUTES
): Date {
  const shifted = new Date(instant.getTime() + offsetMinutes * MS_PER_MINUTE);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** The LABEL `days` reporting-days before today. Used for default ranges. */
export function reportingDaysAgo(
  days: number,
  now: Date = new Date(),
  offsetMinutes: number = REPORTING_OFFSET_MINUTES
): Date {
  return shiftDays(startOfReportingDay(now, offsetMinutes), -days);
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/**
 * How many buckets a range produces at a granularity.
 *
 * Approximate for `week`/`month` by design — it is used to REJECT unreasonable
 * requests before they reach the database, and an estimate that is never more
 * than one bucket short is enough for that. Being exact would mean replicating
 * Postgres's `date_trunc` week rules in TypeScript to guard against a request
 * that is already bounded.
 */
export function estimateBucketCount(start: Date, end: Date, granularity: Granularity): number {
  const days = inclusiveDayCount(start, end);
  if (granularity === 'day') return days;
  if (granularity === 'week') return Math.ceil(days / 7) + 1;
  return Math.ceil(days / 28) + 1;
}

/**
 * Whether every bucket in this range covers exactly one calendar day.
 *
 * The test that decides whether an exact unique-reader count can be reported.
 * `uniqueViews` is stored per day and there is no way to combine two days'
 * counts without double-counting anyone who returned — so it is reportable when
 * a bucket is a day, and not otherwise. See `analytics.types` §
 * `uniqueReaderDays`.
 */
export function bucketsAreSingleDays(granularity: Granularity): boolean {
  return granularity === 'day';
}

/**
 * Whether a whole range collapses to a single calendar day.
 *
 * The equivalent test for the endpoints that return one aggregate over the range
 * rather than a series (`overview`, `reading`, `top-blogs`), where granularity
 * says nothing about the span.
 */
export function rangeIsSingleDay(range: Pick<DateRange, 'startDate' | 'endDate'>): boolean {
  return range.startDate.getTime() === range.endDate.getTime();
}
