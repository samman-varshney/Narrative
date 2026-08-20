import { redis } from '../../../core/providers/redis';
import {
  bumpGenerations,
  feedCacheKey,
  readFeed,
  readGenerations,
  resetGenerationMemo,
  scopeGeneration,
  writeFeed,
} from '../rss.cache';
import { CACHE_TTL_SECONDS, RSS_CONTENT_TYPE } from '../rss.config';
import type { RenderedFeed } from '../rss.types';
import { clearRssKeys } from './helpers';

/**
 * Cache behaviour, against the real test Redis.
 *
 * Three properties matter more than hit rate and are what these assert: an
 * invalidation is visible immediately on the instance that raised it,
 * invalidation is TARGETED rather than a flush, and a Redis failure degrades a
 * feed to "uncached" rather than to a 500.
 */

const FEED: RenderedFeed = {
  body: '<rss version="2.0"/>',
  contentType: RSS_CONTENT_TYPE,
  etag: '"abc123"',
  lastModified: new Date('2026-03-02T08:00:00.000Z'),
  itemCount: 2,
};

const key = (over: Partial<Parameters<typeof feedCacheKey>[0]> = {}) =>
  feedCacheKey({
    scope: 'global',
    subjectId: null,
    limit: 20,
    rootGeneration: 0,
    scopeGeneration: 0,
    ...over,
  });

beforeEach(async () => {
  await clearRssKeys();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await clearRssKeys();
});

describe('scopeGeneration', () => {
  it('maps each feed to the counter that invalidates it', () => {
    expect(scopeGeneration('global', null)).toBe('global');
    expect(scopeGeneration('author', 'u1')).toBe('author:u1');
    expect(scopeGeneration('category', 'c1')).toBe('category:c1');
    expect(scopeGeneration('tag', 't1')).toBe('tag:t1');
  });

  it('keeps two authors on separate counters', () => {
    // This is what makes "publishing does not invalidate every author's feed"
    // structural rather than a policy someone has to remember.
    expect(scopeGeneration('author', 'u1')).not.toBe(scopeGeneration('author', 'u2'));
  });
});

