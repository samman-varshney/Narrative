import { AppError } from '../../../core/exceptions/AppError';
import {
  canonicalize,
  cursorFingerprint,
  decodeCursor,
  encodeCursor,
} from '../search.cursor';

const FINGERPRINT = cursorFingerprint({ query: 'javascript', sort: 'relevance' });

function expectInvalidCursor(fn: () => unknown) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (err) {
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).errorCode).toBe('INVALID_CURSOR');
  }
}

describe('encodeCursor / decodeCursor', () => {
  const timestamp = new Date('2026-03-01T12:00:00.000Z');

  it('round-trips a position exactly', () => {
    const cursor = encodeCursor({
      fingerprint: FINGERPRINT,
      score: '12.007679',
      timestamp,
      id: 'blog-1',
    });

    expect(decodeCursor(cursor, FINGERPRINT)).toEqual({
      score: '12.007679',
      timestamp,
      id: 'blog-1',
    });
  });

  it('carries the score as a decimal STRING, never a float', () => {
    // The keyset predicate compares `score = :score` as numeric. Round-tripping
    // through a JS double could shift the value by one ULP and drop a row from
    // the walk — so the exact decimal text is what travels.
    const score = '0.100000000000000005';
    const cursor = encodeCursor({ fingerprint: FINGERPRINT, score, timestamp, id: 'b' });

    expect(decodeCursor(cursor, FINGERPRINT).score).toBe(score);
  });

  it('allows a null score for the recency sorts', () => {
    const cursor = encodeCursor({
      fingerprint: FINGERPRINT,
      score: null,
      timestamp,
      id: 'blog-1',
    });

    expect(decodeCursor(cursor, FINGERPRINT).score).toBeNull();
  });

  it('produces a URL-safe token', () => {
    const cursor = encodeCursor({
      fingerprint: FINGERPRINT,
      score: '1.5',
      timestamp,
      id: 'blog-1',
    });

    expect(cursor).toBe(encodeURIComponent(cursor));
  });
});

describe('cursor validation', () => {
  const valid = encodeCursor({
    fingerprint: FINGERPRINT,
    score: '1.5',
    timestamp: new Date('2026-03-01T12:00:00.000Z'),
    id: 'blog-1',
  });

  it('rejects a cursor minted for a different query', () => {
    const other = cursorFingerprint({ query: 'typescript', sort: 'relevance' });

    expectInvalidCursor(() => decodeCursor(valid, other));
  });

  it('rejects a cursor minted for a different sort', () => {
    const other = cursorFingerprint({ query: 'javascript', sort: 'newest' });

    expectInvalidCursor(() => decodeCursor(valid, other));
  });

  it('rejects a cursor minted for different filters', () => {
    const other = cursorFingerprint({
      query: 'javascript',
      sort: 'relevance',
      filters: { author: 'grace' },
    });

    expectInvalidCursor(() => decodeCursor(valid, other));
  });

  it.each([
    ['not base64 at all', '!!!not-base64!!!'],
    ['base64 of non-JSON', Buffer.from('hello').toString('base64url')],
    ['an empty string', ''],
    ['a JSON array', Buffer.from('[]').toString('base64url')],
  ])('rejects %s', (_label, raw) => {
    expectInvalidCursor(() => decodeCursor(raw, FINGERPRINT));
  });

  it('rejects a cursor from an older payload version', () => {
    const stale = Buffer.from(
      JSON.stringify({ v: 0, f: FINGERPRINT, s: '1.5', t: '2026-03-01T12:00:00.000Z', i: 'b' })
    ).toString('base64url');

    expectInvalidCursor(() => decodeCursor(stale, FINGERPRINT));
  });

  it('rejects a tampered score that is not a decimal', () => {
    // A hand-edited cursor must never reach the SQL as a `::numeric` cast that
    // errors at the database — it is refused at the boundary.
    const tampered = Buffer.from(
      JSON.stringify({
        v: 1,
        f: FINGERPRINT,
        s: "1; DROP TABLE",
        t: '2026-03-01T12:00:00.000Z',
        i: 'b',
      })
    ).toString('base64url');

    expectInvalidCursor(() => decodeCursor(tampered, FINGERPRINT));
  });

  it('rejects a malformed timestamp', () => {
    const tampered = Buffer.from(
      JSON.stringify({ v: 1, f: FINGERPRINT, s: '1.5', t: 'yesterday', i: 'b' })
    ).toString('base64url');

    expectInvalidCursor(() => decodeCursor(tampered, FINGERPRINT));
  });

  it('rejects a missing row id', () => {
    const tampered = Buffer.from(
      JSON.stringify({ v: 1, f: FINGERPRINT, s: '1.5', t: '2026-03-01T12:00:00.000Z', i: '' })
    ).toString('base64url');

    expectInvalidCursor(() => decodeCursor(tampered, FINGERPRINT));
  });
});

describe('cursorFingerprint', () => {
  it('is stable across filter key order', () => {
    const a = cursorFingerprint({
      query: 'js',
      sort: 'relevance',
      filters: { author: 'grace', tags: ['react'] },
    });
    const b = cursorFingerprint({
      query: 'js',
      sort: 'relevance',
      filters: { tags: ['react'], author: 'grace' },
    });

    expect(a).toBe(b);
  });

  it('is stable across array order within a filter', () => {
    const a = cursorFingerprint({ query: 'js', sort: 'relevance', filters: { tags: ['a', 'b'] } });
    const b = cursorFingerprint({ query: 'js', sort: 'relevance', filters: { tags: ['b', 'a'] } });

    expect(a).toBe(b);
  });

  it('ignores undefined filter values', () => {
    const bare = cursorFingerprint({ query: 'js', sort: 'relevance', filters: {} });
    const withUndefined = cursorFingerprint({
      query: 'js',
      sort: 'relevance',
      filters: { author: undefined },
    });

    expect(bare).toBe(withUndefined);
  });

  it('changes when a filter value changes', () => {
    const a = cursorFingerprint({ query: 'js', sort: 'relevance', filters: { author: 'grace' } });
    const b = cursorFingerprint({ query: 'js', sort: 'relevance', filters: { author: 'alan' } });

    expect(a).not.toBe(b);
  });
});

describe('canonicalize', () => {
  it('serializes Dates so two equal dates fingerprint identically', () => {
    expect(canonicalize(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });

  it('sorts nested object keys and array members', () => {
    expect(canonicalize({ b: 1, a: [3, 1, 2] })).toEqual({ a: [1, 2, 3], b: 1 });
  });

  it('leaves primitives alone', () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(7)).toBe(7);
    expect(canonicalize('x')).toBe('x');
  });
});
