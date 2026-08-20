import { redis } from '../../../core/providers/redis';
import {
  FEED_CACHE_SCOPES,
  bumpGeneration,
  currentGeneration,
  dropFollowingPage,
  readFollowingPage,
  readSnapshot,
  resetGenerationMemo,
  snapshotId,
  withPageCache,
  writeFollowingPage,
  writeSnapshot,
} from '../feed.cache';
import { clearFeedKeys } from './helpers';
import type { FeedPage } from '../feed.types';

/**
 * Cache behaviour, against the real test Redis.
 *
 * Two properties matter more than hit rate and are what these assert: an
 * invalidation must be visible immediately on the instance that issued it, and
 * a Redis failure must degrade a feed to "uncached" rather than to a 500.
 */

const PAGE: FeedPage = { items: [], nextCursor: null, hasMore: false };
const page = (id: string): FeedPage => ({ ...PAGE, nextCursor: id });

beforeEach(async () => {
  await clearFeedKeys();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await clearFeedKeys();
});

describe('page cache', () => {
  it('runs the loader once and serves the second request from Redis', async () => {
    const loader = jest.fn().mockResolvedValue(page('first'));

    const a = await withPageCache('latest', { limit: 20 }, loader);
    const b = await withPageCache('latest', { limit: 20 }, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('treats logically identical requests as one entry', async () => {
    const loader = jest.fn().mockResolvedValue(PAGE);

    await withPageCache('latest', { filters: { tags: ['a', 'b'] }, limit: 20 }, loader);
    await withPageCache('latest', { limit: 20, filters: { tags: ['b', 'a'] } }, loader);

    // Key order and array order are canonicalized away, so a client that spells
    // the same filter differently does not pay for its own miss.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps different requests apart', async () => {
    const loader = jest.fn().mockResolvedValue(PAGE);

    await withPageCache('latest', { limit: 20 }, loader);
    await withPageCache('latest', { limit: 10 }, loader);
    await withPageCache('latest', { limit: 20, cursor: 'c1' }, loader);

    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('keeps scopes apart', async () => {
    const loader = jest.fn().mockResolvedValue(PAGE);

    await withPageCache('latest', { limit: 20 }, loader);
    await withPageCache('explore', { limit: 20 }, loader);
    await withPageCache('trending', { limit: 20 }, loader);

    expect(loader).toHaveBeenCalledTimes(3);
  });
});

describe('generations', () => {
  it('starts at zero and advances on invalidation', async () => {
    expect(await currentGeneration('latest')).toBe(0);

    await bumpGeneration(['latest']);

    expect(await currentGeneration('latest')).toBe(1);
  });

  it('makes every entry in the scope unreachable immediately', async () => {
    const loader = jest.fn().mockResolvedValue(PAGE);
    await withPageCache('latest', { limit: 20 }, loader);

    await bumpGeneration(['latest']);
    await withPageCache('latest', { limit: 20 }, loader);

    // The bump drops this instance's memo in the same call, so there is no
    // window in which the invalidating process still serves the old generation.
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('leaves other scopes untouched', async () => {
    const loader = jest.fn().mockResolvedValue(PAGE);
    await withPageCache('explore', { limit: 20 }, loader);

    await bumpGeneration(['latest']);
    await withPageCache('explore', { limit: 20 }, loader);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('invalidates every shared feed in one call', async () => {
    const loader = jest.fn().mockResolvedValue(PAGE);
    await Promise.all(
      FEED_CACHE_SCOPES.map((scope) => withPageCache(scope, { limit: 20 }, loader))
    );

    await bumpGeneration(FEED_CACHE_SCOPES);
    await Promise.all(
      FEED_CACHE_SCOPES.map((scope) => withPageCache(scope, { limit: 20 }, loader))
    );

    expect(loader).toHaveBeenCalledTimes(FEED_CACHE_SCOPES.length * 2);
  });

  it('is a no-op for an empty scope list', async () => {
    await expect(bumpGeneration([])).resolves.toBeUndefined();
  });
});

describe('following feed cache', () => {
  it('round-trips a viewer page', async () => {
    await writeFollowingPage('viewer-1', page('cursor-1'));
    expect(await readFollowingPage('viewer-1')).toEqual(page('cursor-1'));
  });

  it('is keyed per viewer', async () => {
    await writeFollowingPage('viewer-1', page('one'));
    expect(await readFollowingPage('viewer-2')).toBeNull();
  });

  it('is dropped precisely on invalidation', async () => {
    await writeFollowingPage('viewer-1', page('one'));
    await dropFollowingPage('viewer-1');
    expect(await readFollowingPage('viewer-1')).toBeNull();
  });

  it('expires on its own', async () => {
    await writeFollowingPage('viewer-1', PAGE);
    const ttl = await redis.ttl('feed:v1:following:viewer-1');
    expect(ttl).toBeGreaterThan(0);
  });
});

describe('snapshots', () => {
  it('round-trips an ordering', async () => {
    const id = snapshotId({ feed: 'explore', bucket: '2026-06-01T00:00:00.000Z' });
    await writeSnapshot(id, ['b1', 'b2', 'b3']);
    expect(await readSnapshot(id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('returns null for an evicted snapshot rather than an empty ordering', async () => {
    // The distinction the service depends on: null means "rebuild", while an
    // empty array would mean "the ranking legitimately found nothing".
    expect(await readSnapshot('0'.repeat(32))).toBeNull();
  });

  it('derives the same id for the same request in the same bucket', async () => {
    const parts = { feed: 'explore', filters: { tags: ['a'] }, bucket: '2026-06-01T00:00:00.000Z' };
    expect(snapshotId(parts)).toBe(snapshotId({ ...parts }));
  });

  it('derives a different id when the bucket or the request changes', async () => {
    const base = { feed: 'explore', bucket: '2026-06-01T00:00:00.000Z' };
    expect(snapshotId(base)).not.toBe(snapshotId({ ...base, bucket: '2026-06-01T00:01:00.000Z' }));
    expect(snapshotId(base)).not.toBe(snapshotId({ ...base, filters: { author: 'grace' } }));
  });

  it('produces an id the cursor schema accepts', async () => {
    expect(snapshotId({ feed: 'trending' })).toMatch(/^[0-9a-f]{32}$/);
  });

  it('expires on its own', async () => {
    const id = snapshotId({ feed: 'trending', bucket: 'x' });
    await writeSnapshot(id, ['b1']);
    expect(await redis.ttl(`feed:v1:snap:${id}`)).toBeGreaterThan(0);
  });
});

describe('Redis failure', () => {
  it('serves the feed from the loader when the cache cannot be read', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
    const loader = jest.fn().mockResolvedValue(page('live'));

    await expect(withPageCache('latest', { limit: 20 }, loader)).resolves.toEqual(page('live'));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves the feed when the cache cannot be written', async () => {
    jest.spyOn(redis, 'set').mockRejectedValue(new Error('redis down'));
    const loader = jest.fn().mockResolvedValue(page('live'));

    await expect(withPageCache('latest', { limit: 20 }, loader)).resolves.toEqual(page('live'));
  });

  it('falls back to generation zero when the counter cannot be read', async () => {
    resetGenerationMemo();
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));

    await expect(currentGeneration('latest')).resolves.toBe(0);
  });

  it('does not throw when an invalidation fails', async () => {
    jest.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw new Error('redis down');
    });

    await expect(bumpGeneration(['latest'])).resolves.toBeUndefined();
  });

  it('re-runs the loader instead of serving a corrupt entry', async () => {
    const loader = jest.fn().mockResolvedValue(page('live'));
    await withPageCache('latest', { limit: 20 }, loader);

    // Overwrite the entry with something unparsable, as a partial write would.
    const [, keys] = await redis.scan('0', 'MATCH', 'feed:v1:page:latest:*', 'COUNT', 100);
    await redis.set(keys[0]!, '{ not json');

    await expect(withPageCache('latest', { limit: 20 }, loader)).resolves.toEqual(page('live'));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('survives a snapshot read failure by reporting no snapshot', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
    await expect(readSnapshot('a'.repeat(32))).resolves.toBeNull();
  });
});
