import { AppError } from '../../../core/exceptions/AppError';
import { CANDIDATE_LIMIT } from '../feed.config';
import {
  canonicalize,
  decodeChronologicalCursor,
  decodeRankedCursor,
  encodeChronologicalCursor,
  encodeRankedCursor,
  feedFingerprint,
} from '../feed.cursor';

/**
 * Cursors are the module's correctness surface: everything the brief asks for
 * about pagination — no duplicates, no gaps, deterministic — reduces to a cursor
 * meaning exactly one position in exactly one ordering. These tests pin that.
 */

const FP = feedFingerprint({ feed: 'latest', filters: {} });

const expectInvalidCursor = (fn: () => unknown) => {
  try {
    fn();
    throw new Error('expected the cursor to be rejected');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).errorCode).toBe('INVALID_CURSOR');
  }
};

describe('feedFingerprint', () => {
  it('is stable across equivalent filter spellings', () => {
    const a = feedFingerprint({ feed: 'latest', filters: { tags: ['react', 'node'] } });
    const b = feedFingerprint({ feed: 'latest', filters: { tags: ['node', 'react'] } });
    expect(a).toBe(b);
  });

  it('differs per feed, so a cursor cannot be replayed against another one', () => {
    expect(feedFingerprint({ feed: 'latest', filters: {} })).not.toBe(
      feedFingerprint({ feed: 'explore', filters: {} })
    );
  });

  it('differs per viewer for the following feed', () => {
    expect(feedFingerprint({ feed: 'following', viewerId: 'u1' })).not.toBe(
      feedFingerprint({ feed: 'following', viewerId: 'u2' })
    );
  });

  it('differs when a filter or option changes', () => {
    expect(feedFingerprint({ feed: 'latest', filters: { author: 'grace' } })).not.toBe(FP);
    expect(feedFingerprint({ feed: 'trending', options: { window: '24h' } })).not.toBe(
      feedFingerprint({ feed: 'trending', options: { window: '7d' } })
    );
  });

  it('ignores page size — a client may change `limit` mid-walk', () => {
    // Not a fingerprint input at all; asserted here because it is the one
    // request field that deliberately does NOT invalidate a cursor.
    expect(feedFingerprint({ feed: 'latest', filters: {}, options: {} })).toBe(FP);
  });
});

describe('chronological cursors', () => {
  const sortAt = new Date('2026-05-01T10:20:30.000Z');

  it('round-trips a position', () => {
    const cursor = encodeChronologicalCursor({ fingerprint: FP, sortAt, id: 'blog-1' });
    expect(decodeChronologicalCursor(cursor, FP)).toEqual({ sortAt, id: 'blog-1' });
  });

  it('is opaque base64url, so it survives a query string untouched', () => {
    const cursor = encodeChronologicalCursor({ fingerprint: FP, sortAt, id: 'blog-1' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('rejects a cursor minted for a different request', () => {
    const cursor = encodeChronologicalCursor({ fingerprint: FP, sortAt, id: 'blog-1' });
    const other = feedFingerprint({ feed: 'latest', filters: { author: 'grace' } });
    expectInvalidCursor(() => decodeChronologicalCursor(cursor, other));
  });

  it('rejects a ranked cursor supplied to a chronological feed', () => {
    const ranked = encodeRankedCursor({
      fingerprint: FP,
      snapshotId: 'a'.repeat(32),
      offset: 0,
      bucketAt: sortAt,
    });
    expectInvalidCursor(() => decodeChronologicalCursor(ranked, FP));
  });

  it.each([
    ['not base64 at all', '!!!not-a-cursor!!!'],
    ['valid base64, not JSON', Buffer.from('nonsense').toString('base64url')],
    ['JSON of the wrong shape', Buffer.from(JSON.stringify({ hello: 1 })).toString('base64url')],
    [
      'a future cursor version',
      Buffer.from(JSON.stringify({ v: 99, k: 'c', f: FP, t: sortAt.toISOString(), i: 'x' })).toString(
        'base64url'
      ),
    ],
  ])('rejects %s with the same 400', (_label, cursor) => {
    expectInvalidCursor(() => decodeChronologicalCursor(cursor, FP));
  });
});

describe('ranked cursors', () => {
  const snapshotId = 'f'.repeat(32);
  const bucketAt = new Date('2026-05-01T10:20:00.000Z');

  it('round-trips the snapshot, the offset and the ranking bucket', () => {
    const cursor = encodeRankedCursor({ fingerprint: FP, snapshotId, offset: 40, bucketAt });
    expect(decodeRankedCursor(cursor, FP)).toEqual({ snapshotId, offset: 40, bucketAt });
  });

  it('carries the bucket so an evicted snapshot can be rebuilt identically', () => {
    // The bucket IS the ranking clock. Without it a rebuild would score against
    // "now" and produce a different ordering than the client is paging through.
    const cursor = encodeRankedCursor({ fingerprint: FP, snapshotId, offset: 20, bucketAt });
    expect(decodeRankedCursor(cursor, FP).bucketAt.toISOString()).toBe(bucketAt.toISOString());
  });

  it('rejects an offset beyond the candidate cap', () => {
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'r',
        f: FP,
        s: snapshotId,
        o: CANDIDATE_LIMIT + 1,
        b: Math.floor(bucketAt.getTime() / 1000),
      })
    ).toString('base64url');
    expectInvalidCursor(() => decodeRankedCursor(forged, FP));
  });

  it('rejects a negative offset', () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, k: 'r', f: FP, s: snapshotId, o: -1, b: 0 })
    ).toString('base64url');
    expectInvalidCursor(() => decodeRankedCursor(forged, FP));
  });

  it('rejects a chronological cursor supplied to a ranked feed', () => {
    const chronological = encodeChronologicalCursor({
      fingerprint: FP,
      sortAt: bucketAt,
      id: 'blog-1',
    });
    expectInvalidCursor(() => decodeRankedCursor(chronological, FP));
  });

  it('rejects a cursor minted for a different window', () => {
    const trending7 = feedFingerprint({ feed: 'trending', options: { window: '7d' } });
    const trending24 = feedFingerprint({ feed: 'trending', options: { window: '24h' } });
    const cursor = encodeRankedCursor({
      fingerprint: trending7,
      snapshotId,
      offset: 20,
      bucketAt,
    });
    expectInvalidCursor(() => decodeRankedCursor(cursor, trending24));
  });
});

describe('canonicalize', () => {
  it('sorts keys and arrays, and drops undefined', () => {
    expect(canonicalize({ b: 1, a: ['c', 'a', 'b'], c: undefined })).toEqual({
      a: ['a', 'b', 'c'],
      b: 1,
    });
  });

  it('renders dates as ISO strings', () => {
    expect(canonicalize(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });

  it('passes primitives through', () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(7)).toBe(7);
    expect(canonicalize('x')).toBe('x');
  });
});
