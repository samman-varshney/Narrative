import { redis } from '../../../core/providers/redis';
import {
  bumpGenerations,
  dropMetadata,
  metadataKey,
  readDocument,
  readGenerations,
  readMetadata,
  resetGenerationMemo,
  robotsKey,
  sitemapChunkKey,
  sitemapIndexKey,
  writeDocument,
  writeMetadata,
} from '../seo.cache';
import { CACHE_TTL_SECONDS } from '../seo.config';
import { seoResolver } from '../seo.resolver';
import { blogSource, clearSeoKeys, overrideEnv } from './helpers';
import type { RenderedDocument } from '../seo.types';

/**
 * The cache, against a real Redis.
 *
 * Two properties matter more than the rest and both are asserted directly:
 * Redis being unavailable must degrade a response rather than fail it, and the
 * generation memo must not outlive an invalidation raised on this instance.
 */

let restore: (() => void)[] = [];

beforeEach(async () => {
  restore = [
    overrideEnv('APP_URL', 'https://narrative.test'),
    overrideEnv('SEO_INDEXING_ENABLED', 'true'),
  ];
  await clearSeoKeys();
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await clearSeoKeys();
});

const document = (overrides: Partial<RenderedDocument> = {}): RenderedDocument => ({
  body: '<?xml version="1.0"?><urlset/>',
  contentType: 'application/xml; charset=utf-8',
  etag: '"abc123"',
  lastModified: new Date('2026-02-01T00:00:00.000Z'),
  ...overrides,
});

// ---------------------------------------------------------------------------

describe('keys', () => {
  it('is deterministic for the same resource', () => {
    expect(metadataKey('blog', 'blog-1', 0)).toBe(metadataKey('blog', 'blog-1', 0));
  });

  it('separates resources, kinds and generations', () => {
    const keys = new Set([
      metadataKey('blog', 'blog-1', 0),
      metadataKey('blog', 'blog-2', 0),
      metadataKey('author', 'blog-1', 0),
      metadataKey('blog', 'blog-1', 1),
    ]);
    expect(keys.size).toBe(4);
  });

  it('bounds the key length whatever the identifier', () => {
    const key = metadataKey('tag', 'x'.repeat(5_000), 0);
    expect(key.length).toBeLessThan(120);
  });

  it('separates sitemap sections, pages and both generations', () => {
    const keys = new Set([
      sitemapIndexKey(0, 0),
      sitemapIndexKey(1, 0),
      sitemapIndexKey(0, 1),
      sitemapChunkKey('blogs', 1, 0, 0),
      sitemapChunkKey('blogs', 2, 0, 0),
      sitemapChunkKey('tags', 1, 0, 0),
      robotsKey(0),
    ]);
    expect(keys.size).toBe(7);
  });
});

describe('metadata read and write', () => {
  it('misses, then hits', async () => {
    const key = metadataKey('blog', 'blog-1', 0);
    expect(await readMetadata(key)).toBeNull();

    const metadata = seoResolver.resolveBlog(blogSource());
    await writeMetadata(key, metadata);

    expect(await readMetadata(key)).toEqual(metadata);
  });

  it('round-trips without needing to revive any dates', async () => {
    const key = metadataKey('blog', 'blog-2', 0);
    const metadata = seoResolver.resolveBlog(blogSource());
    await writeMetadata(key, metadata);

    const hit = await readMetadata(key);
    expect(JSON.stringify(hit)).toBe(JSON.stringify(metadata));
  });

  it('writes with the configured TTL', async () => {
    const key = metadataKey('blog', 'blog-3', 0);
    await writeMetadata(key, seoResolver.resolveBlog(blogSource()));

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CACHE_TTL_SECONDS.metadata);
  });

  it('treats a corrupt entry as a miss rather than poisoning the endpoint', async () => {
    const key = metadataKey('blog', 'blog-4', 0);
    await redis.set(key, 'not json at all');

    expect(await readMetadata(key)).toBeNull();
  });

  it('treats a structurally wrong entry as a miss', async () => {
    const key = metadataKey('blog', 'blog-5', 0);
    await redis.set(key, JSON.stringify({ unexpected: true }));

    expect(await readMetadata(key)).toBeNull();
  });

  it('drops exactly the keys it is given', async () => {
    const a = metadataKey('blog', 'blog-6', 0);
    const b = metadataKey('author', 'user-1', 0);
    const c = metadataKey('tag', 'typescript', 0);

    for (const key of [a, b, c]) await writeMetadata(key, seoResolver.resolveBlog(blogSource()));
    await dropMetadata([a, b]);

    expect(await readMetadata(a)).toBeNull();
    expect(await readMetadata(b)).toBeNull();
    expect(await readMetadata(c)).not.toBeNull();
  });

  it('is a no-op for an empty key list', async () => {
    await expect(dropMetadata([])).resolves.toBeUndefined();
  });
});

