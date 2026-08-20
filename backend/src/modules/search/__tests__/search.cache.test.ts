import { redis } from '../../../core/providers/redis';
import {
  CACHE_TTL_SECONDS,
  bumpGeneration,
  buildCacheKey,
  currentGeneration,
  resetGenerationMemo,
  withCache,
} from '../search.cache';

/**
 * Cache behaviour against a real Redis (the suite already points REDIS_URL at a
 * dedicated logical database — see jest.setup.js). Mocking ioredis here would
 * only prove the calls were made, not that generation bumps actually orphan the
 * previous keys, which is the whole mechanism.
 */
describe('search cache', () => {
  beforeEach(async () => {
    const keys = await redis.keys('search:*');
    if (keys.length) await redis.del(...keys);
    resetGenerationMemo();
  });

  afterAll(async () => {
    const keys = await redis.keys('search:*');
    if (keys.length) await redis.del(...keys);
  });

  describe('buildCacheKey', () => {
    it('is stable for logically identical requests', () => {
      // Different key order, same request: one cache entry, not two.
      const a = buildCacheKey('blogs', 1, { q: 'js', sort: 'relevance', limit: 20 });
      const b = buildCacheKey('blogs', 1, { limit: 20, sort: 'relevance', q: 'js' });

      expect(a).toBe(b);
    });

    it('differs when any request component differs', () => {
      const base = { q: 'js', sort: 'relevance', limit: 20, cursor: null };

      const keys = new Set([
        buildCacheKey('blogs', 1, base),
        buildCacheKey('blogs', 1, { ...base, q: 'ts' }),
        buildCacheKey('blogs', 1, { ...base, sort: 'newest' }),
        buildCacheKey('blogs', 1, { ...base, limit: 10 }),
        buildCacheKey('blogs', 1, { ...base, cursor: 'abc' }),
      ]);

      expect(keys.size).toBe(5);
    });

    it('scopes the key by entity so a blog bump cannot clear tag results', () => {
      expect(buildCacheKey('blogs', 1, { q: 'js' })).not.toBe(
        buildCacheKey('tags', 1, { q: 'js' })
      );
    });

    it('embeds the generation, so a bump orphans every previous key', () => {
      expect(buildCacheKey('blogs', 1, { q: 'js' })).not.toBe(
        buildCacheKey('blogs', 2, { q: 'js' })
      );
    });
  });

  describe('generations', () => {
    it('starts at zero for an untouched scope', async () => {
      await expect(currentGeneration('blogs')).resolves.toBe(0);
    });

    it('advances on bump and clears the in-process memo immediately', async () => {
      await currentGeneration('blogs'); // populate the memo
      await bumpGeneration(['blogs']);

      // Without the memo being dropped, this would still read 0.
      await expect(currentGeneration('blogs')).resolves.toBe(1);
    });

    it('bumps only the scopes it is given', async () => {
      await bumpGeneration(['blogs']);

      await expect(currentGeneration('blogs')).resolves.toBe(1);
      await expect(currentGeneration('users')).resolves.toBe(0);
    });

    it('is a no-op for an empty scope list', async () => {
      await expect(bumpGeneration([])).resolves.toBeUndefined();
      await expect(currentGeneration('blogs')).resolves.toBe(0);
    });
  });

  describe('withCache', () => {
    it('runs the loader once and serves the second call from cache', async () => {
      const loader = jest.fn().mockResolvedValue({ items: [1, 2, 3] });

      const first = await withCache('blogs', { q: 'js' }, loader);
      const second = await withCache('blogs', { q: 'js' }, loader);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('re-runs the loader after the generation is bumped', async () => {
      const loader = jest.fn().mockResolvedValue({ items: [] });

      await withCache('blogs', { q: 'js' }, loader);
      await bumpGeneration(['blogs']);
      await withCache('blogs', { q: 'js' }, loader);

      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('sets the scope TTL so an entry cannot outlive its staleness budget', async () => {
      await withCache('tags', { q: 'js' }, async () => ({ items: [] }));

      const key = buildCacheKey('tags', await currentGeneration('tags'), { q: 'js' });
      const ttl = await redis.ttl(key);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(CACHE_TTL_SECONDS.tags);
    });

    it('falls through to the loader when the cached payload is corrupt', async () => {
      const key = buildCacheKey('blogs', await currentGeneration('blogs'), { q: 'js' });
      await redis.set(key, 'not json at all');

      const loader = jest.fn().mockResolvedValue({ items: ['fresh'] });
      const result = await withCache('blogs', { q: 'js' }, loader);

      // A poisoned entry must not break the endpoint forever, and the
      // successful write overwrites it.
      expect(loader).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ items: ['fresh'] });
      await expect(withCache('blogs', { q: 'js' }, loader)).resolves.toEqual({
        items: ['fresh'],
      });
    });

    it('serves results when Redis is unreachable rather than failing the search', async () => {
      const get = jest.spyOn(redis, 'get').mockRejectedValue(new Error('ECONNREFUSED'));
      const set = jest.spyOn(redis, 'set').mockRejectedValue(new Error('ECONNREFUSED'));

      try {
        await expect(
          withCache('blogs', { q: 'outage' }, async () => ({ items: ['live'] }))
        ).resolves.toEqual({ items: ['live'] });
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });

    it('keeps different scopes isolated from one another', async () => {
      await withCache('blogs', { q: 'js' }, async () => 'blog-result');
      await withCache('users', { q: 'js' }, async () => 'user-result');

      await expect(withCache('blogs', { q: 'js' }, async () => 'x')).resolves.toBe(
        'blog-result'
      );
      await expect(withCache('users', { q: 'js' }, async () => 'x')).resolves.toBe(
        'user-result'
      );
    });
  });
});
