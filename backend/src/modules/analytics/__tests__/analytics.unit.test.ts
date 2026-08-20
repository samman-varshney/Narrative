import { AppError } from '../../../core/exceptions/AppError';
import { resolveDateRange, resolveTotalsRange } from '../analytics.range';
import {
  decodeTopBlogsCursor,
  encodeTopBlogsCursor,
  topBlogsFingerprint,
} from '../analytics.cursor';
import { buildReportKey, canonicalize } from '../analytics.cache';
import {
  blogDirtyMember,
  hashIdentity,
  parseDirtyMember,
  userDirtyMember,
  viewerIdentity,
} from '../analytics.keys';
import {
  bucketsAreSingleDays,
  dateKey,
  estimateBucketCount,
  inclusiveDayCount,
  parseDateKey,
  rangeIsSingleDay,
  reportingDateKey,
  reportingDaysAgo,
  startOfReportingDay,
} from '../analytics.time';
import { MAX_BUCKETS, MAX_LOOKBACK_DAYS, readTelemetrySchema } from '../analytics.validator';

/**
 * Pure-logic tests for the Analytics module: no Redis, no PostgreSQL, no HTTP.
 *
 * Everything here is a decision the module makes before it touches
 * infrastructure — which day a timestamp belongs to, whether a range is
 * serveable, whether a cursor belongs to this query, what a key looks like.
 * These are exactly the rules that are cheap to get subtly wrong and expensive
 * to notice, because a wrong answer still looks like a number.
 */

const NOW = new Date('2026-08-20T14:30:00.000Z');

describe('analytics time helpers', () => {
  it('buckets a timestamp by its reporting day, not the local one', () => {
    // Times adjacent to the boundary are where a local-time implementation
    // silently files a view under the wrong day.
    expect(reportingDateKey(new Date('2026-08-20T23:59:59.999Z'), 0)).toBe('2026-08-20');
    expect(reportingDateKey(new Date('2026-08-21T00:00:00.000Z'), 0)).toBe('2026-08-21');
  });

  it('rejects a date that looks valid but does not exist', () => {
    // `new Date('2026-02-31')` rolls forward to March 3 rather than failing, so
    // a regex-only check would accept it and silently shift the range.
    expect(parseDateKey('2026-02-31')).toBeNull();
    expect(parseDateKey('2026-13-01')).toBeNull();
    expect(parseDateKey('not-a-date')).toBeNull();
    expect(parseDateKey('2026-02-28')).toEqual(new Date('2026-02-28T00:00:00.000Z'));
  });

  it('counts days inclusively at both ends', () => {
    const start = new Date('2026-08-01T00:00:00.000Z');
    expect(inclusiveDayCount(start, start)).toBe(1);
    expect(inclusiveDayCount(start, new Date('2026-08-31T00:00:00.000Z'))).toBe(31);
  });

  it('estimates buckets per granularity without ever under-counting', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    const end = new Date('2026-12-31T00:00:00.000Z');

    expect(estimateBucketCount(start, end, 'day')).toBe(365);
    // Estimates must never be LOW, or a range could slip past the cap.
    expect(estimateBucketCount(start, end, 'week')).toBeGreaterThanOrEqual(53);
    expect(estimateBucketCount(start, end, 'month')).toBeGreaterThanOrEqual(12);
  });

  it('walks back whole reporting days regardless of the time of day', () => {
    expect(dateKey(reportingDaysAgo(0, NOW, 0))).toBe('2026-08-20');
    expect(dateKey(reportingDaysAgo(30, NOW, 0))).toBe('2026-07-21');
  });
});

