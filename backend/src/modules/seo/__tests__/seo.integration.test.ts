import request from 'supertest';
import app from '../../../app';
import { AppError } from '../../../core/exceptions/AppError';
import { tokensService } from '../../auth/tokens.service';
import { seoResolver } from '../seo.resolver';
import { seoService } from '../seo.service';
import { sitemapService } from '../sitemap.service';
import { HTTP_MAX_AGE_SECONDS } from '../seo.config';
import { seoErrorHandler } from '../seo.errors';
import { blogSource, overrideEnv } from './helpers';
import type { RenderedDocument } from '../seo.types';

/**
 * Route-level tests with the services mocked, so what is under test is the HTTP
 * contract: media types, conditional requests, validation, the error format,
 * and the fact that no route can be influenced by a token.
 *
 * Behaviour against real SQL lives in `seo.db.test.ts`; the whole path end to
 * end lives in `seo.e2e.test.ts`.
 */

jest.mock('../seo.service');
jest.mock('../sitemap.service');

const metadata = seoService as jest.Mocked<typeof seoService>;
const sitemap = sitemapService as jest.Mocked<typeof sitemapService>;

const LAST_MODIFIED = new Date('2026-03-02T08:00:00.000Z');

const XML: RenderedDocument = {
  body: '<?xml version="1.0" encoding="UTF-8"?>\n<urlset></urlset>\n',
  contentType: 'application/xml; charset=utf-8',
  etag: '"sitemap-etag"',
  lastModified: LAST_MODIFIED,
};

const ROBOTS: RenderedDocument = {
  body: 'User-agent: *\nAllow: /\n',
  contentType: 'text/plain; charset=utf-8',
  etag: '"robots-etag"',
  lastModified: null,
};

let restore: (() => void)[] = [];

beforeEach(() => {
  restore = [
    overrideEnv('APP_URL', 'https://narrative.test'),
    overrideEnv('SEO_INDEXING_ENABLED', 'true'),
  ];
  jest.clearAllMocks();

  const resolved = seoResolver.resolveBlog(blogSource());
  metadata.getSiteMetadata.mockResolvedValue(resolved);
  metadata.getBlogMetadata.mockResolvedValue(resolved);
  metadata.getAuthorMetadata.mockResolvedValue(resolved);
  metadata.getCategoryMetadata.mockResolvedValue(resolved);
  metadata.getTagMetadata.mockResolvedValue(resolved);

  sitemap.getIndex.mockResolvedValue(XML);
  sitemap.getChunk.mockResolvedValue(XML);
  sitemap.getRobots.mockResolvedValue(ROBOTS);
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
});

// ---------------------------------------------------------------------------

describe('metadata routing', () => {
  it('maps each path to its resolver', async () => {
    await request(app).get('/api/v1/seo/site');
    expect(metadata.getSiteMetadata).toHaveBeenCalled();

    await request(app).get('/api/v1/seo/blogs/a-post');
    expect(metadata.getBlogMetadata).toHaveBeenCalledWith('a-post');

    await request(app).get('/api/v1/seo/authors/grace');
    expect(metadata.getAuthorMetadata).toHaveBeenCalledWith('grace');

    await request(app).get('/api/v1/seo/categories/engineering');
    expect(metadata.getCategoryMetadata).toHaveBeenCalledWith('engineering');

    await request(app).get('/api/v1/seo/tags/typescript');
    expect(metadata.getTagMetadata).toHaveBeenCalledWith('typescript');
  });

  it('returns resolved metadata in the platform envelope', async () => {
    const res = await request(app).get('/api/v1/seo/blogs/a-post');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      resource: 'blog',
      canonicalUrl: expect.stringContaining('https://'),
      robots: { directive: expect.any(String) },
    });
  });

  it('returns a head fragment when asked for html', async () => {
    const res = await request(app).get('/api/v1/seo/blogs/a-post?format=html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<title>');
    expect(res.text).toContain('<link rel="canonical"');
    expect(() => JSON.parse(res.text)).toThrow();
  });

  it('rejects an unknown format rather than guessing', async () => {
    const res = await request(app).get('/api/v1/seo/blogs/a-post?format=yaml');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an over-long identifier before it becomes a lookup', async () => {
    const res = await request(app).get(`/api/v1/seo/authors/${'x'.repeat(500)}`);

    expect(res.status).toBe(400);
    expect(metadata.getAuthorMetadata).not.toHaveBeenCalled();
  });

  it('answers a 404 from the service with the JSON envelope', async () => {
    metadata.getBlogMetadata.mockRejectedValue(
      new AppError('Not found', 404, 'SEO_RESOURCE_NOT_FOUND')
    );

    const res = await request(app).get('/api/v1/seo/blogs/missing');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SEO_RESOURCE_NOT_FOUND');
  });

  it('never leaks an unexpected error to the caller', async () => {
    metadata.getBlogMetadata.mockRejectedValue(
      new Error('relation "Blog" does not exist at 127.0.0.1:5432')
    );

    const res = await request(app).get('/api/v1/seo/blogs/a-post');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('5432');
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });
});