describe('cache keys', () => {
  it('keeps feeds apart by scope, subject and limit', () => {
    const keys = new Set([
      key(),
      key({ scope: 'author', subjectId: 'u1' }),
      key({ scope: 'author', subjectId: 'u2' }),
      key({ scope: 'tag', subjectId: 'u1' }),
      key({ limit: 50 }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('changes when either generation advances', () => {
    expect(key({ rootGeneration: 1 })).not.toBe(key());
    expect(key({ scopeGeneration: 1 })).not.toBe(key());
  });

  it('is stable for the same inputs', () => {
    expect(key()).toBe(key());
  });
});

describe('read and write', () => {
  it('round-trips a rendered feed, dates included', async () => {
    const k = key();
    await writeFeed(k, FEED);

    const hit = await readFeed(k);
    expect(hit).not.toBeNull();
    expect(hit!.body).toBe(FEED.body);
    expect(hit!.etag).toBe(FEED.etag);
    expect(hit!.itemCount).toBe(2);
    expect(hit!.lastModified?.toISOString()).toBe(FEED.lastModified!.toISOString());
  });

  it('stores the validator alongside the body, so a 304 needs no re-render', async () => {
    const k = key();
    await writeFeed(k, FEED);
    expect((await readFeed(k))!.etag).toBe('"abc123"');
  });

  it('round-trips a feed with no modification instant', async () => {
    const k = key();
    await writeFeed(k, { ...FEED, lastModified: null });
    expect((await readFeed(k))!.lastModified).toBeNull();
  });

  it('reports a miss for an unknown key', async () => {
    expect(await readFeed(key({ limit: 7 }))).toBeNull();
  });

  it('applies the configured TTL, so the cache cannot grow without bound', async () => {
    const k = key();
    await writeFeed(k, FEED);

    const ttl = await redis.ttl(k);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CACHE_TTL_SECONDS);
  });

  it('treats a corrupt entry as a miss rather than poisoning the endpoint', async () => {
    const k = key();
    await redis.set(k, 'not json');
    expect(await readFeed(k)).toBeNull();

    // ...and the write that follows the fall-through repairs it.
    await writeFeed(k, FEED);
    expect((await readFeed(k))!.body).toBe(FEED.body);
  });

  it('treats a structurally wrong entry as a miss', async () => {
    const k = key();
    await redis.set(k, JSON.stringify({ nothing: 'useful' }));
    expect(await readFeed(k)).toBeNull();
  });
});

describe('generations', () => {
  it('starts every counter at zero', async () => {
    const generations = await readGenerations(['root', 'global']);
    expect(generations.get('root')).toBe(0);
    expect(generations.get('global')).toBe(0);
  });

  it('advances only the counters it is told to', async () => {
    await bumpGenerations(['author:u1']);

    const generations = await readGenerations(['root', 'global', 'author:u1', 'author:u2']);
    expect(generations.get('author:u1')).toBe(1);
    expect(generations.get('author:u2')).toBe(0);
    expect(generations.get('global')).toBe(0);
    expect(generations.get('root')).toBe(0);
  });

  it('is visible immediately on the instance that raised it', async () => {
    // The memo would otherwise keep serving the pre-bump value for its window.
    await readGenerations(['global']);
    await bumpGenerations(['global']);
    expect((await readGenerations(['global'])).get('global')).toBe(1);
  });

  it('advances a counter once per bump, even for a repeated key', async () => {
    await bumpGenerations(['tag:t1', 'tag:t1', 'tag:t1']);
    expect((await readGenerations(['tag:t1'])).get('tag:t1')).toBe(1);
  });

  it('does nothing when given no keys', async () => {
    await expect(bumpGenerations([])).resolves.toBeUndefined();
  });

  it('makes every existing key for that scope unreachable', async () => {
    const before = key({ scopeGeneration: 0 });
    await writeFeed(before, FEED);

    await bumpGenerations(['global']);
    const generations = await readGenerations(['root', 'global']);
    const after = key({
      rootGeneration: generations.get('root')!,
      scopeGeneration: generations.get('global')!,
    });

    expect(after).not.toBe(before);
    expect(await readFeed(after)).toBeNull();
    // The old entry is not deleted — it is simply unreachable, and its TTL
    // reclaims it. That is what makes invalidation O(1) at any cache size.
    expect(await redis.exists(before)).toBe(1);
  });

  it('lets the root generation invalidate every scope at once', async () => {
    const globalKey = key();
    const authorKey = key({ scope: 'author', subjectId: 'u1' });
    await writeFeed(globalKey, FEED);
    await writeFeed(authorKey, FEED);

    await bumpGenerations(['root']);
    const generations = await readGenerations(['root', 'global', 'author:u1']);
    const root = generations.get('root')!;

    expect(root).toBe(1);
    expect(await readFeed(key({ rootGeneration: root }))).toBeNull();
    expect(
      await readFeed(
        key({ scope: 'author', subjectId: 'u1', rootGeneration: root })
      )
    ).toBeNull();
  });
});

describe('memoization', () => {
  it('serves repeated reads from process memory rather than Redis', async () => {
    await readGenerations(['global']);

    const pipeline = jest.spyOn(redis, 'pipeline');
    await readGenerations(['global']);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('reads only the counters it does not already hold', async () => {
    await readGenerations(['global']);
    resetGenerationMemo();
    await readGenerations(['global']);

    const generations = await readGenerations(['global', 'author:u9']);
    expect(generations.size).toBe(2);
    expect(generations.get('author:u9')).toBe(0);
  });
});

describe('Redis unavailable', () => {
  it('reads generations as zero rather than throwing', async () => {
    resetGenerationMemo();
    jest.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw new Error('redis down');
    });

    const generations = await readGenerations(['root', 'global']);
    expect(generations.get('root')).toBe(0);
    expect(generations.get('global')).toBe(0);
  });

  it('reports a cache miss rather than failing the request', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down') as never);
    await expect(readFeed(key())).resolves.toBeNull();
  });

  it('swallows a failed write — the caller already has the document', async () => {
    jest.spyOn(redis, 'set').mockRejectedValue(new Error('redis down') as never);
    await expect(writeFeed(key(), FEED)).resolves.toBeUndefined();
  });

  it('swallows a failed invalidation, leaving the TTL as the backstop', async () => {
    jest.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw new Error('redis down');
    });
    await expect(bumpGenerations(['global'])).resolves.toBeUndefined();
  });

  it('drops the memo even when the bump failed', async () => {
    // A stale memo after a failed bump would keep this instance serving the old
    // generation on top of whatever the failure already cost.
    await readGenerations(['global']);
    const pipeline = jest.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw new Error('redis down');
    });
    await bumpGenerations(['global']);
    pipeline.mockRestore();

    const spy = jest.spyOn(redis, 'pipeline');
    await readGenerations(['global']);
    expect(spy).toHaveBeenCalled();
  });
});