describe('document read and write', () => {
  it('misses, then hits, preserving the validators', async () => {
    const key = sitemapChunkKey('blogs', 1, 0, 0);
    expect(await readDocument(key)).toBeNull();

    await writeDocument(key, document(), CACHE_TTL_SECONDS.sitemap);
    const hit = await readDocument(key);

    expect(hit).toMatchObject({ body: document().body, etag: '"abc123"' });
    expect(hit!.lastModified!.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('preserves a null lastModified rather than inventing one', async () => {
    const key = robotsKey(0);
    await writeDocument(key, document({ lastModified: null }), CACHE_TTL_SECONDS.robots);

    expect((await readDocument(key))!.lastModified).toBeNull();
  });

  it('writes with the TTL it is given', async () => {
    const key = sitemapIndexKey(0, 0);
    await writeDocument(key, document(), CACHE_TTL_SECONDS.sitemap);

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(CACHE_TTL_SECONDS.metadata);
    expect(ttl).toBeLessThanOrEqual(CACHE_TTL_SECONDS.sitemap);
  });

  it('treats a corrupt entry as a miss', async () => {
    const key = sitemapChunkKey('tags', 1, 0, 0);
    await redis.set(key, '{"body": 12345}');

    expect(await readDocument(key)).toBeNull();
  });
});

describe('generations', () => {
  it('starts at zero and advances on a bump', async () => {
    expect((await readGenerations(['sitemap'])).get('sitemap')).toBe(0);

    await bumpGenerations(['sitemap']);
    expect((await readGenerations(['sitemap'])).get('sitemap')).toBe(1);
  });

  it('makes every key carrying the old generation unreachable', async () => {
    const before = sitemapChunkKey('blogs', 1, 0, 0);
    await writeDocument(before, document(), CACHE_TTL_SECONDS.sitemap);

    await bumpGenerations(['sitemap']);
    const generation = (await readGenerations(['sitemap'])).get('sitemap')!;
    const after = sitemapChunkKey('blogs', 1, 0, generation);

    expect(after).not.toBe(before);
    expect(await readDocument(after)).toBeNull();
  });

  it('advances only what it is asked to', async () => {
    await bumpGenerations(['sitemap']);
    const generations = await readGenerations(['root', 'sitemap']);

    expect(generations.get('root')).toBe(0);
    expect(generations.get('sitemap')).toBe(1);
  });

  it('de-duplicates so a counter advances predictably', async () => {
    await bumpGenerations(['sitemap', 'sitemap', 'sitemap']);
    expect((await readGenerations(['sitemap'])).get('sitemap')).toBe(1);
  });

  it('is a no-op for an empty list', async () => {
    await bumpGenerations([]);
    expect((await readGenerations(['sitemap'])).get('sitemap')).toBe(0);
  });

  it('drops the memo on this instance so a bump is visible immediately', async () => {
    await readGenerations(['sitemap']); // primes the memo
    await bumpGenerations(['sitemap']);

    // No wait: if the memo survived the bump this would still read 0.
    expect((await readGenerations(['sitemap'])).get('sitemap')).toBe(1);
  });

  it('serves a memoized counter without a round trip', async () => {
    await readGenerations(['sitemap']);
    const spy = jest.spyOn(redis, 'pipeline');

    await readGenerations(['sitemap']);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Redis unavailable', () => {
  const down = () => new Error('redis down');

  it('reads generations as zero rather than throwing', async () => {
    resetGenerationMemo();
    jest.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw down();
    });

    const generations = await readGenerations(['root', 'sitemap']);
    expect(generations.get('root')).toBe(0);
    expect(generations.get('sitemap')).toBe(0);
  });

  it('swallows a failed bump', async () => {
    jest.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw down();
    });

    await expect(bumpGenerations(['sitemap'])).resolves.toBeUndefined();
  });

  it('reads metadata as a miss rather than throwing', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(down());
    await expect(readMetadata(metadataKey('blog', 'blog-1', 0))).resolves.toBeNull();
  });

  it('swallows a failed metadata write', async () => {
    jest.spyOn(redis, 'set').mockRejectedValue(down());
    await expect(
      writeMetadata(metadataKey('blog', 'blog-1', 0), seoResolver.resolveBlog(blogSource()))
    ).resolves.toBeUndefined();
  });

  it('reads a document as a miss rather than throwing', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(down());
    await expect(readDocument(sitemapIndexKey(0, 0))).resolves.toBeNull();
  });

  it('swallows a failed document write', async () => {
    jest.spyOn(redis, 'set').mockRejectedValue(down());
    await expect(
      writeDocument(sitemapIndexKey(0, 0), document(), 60)
    ).resolves.toBeUndefined();
  });

  it('swallows a failed invalidation', async () => {
    jest.spyOn(redis, 'del').mockRejectedValue(down());
    await expect(dropMetadata(['seo:v1:meta:blog:r0:x'])).resolves.toBeUndefined();
  });
});
