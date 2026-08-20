import {
  cursorFingerprint,
  decodeCursor,
  encodeCursor,
} from '../moderation.cursor';

/**
 * Cursor mechanics.
 *
 * The properties tested here are the ones a paging bug hides behind: a cursor
 * must round-trip exactly, must refuse to be replayed against a different
 * query, and must refuse anything hand-made. None of these is observable from a
 * single request — they only show up as a moderator seeing a report twice, or
 * never seeing one.
 */

const position = { createdAt: new Date('2026-08-20T12:34:56.789Z'), id: 'report-1' };
const fingerprint = cursorFingerprint({ status: ['PENDING'], sort: 'asc' });

describe('round trip', () => {
  it('restores the exact position, to the millisecond', () => {
    const decoded = decodeCursor(encodeCursor(position, fingerprint), fingerprint);

    expect(decoded.id).toBe(position.id);
    // Millisecond fidelity is the point: a keyset that loses precision starts
    // repeating or skipping rows written in the same second.
    expect(decoded.createdAt.toISOString()).toBe(position.createdAt.toISOString());
  });

  it('produces a URL-safe token', () => {
    const cursor = encodeCursor(position, fingerprint);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });
});

describe('fingerprinting', () => {
  it('is stable regardless of key order', () => {
    // Two clients serializing the same filters differently must get the same
    // fingerprint, or one of them would have its own cursors rejected.
    expect(cursorFingerprint({ a: 1, b: 2 })).toBe(cursorFingerprint({ b: 2, a: 1 }));
  });

  it('changes when any part of the ordering changes', () => {
    const base = cursorFingerprint({ status: ['PENDING'], sort: 'asc' });
    expect(cursorFingerprint({ status: ['PENDING'], sort: 'desc' })).not.toBe(base);
    expect(cursorFingerprint({ status: ['RESOLVED'], sort: 'asc' })).not.toBe(base);
  });

  it('rejects a cursor replayed against a different query', () => {
    const cursor = encodeCursor(position, fingerprint);
    const other = cursorFingerprint({ status: ['RESOLVED'], sort: 'desc' });

    expect(() => decodeCursor(cursor, other)).toMatchObject; // narrow below
    try {
      decodeCursor(cursor, other);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, errorCode: 'INVALID_CURSOR' });
    }
  });
});

describe('hostile input', () => {
  it.each([
    ['not base64 at all', '!!!!'],
    ['base64 of nonsense', Buffer.from('hello').toString('base64url')],
    ['valid JSON, wrong shape', Buffer.from('{"x":1}').toString('base64url')],
    [
      'a payload with a bumped version',
      Buffer.from(JSON.stringify({ v: 999, f: 'x'.repeat(12), t: new Date().toISOString(), i: 'a' })).toString('base64url'),
    ],
    [
      'a payload with an over-long id',
      Buffer.from(JSON.stringify({ v: 1, f: 'x'.repeat(12), t: new Date().toISOString(), i: 'a'.repeat(200) })).toString('base64url'),
    ],
  ])('rejects %s with the same opaque 400', (_label, raw) => {
    try {
      decodeCursor(raw, fingerprint);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, errorCode: 'INVALID_CURSOR' });
    }
  });
});