describe('reporting timezone offset', () => {
  const IST = 330; // UTC+5:30
  const PACIFIC = -480; // UTC-8

  it('files an evening view in the local day, not the next UTC one', () => {
    // 19:00 Tokyo on the 20th is 10:00 UTC on the 20th — fine either way. The
    // case that breaks under UTC is 23:00 Tokyo: 14:00 UTC, still the 20th in
    // UTC but already the 21st locally at +9.
    const evening = new Date('2026-08-20T16:00:00.000Z');
    expect(reportingDateKey(evening, 0)).toBe('2026-08-20');
    expect(reportingDateKey(evening, 540)).toBe('2026-08-21');
  });

  it('files a pre-dawn view in the previous local day at a negative offset', () => {
    // 02:00 UTC on the 21st is 18:00 Pacific on the 20th — the evening peak
    // that UTC bucketing files under tomorrow.
    const preDawn = new Date('2026-08-21T02:00:00.000Z');
    expect(reportingDateKey(preDawn, 0)).toBe('2026-08-21');
    expect(reportingDateKey(preDawn, PACIFIC)).toBe('2026-08-20');
  });

  it('moves "today" for default ranges too', () => {
    // 20:00 UTC is already the 21st in IST, so an author's default window must
    // end on the 21st — otherwise the dashboard omits the day they are in.
    const evening = new Date('2026-08-20T20:00:00.000Z');
    expect(dateKey(startOfReportingDay(evening, 0))).toBe('2026-08-20');
    expect(dateKey(startOfReportingDay(evening, IST))).toBe('2026-08-21');
  });

  it('keeps every reporting day exactly 24 hours long', () => {
    // The reason this is a fixed offset and not an IANA zone: no 23- or
    // 25-hour days, so day-over-day comparisons stay meaningful.
    const start = startOfReportingDay(new Date('2026-03-08T12:00:00.000Z'), PACIFIC);
    const next = startOfReportingDay(new Date('2026-03-09T12:00:00.000Z'), PACIFIC);
    expect(next.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('formats a resolved bound without re-applying the offset', () => {
    // The double-shift guard. `dateKey` takes a LABEL; feeding it an offset
    // would slide every range bound by a day at IST.
    const label = startOfReportingDay(new Date('2026-08-20T20:00:00.000Z'), IST);
    expect(dateKey(label)).toBe('2026-08-21');
    expect(dateKey(label)).toBe(dateKey(label));
  });
});

/**
 * The wiring, not the arithmetic.
 *
 * The helpers above are tested with an explicit offset, which proves the maths
 * but not that anything reads the setting. This reloads the module graph with a
 * real environment variable set and checks the value actually reaches both
 * places a day boundary is decided: the bucket a view is filed under, and the
 * default reporting window. A helper nobody calls is the likelier failure here.
 */
describe('reporting offset wiring', () => {
  const ORIGINAL = process.env.ANALYTICS_REPORTING_UTC_OFFSET_MINUTES;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ANALYTICS_REPORTING_UTC_OFFSET_MINUTES;
    else process.env.ANALYTICS_REPORTING_UTC_OFFSET_MINUTES = ORIGINAL;
    jest.resetModules();
  });

  it('reads the configured offset and applies it to both bucketing and defaults', () => {
    process.env.ANALYTICS_REPORTING_UTC_OFFSET_MINUTES = '330'; // IST

    jest.isolateModules(() => {
      const time = require('../analytics.time');
      const ranges = require('../analytics.range');

      expect(time.REPORTING_OFFSET_MINUTES).toBe(330);

      // 20:00 UTC on the 20th is 01:30 on the 21st in IST.
      const evening = new Date('2026-08-20T20:00:00.000Z');
      expect(time.reportingDateKey(evening)).toBe('2026-08-21');

      // ...and the default window must end on that same day, or the dashboard
      // silently omits the day the author is standing in.
      const range = ranges.resolveDateRange({ granularity: 'day' }, evening);
      expect(time.dateKey(range.endDate)).toBe('2026-08-21');
    });
  });

  it('defaults to UTC when the variable is unset', () => {
    delete process.env.ANALYTICS_REPORTING_UTC_OFFSET_MINUTES;

    jest.isolateModules(() => {
      const time = require('../analytics.time');
      expect(time.REPORTING_OFFSET_MINUTES).toBe(0);
      expect(time.reportingDateKey(new Date('2026-08-20T20:00:00.000Z'))).toBe('2026-08-20');
    });
  });
});

describe('exact-unique eligibility', () => {
  it('allows an exact unique count only when a bucket is one day', () => {
    expect(bucketsAreSingleDays('day')).toBe(true);
    expect(bucketsAreSingleDays('week')).toBe(false);
    expect(bucketsAreSingleDays('month')).toBe(false);
  });

  it('allows an exact unique count only when a range is one day', () => {
    const day = new Date('2026-08-20T00:00:00.000Z');
    expect(rangeIsSingleDay({ startDate: day, endDate: day })).toBe(true);
    expect(
      rangeIsSingleDay({ startDate: day, endDate: new Date('2026-08-21T00:00:00.000Z') })
    ).toBe(false);
  });
});

describe('resolveDateRange', () => {
  const query = (overrides: Partial<Parameters<typeof resolveDateRange>[0]> = {}) => ({
    granularity: 'day' as const,
    ...overrides,
  });

  it('defaults to the last 30 days, inclusive of today', () => {
    const range = resolveDateRange(query(), NOW);

    expect(dateKey(range.startDate)).toBe('2026-07-22');
    expect(dateKey(range.endDate)).toBe('2026-08-20');
    expect(inclusiveDayCount(range.startDate, range.endDate)).toBe(30);
  });

  it('honours explicit dates', () => {
    const range = resolveDateRange(
      query({ startDate: '2026-08-01', endDate: '2026-08-10' }),
      NOW
    );

    expect(dateKey(range.startDate)).toBe('2026-08-01');
    expect(dateKey(range.endDate)).toBe('2026-08-10');
  });

  it('rejects a reversed range', () => {
    expect(() =>
      resolveDateRange(query({ startDate: '2026-08-10', endDate: '2026-08-01' }), NOW)
    ).toThrow(AppError);
  });

  it('clamps a future endDate instead of rejecting it', () => {
    // A client east of UTC genuinely believes it is already tomorrow. Erroring
    // on "today" would be indefensible, and future days hold no data anyway.
    const range = resolveDateRange(
      query({ startDate: '2026-08-01', endDate: '2027-01-01' }),
      NOW
    );

    expect(dateKey(range.endDate)).toBe('2026-08-20');
  });

  it('rejects a range that would produce more than MAX_BUCKETS points', () => {
    // The brief's "no ten years of daily data" rule.
    expect(() =>
      resolveDateRange(query({ startDate: '2025-08-01', endDate: '2026-08-20' }), NOW)
    ).toThrow(/RANGE_TOO_LARGE|data points/);

    let thrown: AppError | undefined;
    try {
      resolveDateRange(query({ startDate: '2025-08-01', endDate: '2026-08-20' }), NOW);
    } catch (err) {
      thrown = err as AppError;
    }
    expect(thrown?.errorCode).toBe('RANGE_TOO_LARGE');
    expect(thrown?.statusCode).toBe(400);
  });

  it('allows a full year of DAILY points — the useful high-resolution case', () => {
    const range = resolveDateRange(
      query({ startDate: '2025-08-21', endDate: '2026-08-20' }),
      NOW
    );

    expect(inclusiveDayCount(range.startDate, range.endDate)).toBe(365);
  });

  it('accepts the SAME range at a coarser granularity', () => {
    // The cap is on points returned, not days requested — so the answer to
    // "too many points" is a coarser bucket, and the API has to honour that.
    const range = resolveDateRange(
      query({ startDate: '2025-08-01', endDate: '2026-08-20', granularity: 'week' }),
      NOW
    );

    expect(range.granularity).toBe('week');
    expect(estimateBucketCount(range.startDate, range.endDate, 'week')).toBeLessThan(
      MAX_BUCKETS
    );
  });

  it('rejects a start date older than the retention window', () => {
    const tooOld = dateKey(reportingDaysAgo(MAX_LOOKBACK_DAYS + 10, NOW));

    let thrown: AppError | undefined;
    try {
      resolveDateRange(query({ startDate: tooOld, endDate: '2026-08-20' }), NOW);
    } catch (err) {
      thrown = err as AppError;
    }
    // Distinct from RANGE_TOO_LARGE: the data is gone, not merely too much.
    expect(thrown?.errorCode).toBe('RANGE_TOO_OLD');
  });

  it('rejects a syntactically valid but non-existent calendar date', () => {
    expect(() => resolveDateRange(query({ startDate: '2026-02-31' }), NOW)).toThrow(AppError);
  });
});

describe('resolveTotalsRange', () => {
  it('accepts a range that the bucket cap would reject', () => {
    // `overview` and `reading` return ONE set of totals whatever the range, from
    // a single indexed aggregate — so "too many data points" is not a failure
    // mode they have, and rejecting a year-long overview would be an error the
    // query does not deserve.
    const range = resolveTotalsRange({ startDate: '2025-08-01', endDate: '2026-08-20' }, NOW);

    expect(dateKey(range.startDate)).toBe('2025-08-01');
    expect(dateKey(range.endDate)).toBe('2026-08-20');
  });

  it('still enforces the retention bound', () => {
    const tooOld = dateKey(reportingDaysAgo(MAX_LOOKBACK_DAYS + 10, NOW));

    // That one is about data that no longer exists, so it applies everywhere.
    expect(() => resolveTotalsRange({ startDate: tooOld }, NOW)).toThrow(AppError);
  });

  it('still rejects a reversed range', () => {
    expect(() =>
      resolveTotalsRange({ startDate: '2026-08-10', endDate: '2026-08-01' }, NOW)
    ).toThrow(AppError);
  });

  it('defaults to the same 30-day window', () => {
    const range = resolveTotalsRange({}, NOW);

    expect(dateKey(range.startDate)).toBe('2026-07-22');
    expect(dateKey(range.endDate)).toBe('2026-08-20');
  });
});

describe('top-blogs cursor', () => {
  const fingerprint = topBlogsFingerprint({
    authorId: 'author-1',
    metric: 'views',
    startDate: new Date('2026-08-01T00:00:00.000Z'),
    endDate: new Date('2026-08-20T00:00:00.000Z'),
  });

  it('round-trips a keyset position', () => {
    const cursor = encodeTopBlogsCursor(fingerprint, { metricValue: 42, blogId: 'blog-9' });

    expect(decodeTopBlogsCursor(cursor, fingerprint)).toEqual({
      metricValue: 42,
      blogId: 'blog-9',
    });
  });

  it('is URL-safe', () => {
    const cursor = encodeTopBlogsCursor(fingerprint, { metricValue: 1, blogId: 'b/+=' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a cursor minted for a different metric', () => {
    const cursor = encodeTopBlogsCursor(fingerprint, { metricValue: 42, blogId: 'blog-9' });
    const other = topBlogsFingerprint({
      authorId: 'author-1',
      metric: 'comments',
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-20T00:00:00.000Z'),
    });

    // Without this the value 42 would be compared against a comment-count
    // distribution and return an arbitrary slice that looks entirely plausible.
    expect(() => decodeTopBlogsCursor(cursor, other)).toThrow(AppError);
  });

  it('refuses a cursor minted for a different date range', () => {
    const cursor = encodeTopBlogsCursor(fingerprint, { metricValue: 42, blogId: 'blog-9' });
    const other = topBlogsFingerprint({
      authorId: 'author-1',
      metric: 'views',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(() => decodeTopBlogsCursor(cursor, other)).toThrow(AppError);
  });

  it('refuses another author’s cursor', () => {
    const cursor = encodeTopBlogsCursor(fingerprint, { metricValue: 42, blogId: 'blog-9' });
    const other = topBlogsFingerprint({
      authorId: 'author-2',
      metric: 'views',
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(() => decodeTopBlogsCursor(cursor, other)).toThrow(AppError);
  });

  it('refuses garbage without leaking why', () => {
    for (const bad of ['', 'not-base64!!', Buffer.from('{}').toString('base64url')]) {
      let thrown: AppError | undefined;
      try {
        decodeTopBlogsCursor(bad, fingerprint);
      } catch (err) {
        thrown = err as AppError;
      }
      expect(thrown?.errorCode).toBe('INVALID_CURSOR');
      expect(thrown?.statusCode).toBe(400);
    }
  });
});

describe('cache keys', () => {
  it('is stable across key order in the parts bag', () => {
    const a = buildReportKey('user-views', 'u1', 3, { start: '2026-08-01', end: '2026-08-20' });
    const b = buildReportKey('user-views', 'u1', 3, { end: '2026-08-20', start: '2026-08-01' });

    // Without canonicalization, the same request spelled two ways would each
    // pay for its own miss forever.
    expect(a).toBe(b);
  });

  it('separates owners, generations, scopes and ranges', () => {
    const base = { start: '2026-08-01', end: '2026-08-20', granularity: 'day' };

    const key = buildReportKey('user-views', 'u1', 3, base);
    expect(key).not.toBe(buildReportKey('user-views', 'u2', 3, base));
    expect(key).not.toBe(buildReportKey('user-views', 'u1', 4, base));
    expect(key).not.toBe(buildReportKey('user-engagement', 'u1', 3, base));
    expect(key).not.toBe(buildReportKey('user-views', 'u1', 3, { ...base, end: '2026-08-19' }));
  });

  it('embeds the generation so a bump makes old keys unreachable', () => {
    expect(buildReportKey('user-views', 'u1', 7, {})).toContain(':g7:');
  });

  it('drops undefined but keeps null, which is a real filter value', () => {
    expect(canonicalize({ a: undefined, b: null })).toEqual({ b: null });
  });
});

describe('identity hashing', () => {
  it('is deterministic for the same reader', () => {
    expect(hashIdentity('u:user-1')).toBe(hashIdentity('u:user-1'));
  });

  it('never contains the raw identifier', () => {
    // The whole point: a Redis dump must not be a list of who read what.
    expect(hashIdentity('u:user-1')).not.toContain('user-1');
  });

  it('separates a user id from an anonymous id with the same value', () => {
    expect(viewerIdentity({ userId: 'x' })).not.toBe(viewerIdentity({ anonymousId: 'x' }));
  });

  it('prefers the user id, so one person is one reader across devices', () => {
    expect(viewerIdentity({ userId: 'u1', anonymousId: 'a1' })).toBe(hashIdentity('u:u1'));
  });

  it('returns null when the caller offered no identity at all', () => {
    // Such a view is still counted — it just cannot be deduplicated. The
    // alternative would be deriving identity from an IP address.
    expect(viewerIdentity({})).toBeNull();
  });
});

describe('dirty set members', () => {
  it('round-trips a blog bucket', () => {
    expect(parseDirtyMember(blogDirtyMember('blog-1', '2026-08-20'))).toEqual({
      scope: 'blog',
      id: 'blog-1',
      date: '2026-08-20',
    });
  });

  it('round-trips a user bucket', () => {
    expect(parseDirtyMember(userDirtyMember('user-1', '2026-08-20'))).toEqual({
      scope: 'user',
      id: 'user-1',
      date: '2026-08-20',
    });
  });

  it('rejects malformed members rather than throwing mid-flush', () => {
    // A stray value written by an older build must skip one bucket, not take
    // down the flush for every other bucket in the batch.
    for (const bad of ['', 'blog|only-two', 'nope|id|2026-08-20', 'blog|id|20260820']) {
      expect(parseDirtyMember(bad)).toBeNull();
    }
  });
});

describe('reading telemetry schema', () => {
  const valid = {
    event: 'BLOG_READ_COMPLETED',
    sessionId: 'abcdefghijklmnop',
    durationSeconds: 120,
  };

  it('accepts a well-formed completion', () => {
    expect(readTelemetrySchema.safeParse(valid).success).toBe(true);
  });

  it('refuses any event a client is not allowed to report', () => {
    // A client that could post BLOG_VIEWED or BLOG_BOOKMARKED could manufacture
    // engagement for any blog on the platform.
    for (const event of ['BLOG_VIEWED', 'BLOG_BOOKMARKED', 'USER_FOLLOWED']) {
      expect(readTelemetrySchema.safeParse({ ...valid, event }).success).toBe(false);
    }
  });

  it('bounds client identifiers, which become Redis key segments', () => {
    expect(readTelemetrySchema.safeParse({ ...valid, sessionId: 'short' }).success).toBe(false);
    expect(readTelemetrySchema.safeParse({ ...valid, sessionId: 'a'.repeat(65) }).success).toBe(
      false
    );
    // A colon would let a client forge another reader's key segment.
    expect(
      readTelemetrySchema.safeParse({ ...valid, sessionId: 'aaaaaaaa:aaaaaaaa' }).success
    ).toBe(false);
  });

  it('rejects an absurd claimed duration at the edge', () => {
    expect(readTelemetrySchema.safeParse({ ...valid, durationSeconds: 1e9 }).success).toBe(false);
    expect(readTelemetrySchema.safeParse({ ...valid, durationSeconds: -1 }).success).toBe(false);
  });

  it('allows a completion with no claimed duration', () => {
    // The server measures it instead.
    const { durationSeconds: _omitted, ...withoutDuration } = valid;
    expect(readTelemetrySchema.safeParse(withoutDuration).success).toBe(true);
  });
});
