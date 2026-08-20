import { AppError } from '../../core/exceptions/AppError';
import {
  DEFAULT_RANGE_DAYS,
  MAX_BUCKETS,
  MAX_LOOKBACK_DAYS,
  type DateRangeQuery,
  type TotalsRangeQuery,
} from './analytics.validator';
import {
  estimateBucketCount,
  parseDateKey,
  reportingDaysAgo,
  startOfReportingDay,
} from './analytics.time';
import type { DateRange } from './analytics.types';

/**
 * Turns the raw range query into a validated, normalized `DateRange`.
 *
 * Separate from the Zod schema because every rule here is CROSS-FIELD and
 * depends on defaults the caller did not send: whether `start <= end` cannot be
 * checked before both are resolved, and how many buckets a range produces
 * depends on the granularity too. A `.refine` on the schema would only ever see
 * the fields that were actually present, so half of these checks would silently
 * not run on the most common request — the one with no dates at all.
 *
 * Every failure is a 400 with a distinct error code, so a client can tell "your
 * dates are backwards" from "that range is too long to serve at this
 * granularity" without parsing prose.
 */

/**
 * The window used when a caller sends no dates: the last 30 days, inclusive.
 *
 * "Today" is the REPORTING day, not the UTC one — an author whose boundary is
 * configured to their audience's would otherwise get a default range that ends
 * on the wrong day for part of every 24 hours.
 */
function defaultRange(now: Date): { startDate: Date; endDate: Date } {
  return {
    startDate: reportingDaysAgo(DEFAULT_RANGE_DAYS - 1, now),
    endDate: startOfReportingDay(now),
  };
}

/**
 * Resolves and validates a reporting window.
 *
 * `now` is injectable so tests can pin the default window without freezing the
 * clock globally.
 */
export function resolveDateRange(query: DateRangeQuery, now: Date = new Date()): DateRange {
  const range = resolveBounds(query, now);

  const buckets = estimateBucketCount(range.startDate, range.endDate, range.granularity);
  if (buckets > MAX_BUCKETS) {
    throw new AppError(
      `That range produces about ${buckets} data points at granularity "${range.granularity}" ` +
        `(maximum ${MAX_BUCKETS}). Narrow the range, or request a coarser granularity.`,
      400,
      'RANGE_TOO_LARGE'
    );
  }

  return range;
}

/**
 * Resolves a window for an endpoint that returns ONE aggregate over the whole
 * range (`overview`, `reading`).
 *
 * Identical to `resolveDateRange` except that the bucket cap does not apply:
 * the response is a fixed set of totals whatever the range, computed by a single
 * indexed aggregate, so "too many data points" is not a failure mode it has.
 * The retention/lookback bound still applies — that one is about data that no
 * longer exists.
 *
 * Carries `granularity: 'day'` purely to satisfy `DateRange`; nothing downstream
 * reads it on this path.
 */
export function resolveTotalsRange(
  query: TotalsRangeQuery,
  now: Date = new Date()
): DateRange {
  return resolveBounds({ ...query, granularity: 'day' }, now);
}

/** Shared bound resolution and validation, minus the bucket cap. */
function resolveBounds(query: DateRangeQuery, now: Date): DateRange {
  const defaults = defaultRange(now);

  // Caller-supplied dates are already calendar days — labels — so they are
  // parsed, never offset-shifted. `2026-08-20` means that day on the reporting
  // calendar whatever the offset is.
  const startDate = query.startDate ? parseDateKey(query.startDate) : defaults.startDate;
  const endDate = query.endDate ? parseDateKey(query.endDate) : defaults.endDate;

  // The regex in the schema accepts `2026-02-31`; only a real parse rejects it.
  if (!startDate) {
    throw new AppError('startDate is not a valid calendar date', 400, 'INVALID_DATE_RANGE');
  }
  if (!endDate) {
    throw new AppError('endDate is not a valid calendar date', 400, 'INVALID_DATE_RANGE');
  }

  if (startDate > endDate) {
    throw new AppError('startDate must not be after endDate', 400, 'INVALID_DATE_RANGE');
  }

  // A future end date is allowed and clamped rather than rejected: a client
  // ahead of the reporting boundary legitimately believes it is tomorrow, and
  // returning a validation error for "today" would be indefensible. Data for
  // future days cannot exist, so clamping changes nothing about the answer.
  const today = startOfReportingDay(now);
  const boundedEnd = endDate > today ? today : endDate;

  const earliest = reportingDaysAgo(MAX_LOOKBACK_DAYS, now);
  if (startDate < earliest) {
    throw new AppError(
      `startDate must be within the last ${MAX_LOOKBACK_DAYS} days — older aggregates are pruned`,
      400,
      'RANGE_TOO_OLD'
    );
  }

  // Re-check after clamping: an end date in the future could otherwise let a
  // range slip past the bucket cap on the strength of days that do not exist.
  if (startDate > boundedEnd) {
    throw new AppError('startDate must not be after endDate', 400, 'INVALID_DATE_RANGE');
  }

  return { startDate, endDate: boundedEnd, granularity: query.granularity };
}
