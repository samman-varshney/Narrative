import type { Request, Response } from 'express';
import {
  HTTP_MAX_AGE_SECONDS,
  HTTP_STALE_WHILE_REVALIDATE_SECONDS,
  RSS_CONTENT_TYPE,
} from '../rss.config';
import { applyFeedHeaders, isNotModified, parseHttpDate } from '../rss.http';
import type { RenderedFeed } from '../rss.types';

/**
 * Conditional-request handling.
 *
 * Pure header logic, tested without Express. The two rules most often got wrong
 * are the ones with the most cases here: `If-None-Match` takes precedence over
 * `If-Modified-Since`, and entity tags compare WEAKLY.
 */

const LAST_MODIFIED = new Date('2026-03-02T08:00:00.000Z');

const FEED: RenderedFeed = {
  body: '<rss/>',
  contentType: RSS_CONTENT_TYPE,
  etag: '"abc123"',
  lastModified: LAST_MODIFIED,
  itemCount: 3,
};

const req = (headers: Record<string, string | string[]> = {}): Request =>
  ({ headers } as unknown as Request);

function fakeRes() {
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
  } as unknown as Response;
  return { res, headers };
}

describe('If-None-Match', () => {
  it('reports not-modified for an exact match', () => {
    expect(isNotModified(req({ 'if-none-match': '"abc123"' }), FEED)).toBe(true);
  });

  it('reports modified for a different tag', () => {
    expect(isNotModified(req({ 'if-none-match': '"different"' }), FEED)).toBe(false);
  });

  it('compares weakly, so a proxy that weakened the tag still gets a 304', () => {
    // A strict comparison here would 200 every client behind such a proxy and
    // silently switch the whole caching layer off.
    expect(isNotModified(req({ 'if-none-match': 'W/"abc123"' }), FEED)).toBe(true);
  });

  it('accepts a list and matches any member of it', () => {
    expect(
      isNotModified(req({ 'if-none-match': '"old", W/"abc123", "older"' }), FEED)
    ).toBe(true);
    expect(isNotModified(req({ 'if-none-match': '"one", "two"' }), FEED)).toBe(false);
  });

  it('treats * as a match against any current representation', () => {
    expect(isNotModified(req({ 'if-none-match': '*' }), FEED)).toBe(true);
  });

  it('recombines a repeated header into one list', () => {
    expect(
      isNotModified(req({ 'if-none-match': ['"old"', '"abc123"'] }), FEED)
    ).toBe(true);
  });

  it('reports modified for a malformed value rather than guessing', () => {
    expect(isNotModified(req({ 'if-none-match': 'abc123' }), FEED)).toBe(false);
    expect(isNotModified(req({ 'if-none-match': '' }), FEED)).toBe(false);
  });
});

describe('If-Modified-Since', () => {
  it('reports not-modified when the feed has not changed since', () => {
    expect(
      isNotModified(req({ 'if-modified-since': LAST_MODIFIED.toUTCString() }), FEED)
    ).toBe(true);
  });

  it('reports modified when the feed is newer', () => {
    const older = new Date(LAST_MODIFIED.getTime() - 60_000).toUTCString();
    expect(isNotModified(req({ 'if-modified-since': older }), FEED)).toBe(false);
  });

  it('reports not-modified when the client is ahead of the feed', () => {
    const newer = new Date(LAST_MODIFIED.getTime() + 60_000).toUTCString();
    expect(isNotModified(req({ 'if-modified-since': newer }), FEED)).toBe(true);
  });

  it('ignores sub-second precision, which HTTP-date cannot carry', () => {
    // Without truncation a feed modified at .500 is forever "newer" than the
    // whole second the client was sent, and every conditional request 200s —
    // the single most common way this header is implemented wrongly.
    const feed = { ...FEED, lastModified: new Date('2026-03-02T08:00:00.500Z') };
    expect(
      isNotModified(req({ 'if-modified-since': 'Mon, 02 Mar 2026 08:00:00 GMT' }), feed)
    ).toBe(true);
  });

  it('reports modified for an unparsable date rather than guessing', () => {
    expect(isNotModified(req({ 'if-modified-since': 'yesterday' }), FEED)).toBe(false);
  });

  it('reports modified for a feed with no modification instant', () => {
    // An empty feed has no `Last-Modified` to have been given, so there is
    // nothing to compare against.
    expect(
      isNotModified(
        req({ 'if-modified-since': LAST_MODIFIED.toUTCString() }),
        { ...FEED, lastModified: null }
      )
    ).toBe(false);
  });
});

describe('precedence', () => {
  it('lets a matching entity tag win over a stale date', () => {
    // RFC 9110 §13.1.3: If-Modified-Since is evaluated only when If-None-Match
    // is absent. Every serious feed reader sends both.
    const stale = new Date(LAST_MODIFIED.getTime() - 3_600_000).toUTCString();
    expect(
      isNotModified(
        req({ 'if-none-match': '"abc123"', 'if-modified-since': stale }),
        FEED
      )
    ).toBe(true);
  });

  it('lets a non-matching entity tag win over a satisfied date', () => {
    // The representation genuinely changed; the date must not be able to
    // suppress the new body.
    expect(
      isNotModified(
        req({
          'if-none-match': '"stale"',
          'if-modified-since': LAST_MODIFIED.toUTCString(),
        }),
        FEED
      )
    ).toBe(false);
  });
});

describe('no conditional headers', () => {
  it('reports modified, so a first request always gets a body', () => {
    expect(isNotModified(req(), FEED)).toBe(false);
  });
});

describe('applyFeedHeaders', () => {
  it('sets the content type, validators and freshness information', () => {
    const { res, headers } = fakeRes();
    applyFeedHeaders(res, FEED);

    expect(headers['Content-Type']).toBe(RSS_CONTENT_TYPE);
    expect(headers.ETag).toBe('"abc123"');
    expect(headers['Last-Modified']).toBe('Mon, 02 Mar 2026 08:00:00 GMT');
    expect(headers['Cache-Control']).toBe(
      `public, max-age=${HTTP_MAX_AGE_SECONDS}, stale-while-revalidate=${HTTP_STALE_WHILE_REVALIDATE_SECONDS}`
    );
  });

  it('declares the response cacheable by shared caches', () => {
    // Safe precisely because a feed carries only PUBLIC content and never
    // varies on a viewer — see rss.controller.
    const { res, headers } = fakeRes();
    applyFeedHeaders(res, FEED);
    expect(String(headers['Cache-Control'])).toContain('public');
    expect(String(headers['Cache-Control'])).not.toContain('private');
  });

  it('omits Last-Modified when there is no instant to state', () => {
    const { res, headers } = fakeRes();
    applyFeedHeaders(res, { ...FEED, lastModified: null });
    expect(headers['Last-Modified']).toBeUndefined();
    expect(headers.ETag).toBe('"abc123"');
  });
});

describe('parseHttpDate', () => {
  it('accepts the formats a recipient must understand', () => {
    expect(parseHttpDate('Mon, 02 Mar 2026 08:00:00 GMT')).toBe(LAST_MODIFIED.getTime());
    expect(parseHttpDate('2026-03-02T08:00:00.000Z')).toBe(LAST_MODIFIED.getTime());
  });

  it('returns null for garbage instead of NaN', () => {
    // NaN would compare false-y and silently decide the answer.
    expect(parseHttpDate('not a date')).toBeNull();
  });
});
