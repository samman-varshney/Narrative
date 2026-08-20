import type { DashboardGranularity, DashboardRangeDTO } from './dashboard.types';

/**
 * Gap filling for chart series.
 *
 * The Analytics module returns only buckets that have data — correctly, because
 * "no row" and "zero" are the same fact for a counter, and a `generate_series`
 * LEFT JOIN would cost a scan every caller pays for whether they wanted it or
 * not. Its own docs say gap filling belongs to the consumer.
 *
 * This is that consumer. A chart is exactly the case where the distinction
 * matters in the other direction: an author who published on the 1st and the
 * 20th and got nothing in between should see a line along the floor, not two
 * points joined by a straight diagonal implying steady traffic through a quiet
 * fortnight. Filling is a PRESENTATION decision, which is why it lives in the
 * presentation-composition module and not in the module that owns the data.
 *
 * ── The bucket labels must match Postgres exactly ───────────────────────────
 * Analytics buckets with `date_trunc(granularity, date)::date`, so a filled
 * label that Postgres would never emit produces a duplicate point rather than
 * filling a gap — the real bucket and the invented one sit side by side. The
 * two rules that matter, both verified against the database in
 * `dashboard.db.test.ts` rather than taken from documentation:
 *
 *   week  — ISO weeks, starting MONDAY (not Sunday, which is what a naive
 *           `getUTCDay()` walk produces, and what most JS date code assumes)
 *   month — the first of the month
 *
 * All arithmetic is on UTC midnights, which is the convention every date LABEL
 * in this codebase follows. No offset is applied here: the range bounds arrived
 * already placed on the analytics reporting calendar, and shifting them again
 * would move every bucket by up to a day.
 */

const MS_PER_DAY = 86_400_000;

/** Parses a `YYYY-MM-DD` label into its UTC-midnight `Date`. */
export function parseLabel(label: string): Date {
  return new Date(`${label}T00:00:00.000Z`);
}

/** Formats a UTC-midnight `Date` back into a `YYYY-MM-DD` label. */
export function formatLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The bucket a day belongs to — the JavaScript equivalent of `date_trunc`.
 *
 * The week case is the one worth reading. `getUTCDay()` returns 0 for Sunday,
 * so `(day + 6) % 7` re-bases it to "days since Monday", which is the number to
 * subtract to land on the ISO week start Postgres uses.
 */
export function truncateToBucket(date: Date, granularity: DashboardGranularity): Date {
  if (granularity === 'day') return new Date(date.getTime());

  if (granularity === 'week') {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    return new Date(date.getTime() - daysSinceMonday * MS_PER_DAY);
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** The bucket immediately after this one. */
function nextBucket(bucket: Date, granularity: DashboardGranularity): Date {
  if (granularity === 'day') return new Date(bucket.getTime() + MS_PER_DAY);
  if (granularity === 'week') return new Date(bucket.getTime() + 7 * MS_PER_DAY);
  return new Date(Date.UTC(bucket.getUTCFullYear(), bucket.getUTCMonth() + 1, 1));
}

/**
 * Every bucket label a range covers, in order.
 *
 * Starts at the bucket CONTAINING `startDate`, not at `startDate` itself: a
 * 30-day range starting on a Wednesday has its first weekly bucket on the
 * Monday before, which is the label Postgres will return for any row in that
 * week. Starting at the range bound instead would leave that bucket's real data
 * unmatched, and the invented label unfilled.
 */
export function bucketLabels(range: DashboardRangeDTO): string[] {
  const last = truncateToBucket(parseLabel(range.endDate), range.granularity).getTime();
  const labels: string[] = [];

  let cursor = truncateToBucket(parseLabel(range.startDate), range.granularity);

  // A guard, not a limit: the range is already bounded by the granularity
  // chosen for it (see `pickGranularity`), so this can only fire if that
  // invariant is ever broken — in which case an over-long array is a far worse
  // failure than a truncated one.
  const MAX_LABELS = 1_000;

  while (cursor.getTime() <= last && labels.length < MAX_LABELS) {
    labels.push(formatLabel(cursor));
    cursor = nextBucket(cursor, range.granularity);
  }

  return labels;
}

/**
 * Expands a sparse series into one point per bucket.
 *
 * Points the loader returned win; missing buckets are filled by `empty(label)`.
 * A returned point whose label is NOT a bucket of this range is dropped —
 * defensively, because the alternative is a chart with a point off the end of
 * its own axis, and every such label would be a bug in bucket alignment that is
 * better caught by the test asserting these labels against Postgres than
 * rendered.
 */
export function denseSeries<T extends { date: string }>(
  points: T[],
  range: DashboardRangeDTO,
  empty: (date: string) => T
): T[] {
  const byDate = new Map(points.map((point) => [point.date, point]));
  return bucketLabels(range).map((label) => byDate.get(label) ?? empty(label));
}
