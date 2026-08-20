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
  estimateBucketCount,
  inclusiveDayCount,
  parseUtcDateKey,
  utcDateKey,
  utcDaysAgo,
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
  it('buckets a timestamp by its UTC day, not the local one', () => {
    // 23:30 UTC-adjacent times are where a local-time implementation silently
    // files a view under the wrong day.
    expect(utcDateKey(new Date('2026-08-20T23:59:59.999Z'))).toBe('2026-08-20');
    expect(utcDateKey(new Date('2026-08-21T00:00:00.000Z'))).toBe('2026-08-21');
  });

  it('rejects a date that looks valid but does not exist', () => {
    // `new Date('2026-02-31')` rolls forward to March 3 rather than failing, so
    // a regex-only check would accept it and silently shift the range.
    expect(parseUtcDateKey('2026-02-31')).toBeNull();
    expect(parseUtcDateKey('2026-13-01')).toBeNull();
    expect(parseUtcDateKey('not-a-date')).toBeNull();
    expect(parseUtcDateKey('2026-02-28')).toEqual(new Date('2026-02-28T00:00:00.000Z'));
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

  it('walks back whole UTC days regardless of the time of day', () => {
    expect(utcDateKey(utcDaysAgo(0, NOW))).toBe('2026-08-20');
    expect(utcDateKey(utcDaysAgo(30, NOW))).toBe('2026-07-21');
  });
});

describe('resolveDateRange', () => {
  const query = (overrides: Partial<Parameters<typeof resolveDateRange>[0]> = {}) => ({
    granularity: 'day' as const,
    ...overrides,
  });

  it('defaults to the last 30 days, inclusive of today', () => {
    const range = resolveDateRange(query(), NOW);

    expect(utcDateKey(range.startDate)).toBe('2026-07-22');
    expect(utcDateKey(range.endDate)).toBe('2026-08-20');
    expect(inclusiveDayCount(range.startDate, range.endDate)).toBe(30);
  });

  it('honours explicit dates', () => {
    const range = resolveDateRange(
      query({ startDate: '2026-08-01', endDate: '2026-08-10' }),
      NOW
    );

    expect(utcDateKey(range.startDate)).toBe('2026-08-01');
    expect(utcDateKey(range.endDate)).toBe('2026-08-10');
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

    expect(utcDateKey(range.endDate)).toBe('2026-08-20');
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
    const tooOld = utcDateKey(utcDaysAgo(MAX_LOOKBACK_DAYS + 10, NOW));

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

    expect(utcDateKey(range.startDate)).toBe('2025-08-01');
    expect(utcDateKey(range.endDate)).toBe('2026-08-20');
  });

  it('still enforces the retention bound', () => {
    const tooOld = utcDateKey(utcDaysAgo(MAX_LOOKBACK_DAYS + 10, NOW));

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

    expect(utcDateKey(range.startDate)).toBe('2026-07-22');
    expect(utcDateKey(range.endDate)).toBe('2026-08-20');
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
