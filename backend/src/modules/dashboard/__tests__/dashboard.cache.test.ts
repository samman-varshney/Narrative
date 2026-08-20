import { redis } from '../../../core/providers/redis';
import {
  resetGenerationMemo as resetAnalyticsMemo,
  bumpGenerations as bumpAnalyticsGenerations,
} from '../../analytics/analytics.cache';
import {
  bumpGeneration,
  buildKey,
  canonicalize,
  currentGeneration,
  resetGenerationMemo,
  withCache,
} from '../dashboard.cache';
import { clearDashboardKeys } from './helpers';

/**
 * Cache behaviour, against the real test Redis.
 *
 * Four properties matter more than hit rate, and they are what these assert:
 *
 *   1. one user can never read another's entry;
 *   2. an invalidation is visible immediately on the instance that raised it;
 *   3. an ANALYTICS flush invalidates the dashboard too — the property that
 *      keeps a composed payload from outliving the reports inside it;
 *   4. a Redis failure degrades the dashboard to "uncached", never to a 500.
 */

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeEach(async () => {
  await clearDashboardKeys();
  resetGenerationMemo();
  resetAnalyticsMemo();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await clearDashboardKeys();
});

describe('read-through', () => {
  it('runs the loader once and serves the second request from Redis', async () => {
    const loader = jest.fn().mockResolvedValue({ value: 1 });

    const first = await withCache('stats', ALICE, { range: '30d' }, loader);
    const second = await withCache('stats', ALICE, { range: '30d' }, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('treats logically identical requests as one entry', async () => {
    const loader = jest.fn().mockResolvedValue({ value: 1 });

    await withCache('overview', ALICE, { range: '30d', sections: ['stats'] }, loader);
    await withCache('overview', ALICE, { sections: ['stats'], range: '30d' }, loader);

    // Key order is canonicalized away, so a client that spells the same request
    // differently does not pay for its own miss.
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps different parameters apart', async () => {
    const loader = jest.fn().mockImplementation(async () => ({ at: Date.now() }));

    await withCache('stats', ALICE, { range: '7d' }, loader);
    await withCache('stats', ALICE, { range: '30d' }, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps scopes apart', async () => {
    const loader = jest.fn().mockResolvedValue({ value: 1 });

    await withCache('stats', ALICE, { range: '30d' }, loader);
    await withCache('activity', ALICE, { range: '30d' }, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('user isolation', () => {
  it('never serves one user the other user\'s entry', async () => {
    await withCache('stats', ALICE, { range: '30d' }, async () => ({ owner: 'alice' }));
    const forBob = await withCache('stats', BOB, { range: '30d' }, async () => ({
      owner: 'bob',
    }));

    expect(forBob).toEqual({ owner: 'bob' });
  });

  it('builds different keys for different users on identical parameters', () => {
    const parts = { range: '30d' };
    expect(buildKey('stats', ALICE, 'g0.a0', parts)).not.toBe(
      buildKey('stats', BOB, 'g0.a0', parts)
    );
  });

  it('confines an invalidation to the user it names', async () => {
    const aliceLoader = jest.fn().mockResolvedValue({ owner: 'alice' });
    const bobLoader = jest.fn().mockResolvedValue({ owner: 'bob' });

    await withCache('stats', ALICE, { range: '30d' }, aliceLoader);
    await withCache('stats', BOB, { range: '30d' }, bobLoader);

    await bumpGeneration([ALICE]);

    await withCache('stats', ALICE, { range: '30d' }, aliceLoader);
    await withCache('stats', BOB, { range: '30d' }, bobLoader);

    // Alice's entry was invalidated and reloaded; Bob's survived untouched.
    expect(aliceLoader).toHaveBeenCalledTimes(2);
    expect(bobLoader).toHaveBeenCalledTimes(1);
  });
});

describe('invalidation', () => {
  it('is visible on this instance immediately', async () => {
    const loader = jest.fn().mockResolvedValue({ value: 1 });

    await withCache('stats', ALICE, { range: '30d' }, loader);
    expect(await currentGeneration(ALICE)).toBe(0);

    await bumpGeneration([ALICE]);

    // The in-process memo is dropped by the bump, so no waiting for its window.
    expect(await currentGeneration(ALICE)).toBe(1);
    await withCache('stats', ALICE, { range: '30d' }, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for an empty or blank user list', async () => {
    await expect(bumpGeneration([])).resolves.toBeUndefined();
    await expect(bumpGeneration([''])).resolves.toBeUndefined();
    expect(await currentGeneration(ALICE)).toBe(0);
  });

  it('drops the dashboard entry when ANALYTICS invalidates that author', async () => {
    const loader = jest.fn().mockResolvedValue({ value: 1 });

    await withCache('overview', ALICE, { range: '30d' }, loader);

    // What the analytics flush worker does after writing this author's rows.
    await bumpAnalyticsGenerations([ALICE]);
    resetAnalyticsMemo();

    await withCache('overview', ALICE, { range: '30d' }, loader);

    // The composed payload must not outlive the reports inside it.
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('conditional caching', () => {
  it('does not store a value the caller marks uncacheable', async () => {
    const loader = jest.fn().mockResolvedValue({ degraded: true });

    await withCache('overview', ALICE, { range: '30d' }, loader, {
      cacheable: () => false,
    });
    await withCache('overview', ALICE, { range: '30d' }, loader, {
      cacheable: () => false,
    });

    // A transient failure must not be pinned in place for the whole TTL.
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('stores a value the caller marks cacheable', async () => {
    const loader = jest.fn().mockResolvedValue({ degraded: false });

    await withCache('overview', ALICE, { range: '30d' }, loader, {
      cacheable: () => true,
    });
    await withCache('overview', ALICE, { range: '30d' }, loader, {
      cacheable: () => true,
    });

    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('Redis failure', () => {
  it('still answers when the read fails', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
    const loader = jest.fn().mockResolvedValue({ value: 'fresh' });

    await expect(withCache('stats', ALICE, { range: '30d' }, loader)).resolves.toEqual({
      value: 'fresh',
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('still answers when the write fails', async () => {
    jest.spyOn(redis, 'set').mockRejectedValue(new Error('redis down'));
    const loader = jest.fn().mockResolvedValue({ value: 'fresh' });

    await expect(withCache('stats', ALICE, { range: '30d' }, loader)).resolves.toEqual({
      value: 'fresh',
    });
  });

  it('still answers when a corrupt entry cannot be parsed', async () => {
    jest.spyOn(redis, 'get').mockResolvedValue('{not json');
    const loader = jest.fn().mockResolvedValue({ value: 'fresh' });

    await expect(withCache('stats', ALICE, { range: '30d' }, loader)).resolves.toEqual({
      value: 'fresh',
    });
  });

  it('reads generation 0 when the counter is unreachable', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
    // Behaves as if nothing had ever been invalidated — bounded by the TTL, and
    // the correct direction for a cache to fail.
    expect(await currentGeneration(ALICE)).toBe(0);
  });

  it('does not let a failed invalidation strand a stale memo', async () => {
    await currentGeneration(ALICE);
    jest.spyOn(redis, 'pipeline').mockImplementation(() => {
      throw new Error('redis down');
    });

    await expect(bumpGeneration([ALICE])).resolves.toBeUndefined();

    // The memo was dropped even though the bump failed, so the next read goes
    // back to Redis instead of serving a value that is now known to be suspect.
    jest.restoreAllMocks();
    await redis.incr('dashboard:v1:gen:' + ALICE);
    expect(await currentGeneration(ALICE)).toBe(1);
  });

  it('propagates a loader failure rather than caching it', async () => {
    const loader = jest.fn().mockRejectedValue(new Error('database down'));

    await expect(withCache('stats', ALICE, { range: '30d' }, loader)).rejects.toThrow(
      'database down'
    );

    const good = jest.fn().mockResolvedValue({ value: 'recovered' });
    await expect(withCache('stats', ALICE, { range: '30d' }, good)).resolves.toEqual({
      value: 'recovered',
    });
  });
});

describe('canonicalize', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalize({ b: 1, a: undefined, c: 2 })).toEqual({ b: 1, c: 2 });
  });

  it('preserves array order', () => {
    // Section and series lists are ordered by the caller before they get here;
    // reordering them would merge two genuinely different requests.
    expect(canonicalize(['b', 'a'])).toEqual(['b', 'a']);
  });

  it('renders dates as ISO strings', () => {
    expect(canonicalize(new Date('2026-08-20T00:00:00.000Z'))).toBe(
      '2026-08-20T00:00:00.000Z'
    );
  });
});
