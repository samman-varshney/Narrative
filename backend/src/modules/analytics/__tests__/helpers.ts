import { redis } from '../../../core/providers/redis';

/**
 * Shared fixtures for the analytics suites.
 *
 * The test Redis is a real one (logical DB 1, per jest.setup.js) and is shared
 * with the rate limiters and BullMQ. `FLUSHDB` would therefore take out
 * unrelated state, so cleanup is scoped to the analytics keyspace instead.
 */

/**
 * Removes every key this module owns.
 *
 * `SCAN`, not `KEYS`: the same rule the production code follows, and the test
 * database is shared, so a blocking full-keyspace read would be slow and rude
 * even here. Deletes in batches so one enormous `DEL` cannot be built.
 */
export async function clearAnalyticsKeys(): Promise<void> {
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'analytics:v1:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

/** Today's UTC bucket key — the one live ingestion writes to. */
export const todayKey = (): string => new Date().toISOString().slice(0, 10);
