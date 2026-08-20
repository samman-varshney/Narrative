import request from 'supertest';
import app from '../../../app';
import { AppError } from '../../../core/exceptions/AppError';
import { tokensService } from '../../auth/tokens.service';
import { rssService } from '../rss.service';
import {
  DEFAULT_ITEM_COUNT,
  HTTP_MAX_AGE_SECONDS,
  MAX_ITEM_COUNT,
  RSS_CONTENT_TYPE,
} from '../rss.config';
import type { RenderedFeed } from '../rss.types';

/**
 * Route-level tests with the service mocked, so what is under test is the HTTP
 * contract: the media type, conditional requests, query validation, the error
 * format, and the fact that no route can be influenced by a token.
 *
 * Behaviour against real SQL lives in `rss.db.test.ts`; the whole path end to
 * end lives in `rss.e2e.test.ts`.
 */

jest.mock('../rss.service');

const mocked = rssService as jest.Mocked<typeof rssService>;

const LAST_MODIFIED = new Date('2026-03-02T08:00:00.000Z');

const FEED: RenderedFeed = {
  body: '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel></channel></rss>\n',
  contentType: RSS_CONTENT_TYPE,
  etag: '"abc123"',
  lastModified: LAST_MODIFIED,
  itemCount: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked.getFeed.mockResolvedValue(FEED);
});

describe('media type', () => {
  it.each([
    ['/api/v1/rss'],
    ['/api/v1/rss/authors/gracehopper'],
    ['/api/v1/rss/categories/engineering'],
    ['/api/v1/rss/tags/typescript'],
  ])('serves %s as RSS XML, never JSON', async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(RSS_CONTENT_TYPE);
    expect(res.text.startsWith('<?xml')).toBe(true);
    expect(() => JSON.parse(res.text)).toThrow();
  });
});

describe('routing', () => {
  it('maps each path to its feed scope and subject', async () => {
    await request(app).get('/api/v1/rss');
    expect(mocked.getFeed).toHaveBeenCalledWith({
      scope: 'global',
      key: undefined,
      limit: DEFAULT_ITEM_COUNT,
    });

    await request(app).get('/api/v1/rss/authors/gracehopper');
    expect(mocked.getFeed).toHaveBeenLastCalledWith({
      scope: 'author',
      key: 'gracehopper',
      limit: DEFAULT_ITEM_COUNT,
    });

    await request(app).get('/api/v1/rss/categories/engineering');
    expect(mocked.getFeed).toHaveBeenLastCalledWith({
      scope: 'category',
      key: 'engineering',
      limit: DEFAULT_ITEM_COUNT,
    });

    await request(app).get('/api/v1/rss/tags/typescript');
    expect(mocked.getFeed).toHaveBeenLastCalledWith({
      scope: 'tag',
      key: 'typescript',
      limit: DEFAULT_ITEM_COUNT,
    });
  });

  it('decodes a percent-encoded subject', async () => {
    await request(app).get('/api/v1/rss/tags/c%2B%2B');
    expect(mocked.getFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'tag', key: 'c++' })
    );
  });
});

