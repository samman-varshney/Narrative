import type { Granularity } from './analytics.types';

/**
 * Date handling for analytics. Everything here is UTC.
 *
 * ── Why UTC, and what it costs ──────────────────────────────────────────────
 * A "day" has to mean one thing for a metric to be comparable across a range,
 * and the only definition that does not depend on who is asking is UTC. The cost
 * is real and worth naming: an author in Tokyo sees their evening traffic split
 * across two rows, and a "today" that ends at 09:00 local.
 *
 * The alternative — bucketing by each author's `UserSettings.timezone` — cannot
 * work at the buffer: a single blog view increments a bucket, and that bucket is
 * fixed at ingest time, before anyone has asked who is looking. Timezone-aware
 * reporting is therefore a QUERY-side feature (`date_trunc(..., timezone)`) that
 * daily UTC rows can support later without a re-ingest, which is exactly why the
 * grain is a day and not a month. See ANALYTICS_MODULE.md § "Known limitations".
 */

/** `YYYY-MM-DD` in UTC — the buffer's bucket key and the DATE column's value. */
export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC on the day `date` falls in. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Parses `YYYY-MM-DD` as midnight UTC. Returns null if it is not a real date. */
export function parseUtcDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects overflow like 2026-02-31, which `Date` would silently roll forward
  // into March and then report as a perfectly valid range bound.
  if (utcDateKey(parsed) !== value) return null;
  return parsed;
}

/** Whole days between two midnights, inclusive of both ends. */
export function inclusiveDayCount(start: Date, end: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

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

/** Midnight UTC `days` before today. Used for default report ranges. */
export function utcDaysAgo(days: number, now: Date = new Date()): Date {
  const start = startOfUtcDay(now);
  start.setUTCDate(start.getUTCDate() - days);
  return start;
}