describe('metadata HTTP caching', () => {
  it('declares itself publicly cacheable with an ETag', async () => {
    const res = await request(app).get('/api/v1/seo/blogs/a-post');

    expect(res.headers.etag).toMatch(/^"[a-f0-9]{32}"$/);
    expect(res.headers['cache-control']).toBe(
      `public, max-age=${HTTP_MAX_AGE_SECONDS.metadata}`
    );
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await request(app).get('/api/v1/seo/blogs/a-post');
    const second = await request(app)
      .get('/api/v1/seo/blogs/a-post')
      .set('If-None-Match', first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.text).toBeFalsy();
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('gives the two representations different validators', async () => {
    const json = await request(app).get('/api/v1/seo/blogs/a-post');
    const html = await request(app).get('/api/v1/seo/blogs/a-post?format=html');

    expect(html.headers.etag).not.toBe(json.headers.etag);

    // A client holding the JSON tag is not told 304 about the HTML.
    const crossed = await request(app)
      .get('/api/v1/seo/blogs/a-post?format=html')
      .set('If-None-Match', json.headers.etag);
    expect(crossed.status).toBe(200);
  });

  it('answers a non-matching If-None-Match with 200', async () => {
    const res = await request(app)
      .get('/api/v1/seo/blogs/a-post')
      .set('If-None-Match', '"something-else"');

    expect(res.status).toBe(200);
  });
});

describe('crawler routes', () => {
  it('serves the sitemap index as XML', async () => {
    const res = await request(app).get('/sitemap.xml');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.text.startsWith('<?xml')).toBe(true);
    expect(sitemap.getIndex).toHaveBeenCalled();
  });

  it('parses a chunk address into its section and page', async () => {
    await request(app).get('/sitemap-blogs-3.xml');
    expect(sitemap.getChunk).toHaveBeenCalledWith('blogs', 3);

    await request(app).get('/sitemap-categories-1.xml');
    expect(sitemap.getChunk).toHaveBeenCalledWith('categories', 1);

    await request(app).get('/sitemap-pages-1.xml');
    expect(sitemap.getChunk).toHaveBeenCalledWith('pages', 1);
  });

  it.each([
    ['/sitemap-nonsense-1.xml'],
    ['/sitemap-blogs-0.xml'],
    ['/sitemap-blogs-99999.xml'],
    ['/sitemap-blogs-abc.xml'],
  ])('404s %s without reaching the service', async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(404);
    expect(sitemap.getChunk).not.toHaveBeenCalled();
  });

  it('serves robots.txt as plain text', async () => {
    const res = await request(app).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toContain('User-agent: *');
  });

  it('answers a crawler error with XML, never the JSON envelope', async () => {
    sitemap.getIndex.mockRejectedValue(new AppError('Not found', 404, 'SITEMAP_NOT_FOUND'));

    const res = await request(app).get('/sitemap.xml');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.text).toContain('<error>');
    expect(() => JSON.parse(res.text)).toThrow();
  });

  it('answers a failed robots.txt with a conservative document', async () => {
    sitemap.getRobots.mockRejectedValue(new Error('redis exploded at 127.0.0.1:6379'));

    const res = await request(app).get('/robots.txt');

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('Disallow: /');
    expect(res.text).not.toContain('6379');
  });

  it('never leaks internals through a crawler error', async () => {
    sitemap.getChunk.mockRejectedValue(
      new Error('column "secret" does not exist at 127.0.0.1:5432')
    );

    const res = await request(app).get('/sitemap-blogs-1.xml');

    expect(res.status).toBe(500);
    expect(res.text).not.toContain('5432');
    expect(res.text).not.toContain('secret');
    expect(res.text).toContain('The document could not be generated');
  });

  it('never lets an error be cached', async () => {
    sitemap.getIndex.mockRejectedValue(new AppError('Not found', 404, 'SITEMAP_NOT_FOUND'));

    const res = await request(app).get('/sitemap.xml');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('crawler HTTP caching', () => {
  it('declares itself publicly cacheable with both validators', async () => {
    const res = await request(app).get('/sitemap.xml');

    expect(res.headers.etag).toBe('"sitemap-etag"');
    expect(res.headers['last-modified']).toBe(LAST_MODIFIED.toUTCString());
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain(`max-age=${HTTP_MAX_AGE_SECONDS.sitemap}`);
    expect(res.headers['cache-control']).toContain('stale-while-revalidate');
  });

  it('answers a matching If-None-Match with 304 carrying the validators', async () => {
    const res = await request(app).get('/sitemap.xml').set('If-None-Match', '"sitemap-etag"');

    expect(res.status).toBe(304);
    expect(res.text).toBeFalsy();
    expect(res.headers.etag).toBe('"sitemap-etag"');
    expect(res.headers['last-modified']).toBe(LAST_MODIFIED.toUTCString());
  });

  it('compares entity tags weakly, as RFC 9110 requires on GET', async () => {
    const res = await request(app)
      .get('/sitemap.xml')
      .set('If-None-Match', 'W/"sitemap-etag"');

    expect(res.status).toBe(304);
  });

  it('answers If-Modified-Since with 304 when nothing has changed', async () => {
    const res = await request(app)
      .get('/sitemap.xml')
      .set('If-Modified-Since', LAST_MODIFIED.toUTCString());

    expect(res.status).toBe(304);
  });

  it('lets If-None-Match win when both conditionals are sent', async () => {
    const res = await request(app)
      .get('/sitemap.xml')
      .set('If-None-Match', '"stale-tag"')
      .set('If-Modified-Since', LAST_MODIFIED.toUTCString());

    expect(res.status).toBe(200);
  });

  it('serves robots.txt with its own freshness budget', async () => {
    const res = await request(app).get('/robots.txt');

    expect(res.headers['cache-control']).toContain(`max-age=${HTTP_MAX_AGE_SECONDS.robots}`);
    expect(res.headers['last-modified']).toBeUndefined();
    expect(res.headers.etag).toBe('"robots-etag"');
  });
});

describe('there is no viewer', () => {
  const token = tokensService.generateAccessToken({ userId: 'viewer-1', role: 'ADMIN' });

  it.each([
    ['/api/v1/seo/site'],
    ['/api/v1/seo/blogs/a-post'],
    ['/api/v1/seo/authors/grace'],
    ['/sitemap.xml'],
    ['/robots.txt'],
  ])('answers %s identically with and without a token', async (path) => {
    const anonymous = await request(app).get(path);
    const authenticated = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${token}`);

    expect(authenticated.status).toBe(anonymous.status);
    expect(authenticated.text).toBe(anonymous.text);
    expect(authenticated.headers.etag).toBe(anonymous.headers.etag);
  });

  it('declares its responses cacheable by shared caches, never private', async () => {
    for (const path of ['/api/v1/seo/blogs/a-post', '/sitemap.xml', '/robots.txt']) {
      const res = await request(app).get(path);
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).not.toContain('private');
    }
  });
});

describe('the crawler error handler owns only its own paths', () => {
  /**
   * This handler lives on a router mounted at the application ROOT, which puts
   * it in the path of errors raised by every module registered before it. An
   * error from `/api/v1/blogs` rendered as XML would break the platform's JSON
   * envelope on an endpoint that has nothing to do with SEO.
   */
  function invoke(path: string) {
    const res = {
      headersSent: false,
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(key: string, value: string) {
        this.headers[key.toLowerCase()] = value;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send: jest.fn(),
    };
    const next = jest.fn();

    seoErrorHandler(new Error('boom'), { path, originalUrl: path } as never, res as never, next);
    return { res, next };
  }

  it.each([['/robots.txt'], ['/sitemap.xml'], ['/sitemap-blogs-1.xml']])(
    'answers %s itself',
    (path) => {
      const { res, next } = invoke(path);

      expect(next).not.toHaveBeenCalled();
      expect(res.send).toHaveBeenCalled();
    }
  );

  it.each([
    ['/api/v1/blogs/categories'],
    ['/api/v1/seo/blogs/a-post'],
    ['/health'],
    ['/'],
    ['/sitemap-blogs-1.json'],
  ])('delegates %s to the platform handler untouched', (path) => {
    const { res, next } = invoke(path);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.send).not.toHaveBeenCalled();
    expect(res.headers).toEqual({});
  });
});
