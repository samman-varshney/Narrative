import { redis } from '../../../core/providers/redis';

/**
 * Shared fixtures for the dashboard suites.
 *
 * The test Redis is a real one (logical DB 1, per jest.setup.js) and is shared
 * with the rate limiters, BullMQ and every other module's cache. `FLUSHDB`
 * would therefore take out unrelated state, so cleanup is scoped to the
 * keyspaces these tests write.
 */

/**
 * Removes every key the dashboard cache owns, plus the whole analytics
 * keyspace.
 *
 * Analytics is cleared too, and not only its generation counters: a dashboard
 * payload EMBEDS analytics reports, so a warm analytics entry left behind from
 * an earlier test would be served through a cold dashboard cache and the test
 * would be asserting on data it did not write.
 *
 * `SCAN`, not `KEYS`: the same rule the production code follows, and the test
 * database is shared, so a blocking full-keyspace read would be slow and rude
 * even here.
 */
export async function clearDashboardKeys(): Promise<void> {
  for (const pattern of ['dashboard:v1:*', 'analytics:v1:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/**
 * A fixed instant for range resolution.
 *
 * Mid-month and mid-week on purpose: a Thursday inside August. A date at either
 * boundary would let a week-alignment bug pass unnoticed, which is precisely
 * the bug the bucket-label tests exist to catch.
 */
export const FIXED_NOW = new Date('2026-08-20T12:00:00.000Z');