describe('query validation', () => {
  it('defaults the item count', async () => {
    await request(app).get('/api/v1/rss');
    expect(mocked.getFeed).toHaveBeenCalledWith(
      expect.objectContaining({ limit: DEFAULT_ITEM_COUNT })
    );
  });

  it('accepts a limit up to the ceiling', async () => {
    await request(app).get(`/api/v1/rss?limit=${MAX_ITEM_COUNT}`);
    expect(mocked.getFeed).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_ITEM_COUNT })
    );
  });

  it('refuses a limit above the ceiling rather than silently clamping it', async () => {
    // A client asking for 500 items should learn it cannot have them, not
    // receive 50 and assume it has the whole corpus.
    const res = await request(app).get(`/api/v1/rss?limit=${MAX_ITEM_COUNT + 1}`);

    expect(res.status).toBe(400);
    expect(mocked.getFeed).not.toHaveBeenCalled();
  });

  it.each([['0'], ['-5'], ['abc'], ['1e9']])('refuses limit=%s', async (limit) => {
    const res = await request(app).get(`/api/v1/rss?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(mocked.getFeed).not.toHaveBeenCalled();
  });

  it('ignores unknown query parameters', async () => {
    const res = await request(app).get('/api/v1/rss?cursor=deep&page=40');
    expect(res.status).toBe(200);
    // There is no pagination in this module: `MAX_ITEM_COUNT` is the depth of
    // the whole surface, so there is nothing for a cursor to walk.
    expect(mocked.getFeed).toHaveBeenCalledWith(
      expect.objectContaining({ limit: DEFAULT_ITEM_COUNT })
    );
  });
});

describe('HTTP caching', () => {
  it('sends validators and a public freshness lifetime', async () => {
    const res = await request(app).get('/api/v1/rss');

    expect(res.headers.etag).toBe('"abc123"');
    expect(res.headers['last-modified']).toBe('Mon, 02 Mar 2026 08:00:00 GMT');
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain(`max-age=${HTTP_MAX_AGE_SECONDS}`);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const res = await request(app).get('/api/v1/rss').set('If-None-Match', '"abc123"');

    expect(res.status).toBe(304);
    expect(res.text).toBeFalsy();
  });

  it('repeats the validators on a 304, so the client can revalidate again', async () => {
    const res = await request(app).get('/api/v1/rss').set('If-None-Match', '"abc123"');

    expect(res.headers.etag).toBe('"abc123"');
    expect(res.headers['last-modified']).toBe('Mon, 02 Mar 2026 08:00:00 GMT');
    expect(res.headers['cache-control']).toContain('public');
  });

  it('answers a stale If-None-Match with the full document', async () => {
    const res = await request(app).get('/api/v1/rss').set('If-None-Match', '"stale"');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<rss');
  });

  it('answers a satisfied If-Modified-Since with 304', async () => {
    const res = await request(app)
      .get('/api/v1/rss')
      .set('If-Modified-Since', LAST_MODIFIED.toUTCString());

    expect(res.status).toBe(304);
  });

  it('answers a stale If-Modified-Since with the full document', async () => {
    const res = await request(app)
      .get('/api/v1/rss')
      .set('If-Modified-Since', 'Sun, 01 Mar 2026 00:00:00 GMT');

    expect(res.status).toBe(200);
  });

  it('lets a matching entity tag win over a stale date', async () => {
    const res = await request(app)
      .get('/api/v1/rss')
      .set('If-None-Match', '"abc123"')
      .set('If-Modified-Since', 'Sun, 01 Mar 2026 00:00:00 GMT');

    expect(res.status).toBe(304);
  });

  it('sends no Last-Modified for a feed with no items', async () => {
    mocked.getFeed.mockResolvedValue({ ...FEED, lastModified: null, itemCount: 0 });
    const res = await request(app).get('/api/v1/rss');

    expect(res.status).toBe(200);
    expect(res.headers['last-modified']).toBeUndefined();
    expect(res.headers.etag).toBe('"abc123"');
  });
});

describe('authentication', () => {
  const token = tokensService.generateAccessToken({ userId: 'viewer-1', role: 'ADMIN' });

  it('serves every feed anonymously', async () => {
    const res = await request(app).get('/api/v1/rss');
    expect(res.status).toBe(200);
  });

  it('produces the same request regardless of a token, even an admin one', async () => {
    // No route here reads `req.user`. That is what makes the document
    // identical for every caller — and therefore safe to cache across viewers
    // and to declare `Cache-Control: public`.
    await request(app).get('/api/v1/rss');
    const anonymous = mocked.getFeed.mock.calls[0];

    await request(app).get('/api/v1/rss').set('Authorization', `Bearer ${token}`);
    expect(mocked.getFeed.mock.calls[1]).toEqual(anonymous);
  });

  it('is unaffected by an invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/rss')
      .set('Authorization', 'Bearer not-a-token');
    expect(res.status).toBe(200);
  });
});

describe('errors', () => {
  it('reports an unknown subject as 404, in XML', async () => {
    mocked.getFeed.mockRejectedValue(
      new AppError('Feed not found', 404, 'FEED_NOT_FOUND')
    );

    const res = await request(app).get('/api/v1/rss/authors/nobody');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.text).toContain('<code>FEED_NOT_FOUND</code>');
    expect(res.text.startsWith('<?xml')).toBe(true);
  });

  it('never caches an error response', async () => {
    // An intermediary holding a 404 for a category about to be created would
    // keep serving it to every subscriber for the life of the entry.
    mocked.getFeed.mockRejectedValue(new AppError('Feed not found', 404, 'FEED_NOT_FOUND'));

    const res = await request(app).get('/api/v1/rss/tags/nope');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports a validation failure in XML too', async () => {
    const res = await request(app).get('/api/v1/rss?limit=999');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.text).toContain('<code>VALIDATION_ERROR</code>');
  });

  it('discloses nothing about an unexpected failure', async () => {
    mocked.getFeed.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 relation "Blog" does not exist')
    );

    const res = await request(app).get('/api/v1/rss');

    expect(res.status).toBe(500);
    expect(res.text).toContain('The feed could not be generated');
    expect(res.text).not.toContain('ECONNREFUSED');
    expect(res.text).not.toContain('10.0.0.5');
    expect(res.text).not.toContain('Blog');
    expect(res.text).not.toContain('at ');
  });

  it('escapes an error message before it enters the document', async () => {
    mocked.getFeed.mockRejectedValue(
      new AppError('Bad <thing> & "stuff"', 400, 'BAD_<INPUT>')
    );

    const res = await request(app).get('/api/v1/rss');
    expect(res.text).toContain('Bad &lt;thing&gt; &amp; &quot;stuff&quot;');
    expect(res.text).toContain('<code>BAD_&lt;INPUT&gt;</code>');
  });
});

describe('unknown paths', () => {
  it('does not shadow another router', async () => {
    // The module owns its mount, so a 404 here comes from Express having no
    // matching route rather than from another router swallowing the path.
    const res = await request(app).get('/api/v1/rss/nonsense/deep');
    expect(res.status).toBe(404);
  });
});
