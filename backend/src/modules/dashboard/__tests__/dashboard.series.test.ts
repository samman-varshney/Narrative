import {
  bucketLabels,
  denseSeries,
  formatLabel,
  parseLabel,
  truncateToBucket,
} from '../dashboard.series';
import { excerpt, mergeActivity } from '../dashboard.mappers';
import type { ActivityItemDTO, DashboardRangeDTO } from '../dashboard.types';

/**
 * Bucket alignment, gap filling and activity merging — all pure.
 *
 * The bucket labels these produce have to match what Postgres's `date_trunc`
 * emits, or a "filled" bucket sits BESIDE the real one instead of replacing it
 * and the chart shows two points for one week. The agreement with Postgres is
 * asserted against the database itself in `dashboard.db.test.ts`; what is
 * checked here is the arithmetic in isolation, where a failure names the exact
 * rule that broke.
 */

const range = (
  startDate: string,
  endDate: string,
  granularity: DashboardRangeDTO['granularity']
): DashboardRangeDTO => ({ preset: '30d', startDate, endDate, granularity });

describe('truncateToBucket', () => {
  it('is a no-op for days', () => {
    const day = parseLabel('2026-08-20');
    expect(formatLabel(truncateToBucket(day, 'day'))).toBe('2026-08-20');
  });

  it('snaps a week back to MONDAY, matching date_trunc', () => {
    // 2026-08-20 is a Thursday; its ISO week began Monday the 17th.
    expect(formatLabel(truncateToBucket(parseLabel('2026-08-20'), 'week'))).toBe(
      '2026-08-17'
    );
    // A Sunday belongs to the week that STARTED on the previous Monday — the
    // case a `getUTCDay()`-based implementation gets wrong, because JavaScript
    // numbers Sunday as 0.
    expect(formatLabel(truncateToBucket(parseLabel('2026-08-23'), 'week'))).toBe(
      '2026-08-17'
    );
    // A Monday is its own bucket start.
    expect(formatLabel(truncateToBucket(parseLabel('2026-08-17'), 'week'))).toBe(
      '2026-08-17'
    );
  });

  it('snaps a month back to the first', () => {
    expect(formatLabel(truncateToBucket(parseLabel('2026-08-20'), 'month'))).toBe(
      '2026-08-01'
    );
    expect(formatLabel(truncateToBucket(parseLabel('2026-01-31'), 'month'))).toBe(
      '2026-01-01'
    );
  });
});

describe('bucketLabels', () => {
  it('emits every day in an inclusive range', () => {
    expect(bucketLabels(range('2026-08-18', '2026-08-21', 'day'))).toEqual([
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
    ]);
  });

  it('starts at the bucket CONTAINING the range start, not the start itself', () => {
    // The range opens on a Thursday. Any row in that week is bucketed to the
    // Monday BEFORE the range began, so a label list starting on the Thursday
    // would never match it.
    expect(bucketLabels(range('2026-08-20', '2026-09-02', 'week'))).toEqual([
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
  });

  it('walks months across a year boundary', () => {
    expect(bucketLabels(range('2025-11-15', '2026-02-03', 'month'))).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
  });

  it('handles a single-day range', () => {
    expect(bucketLabels(range('2026-08-20', '2026-08-20', 'day'))).toEqual(['2026-08-20']);
  });

  it('crosses a leap day', () => {
    expect(bucketLabels(range('2028-02-27', '2028-03-01', 'day'))).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });
});

describe('denseSeries', () => {
  const empty = (date: string) => ({ date, views: 0 });

  it('fills gaps without disturbing real points', () => {
    const points = [
      { date: '2026-08-18', views: 10 },
      { date: '2026-08-21', views: 4 },
    ];

    expect(denseSeries(points, range('2026-08-18', '2026-08-21', 'day'), empty)).toEqual([
      { date: '2026-08-18', views: 10 },
      { date: '2026-08-19', views: 0 },
      { date: '2026-08-20', views: 0 },
      { date: '2026-08-21', views: 4 },
    ]);
  });

  it('produces a full series from no data at all', () => {
    // The empty-dashboard case: a new author must get a flat line, not an
    // absent chart.
    const series = denseSeries([], range('2026-08-18', '2026-08-20', 'day'), empty);
    expect(series).toHaveLength(3);
    expect(series.every((point) => point.views === 0)).toBe(true);
  });

  it('is always ordered oldest first', () => {
    const points = [
      { date: '2026-08-20', views: 1 },
      { date: '2026-08-18', views: 2 },
    ];
    const series = denseSeries(points, range('2026-08-18', '2026-08-20', 'day'), empty);
    expect(series.map((point) => point.date)).toEqual([
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
    ]);
  });

  it('drops a point outside the range rather than appending it', () => {
    // A label the range does not contain means bucket alignment has broken.
    // Rendering it would put a point off the end of the chart's own axis.
    const points = [
      { date: '2026-08-19', views: 5 },
      { date: '2026-09-30', views: 99 },
    ];
    const series = denseSeries(points, range('2026-08-18', '2026-08-20', 'day'), empty);
    expect(series).toHaveLength(3);
    expect(series.some((point) => point.date === '2026-09-30')).toBe(false);
  });
});

describe('excerpt', () => {
  it('leaves short text alone, trimmed', () => {
    expect(excerpt('  hello  ', 20)).toBe('hello');
  });

  it('truncates to the budget INCLUDING the ellipsis', () => {
    const result = excerpt('x'.repeat(50), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('mergeActivity', () => {
  const item = (id: string, occurredAt: string): ActivityItemDTO => ({
    id,
    type: 'COMMENT_RECEIVED',
    occurredAt,
    actor: null,
    blog: null,
    excerpt: null,
  });

  it('interleaves sources newest first', () => {
    const merged = mergeActivity(
      [
        [item('comment:a', '2026-08-20T10:00:00.000Z')],
        [item('follow:b', '2026-08-20T11:00:00.000Z')],
        [item('blog:c', '2026-08-20T09:00:00.000Z')],
      ],
      10
    );

    expect(merged.map((row) => row.id)).toEqual(['follow:b', 'comment:a', 'blog:c']);
  });

  it('caps the feed after merging, not before', () => {
    // Trimming each source first would drop the newest item from a busy source.
    const merged = mergeActivity(
      [
        [
          item('comment:a', '2026-08-20T10:00:00.000Z'),
          item('comment:b', '2026-08-20T09:00:00.000Z'),
        ],
        [item('follow:c', '2026-08-20T12:00:00.000Z')],
      ],
      2
    );

    expect(merged.map((row) => row.id)).toEqual(['follow:c', 'comment:a']);
  });

  it('orders identical timestamps deterministically', () => {
    const same = '2026-08-20T10:00:00.000Z';
    const first = mergeActivity([[item('comment:a', same)], [item('follow:b', same)]], 10);
    const second = mergeActivity([[item('follow:b', same)], [item('comment:a', same)]], 10);

    // Without a tiebreaker the feed would reshuffle between two identical
    // requests, which reads to a user as data changing.
    expect(first.map((row) => row.id)).toEqual(second.map((row) => row.id));
  });

  it('returns an empty feed for an author with no activity', () => {
    expect(mergeActivity([[], [], []], 10)).toEqual([]);
  });
});
