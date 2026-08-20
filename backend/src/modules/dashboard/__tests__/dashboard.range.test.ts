import { analyticsService } from '../../analytics/analytics.service';
import { RANGE_PRESETS } from '../dashboard.config';
import {
  estimateBuckets,
  inclusiveDayCount,
  pickGranularity,
  resolveRange,
  toSeriesQuery,
  toTotalsQuery,
} from '../dashboard.range';
import { FIXED_NOW } from './helpers';

/**
 * Range resolution — pure, no database, no Redis.
 *
 * The property under test throughout is that every preset produces a window the
 * Analytics module will ACCEPT. Two of its rules can reject one: the retention
 * horizon (a start date older than the aggregates go) and the bucket cap (more
 * points than a series response may carry). Both are silent until a request
 * 400s in production, so they are asserted here against the module's own
 * published limits rather than against numbers copied into this file.
 */

const { maxLookbackDays, maxBuckets } = analyticsService.getReportingLimits();

describe('inclusiveDayCount', () => {
  it('counts both ends', () => {
    expect(inclusiveDayCount('2026-08-20', '2026-08-20')).toBe(1);
    expect(inclusiveDayCount('2026-08-19', '2026-08-20')).toBe(2);
    expect(inclusiveDayCount('2026-08-01', '2026-08-31')).toBe(31);
  });

  it('is unaffected by the local timezone', () => {
    // The bounds are date LABELS carried as UTC midnights. A naive
    // implementation using local-time parsing drifts by a day for half the
    // world — and this suite runs in Asia/Calcutta, where it would.
    expect(inclusiveDayCount('2026-01-01', '2026-12-31')).toBe(365);
  });
});

describe('pickGranularity', () => {
  it('prefers daily resolution while it fits', () => {
    expect(pickGranularity(7, maxBuckets)).toBe('day');
    expect(pickGranularity(90, maxBuckets)).toBe('day');
    expect(pickGranularity(maxBuckets, maxBuckets)).toBe('day');
  });

  it('steps down to weekly rather than exceeding the cap', () => {
    expect(pickGranularity(maxBuckets + 1, maxBuckets)).toBe('week');
  });

  it('steps down again when even weekly would not fit', () => {
    // A tiny cap stands in for a very long retention window — the same
    // arithmetic, without needing a decade of days.
    expect(pickGranularity(400, 10)).toBe('month');
  });

  it('never returns a granularity that exceeds the cap', () => {
    for (const days of [1, 7, 30, 90, 365, maxLookbackDays + 1]) {
      const granularity = pickGranularity(days, maxBuckets);
      expect(estimateBuckets(days, granularity)).toBeLessThanOrEqual(maxBuckets);
    }
  });
});

describe('resolveRange', () => {
  it('ends today and covers exactly the preset length', () => {
    const range = resolveRange('7d', FIXED_NOW);

    expect(range.endDate).toBe('2026-08-20');
    expect(range.startDate).toBe('2026-08-14');
    expect(inclusiveDayCount(range.startDate, range.endDate)).toBe(7);
    expect(range.preset).toBe('7d');
  });

  it.each([
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const)('%s covers %i days at daily granularity', (preset, days) => {
    const range = resolveRange(preset, FIXED_NOW);
    expect(inclusiveDayCount(range.startDate, range.endDate)).toBe(days);
    expect(range.granularity).toBe('day');
  });

  it('resolves `all` to the retention horizon, not a hardcoded length', () => {
    const range = resolveRange('all', FIXED_NOW);

    // Exactly the oldest window Analytics accepts: one more day and every
    // `all` request would be rejected as RANGE_TOO_OLD.
    expect(inclusiveDayCount(range.startDate, range.endDate)).toBe(maxLookbackDays + 1);
  });

  it('coarsens `all` so it does not exceed the bucket cap', () => {
    const range = resolveRange('all', FIXED_NOW);
    const days = inclusiveDayCount(range.startDate, range.endDate);

    // With the default 400-day retention this is the case that forces weekly
    // buckets — the reason granularity is derived rather than accepted.
    expect(estimateBuckets(days, range.granularity)).toBeLessThanOrEqual(maxBuckets);
    if (days > maxBuckets) expect(range.granularity).not.toBe('day');
  });

  it('produces an Analytics-acceptable window for every preset', () => {
    for (const preset of RANGE_PRESETS) {
      const range = resolveRange(preset, FIXED_NOW);
      const days = inclusiveDayCount(range.startDate, range.endDate);

      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(maxLookbackDays + 1);
      expect(estimateBuckets(days, range.granularity)).toBeLessThanOrEqual(maxBuckets);
      expect(range.startDate <= range.endDate).toBe(true);
    }
  });

  it('emits YYYY-MM-DD labels, never timestamps', () => {
    const range = resolveRange('30d', FIXED_NOW);
    expect(range.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('moves with the clock', () => {
    const today = resolveRange('7d', FIXED_NOW);
    const tomorrow = resolveRange('7d', new Date('2026-08-21T12:00:00.000Z'));

    expect(tomorrow.endDate).toBe('2026-08-21');
    expect(tomorrow.startDate).not.toBe(today.startDate);
  });
});

describe('query projection', () => {
  it('gives the series API a granularity and the totals API none', () => {
    const range = resolveRange('30d', FIXED_NOW);

    expect(toSeriesQuery(range)).toEqual({
      startDate: range.startDate,
      endDate: range.endDate,
      granularity: range.granularity,
    });

    // `granularity` is deliberately absent: the totals endpoints collapse the
    // whole range into one set of numbers, and Analytics' schema for them does
    // not accept the parameter.
    expect(toTotalsQuery(range)).toEqual({
      startDate: range.startDate,
      endDate: range.endDate,
    });
  });
});
