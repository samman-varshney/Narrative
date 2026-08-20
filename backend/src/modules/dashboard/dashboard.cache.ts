import { createHash } from 'crypto';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import { analyticsService } from '../analytics/analytics.service';
import {
  CACHE_TTL_SECONDS,
  GENERATION_MEMO_MS,
  type DashboardCacheScope,
} from './dashboard.config';

/**
 * Redis caching for dashboard responses.
 *
 * ── Why cache at all, when Analytics already does ───────────────────────────
 * The analytics reports inside a dashboard payload are cached by the module
 * that produces them. Everything ELSE in that payload is not: the drafts query,
 * the recent-blogs query, the follow counts, the bookmark library, the
 * notification page and the three activity queries are all uncached reads
 * against five different tables. That is what this cache is for. On a warm
 * entry the whole composite endpoint is one `GET`.
 *
 * ── Two generations in every key ────────────────────────────────────────────
 * The subtlety of caching a COMPOSITION is that the outer cache can go on
 * serving data the inner one has already replaced: entry written at T, analytics
 * flush at T+1, and until this module's TTL lapses the dashboard shows numbers
 * that are provably stale — worse, numbers that disagree with the analytics
 * endpoints the same client can call.
 *
 * So the key carries both:
 *
 *   dashboard generation — bumped by this module's subscriber when the USER's
 *                          own state changes (published a blog, gained a
 *                          follower, saved a bookmark)
 *   analytics generation — the Analytics module's own freshness token, bumped
 *                          by its flush worker for exactly the authors it wrote
 *
 * Either one advancing makes every cached dashboard for that user unreachable,
 * in O(1), with no key deletion and no scan. The result is that a dashboard is
 * never staler than the analytics reports it contains, which no arrangement of
 * TTLs alone can guarantee.
 *
 * BLOG_VIEWED is deliberately NOT a subscribed event (see the subscriber):
 * views are the highest-volume event on the bus, and they reach the dashboard
 * through the analytics generation anyway.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * A dashboard is private. The user id is inside the hashed digest AND selects
 * the generation counter, so two users cannot collide on a key even if every
 * other parameter is identical — and one user's invalidation cannot reach
 * another's entries.
 *
 * ── Never load-bearing ──────────────────────────────────────────────────────
 * Every Redis call here is best-effort. Redis being down, slow or returning
 * garbage must degrade the dashboard to "uncached", never to a 500 — so every
 * failure path logs and falls through to the loader.
 */

/**
 * Bumped when a cached VALUE's shape changes.
 *
 * Without it, a deploy that renames a DTO field goes on serving the old shape
 * from warm entries for the length of their TTL — to clients that have already
 * been updated to expect the new one.
 */
const CACHE_VERSION = 'v1';

const PREFIX = `dashboard:${CACHE_VERSION}`;

const generationKey = (userId: string): string => `${PREFIX}:gen:${userId}`;

interface MemoEntry {
  value: number;
  expiresAt: number;
}

const generationMemo = new Map<string, MemoEntry>();

/**
 * This module's generation counter for one user.
 *
 * Falls back to 0 when Redis is unreachable, which makes the cache behave as if
 * nothing had ever been invalidated — bounded by the TTL, and the correct
 * direction for a cache to fail.
 */
export async function currentGeneration(userId: string): Promise<number> {
  const memo = generationMemo.get(userId);
  const now = Date.now();
  if (memo && memo.expiresAt > now) return memo.value;

  let value = 0;
  try {
    const raw = await redis.get(generationKey(userId));
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    if (Number.isFinite(parsed)) value = parsed;
  } catch (err) {
    logger.warn({ err, userId }, 'dashboard: failed to read cache generation');
  }

  generationMemo.set(userId, { value, expiresAt: now + GENERATION_MEMO_MS });
  return value;
}

/**
 * Invalidates every cached dashboard response for these users.
 *
 * O(users touched) — not O(cached entries), and not O(keyspace). That is the
 * property that lets it run on every relevant domain event forever.
 */
export async function bumpGeneration(userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return;

  try {
    const pipeline = redis.pipeline();
    for (const userId of unique) pipeline.incr(generationKey(userId));
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, count: unique.length }, 'dashboard: failed to bump cache generation');
  } finally {
    // Dropped even on failure: a stale memo is the one state that would keep
    // serving invalidated data past its TTL on this instance.
    for (const userId of unique) generationMemo.delete(userId);
  }
}

/**
 * The composite generation segment: this module's counter and the Analytics
 * module's, for one user.
 *
 * Read concurrently — they are independent, and this sits in front of every
 * cache lookup, so making them sequential would put two round trips on the
 * fast path. Both are memoized on their own side, so in the common case neither
 * touches Redis at all.
 */
async function compositeGeneration(userId: string): Promise<string> {
  const [dashboard, analytics] = await Promise.all([
    currentGeneration(userId),
    // Best-effort, like everything else here: if Analytics cannot report its
    // generation we still cache, we just lose flush-precise invalidation until
    // the TTL. Failing the request would be a strictly worse trade.
    analyticsService.getReportGeneration(userId).catch((err) => {
      logger.warn({ err, userId }, 'dashboard: failed to read analytics generation');
      return 0;
    }),
  ]);

  return `g${dashboard}.a${analytics}`;
}

/**
 * Builds a cache key.
 *
 * `parts` carries everything that changes the answer — the range preset, the
 * requested sections, the metric, the limit — canonicalized so two spellings of
 * the same request share an entry instead of each paying for a miss.
 */
export function buildKey(
  scope: DashboardCacheScope,
  userId: string,
  generation: string,
  parts: Record<string, unknown>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: CACHE_VERSION, u: userId, p: canonicalize(parts) }))
    .digest('base64url')
    .slice(0, 32);
  return `${PREFIX}:${scope}:${generation}:${digest}`;
}

/** Stable JSON form: keys sorted, `undefined` dropped, arrays order-preserving. */
export function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = canonicalize(child);
    }
    return out;
  }
  return value;
}

/**
 * Read-through cache around a loader.
 *
 * The loader must return the FINISHED DTO, not the rows behind it. A cached
 * value makes a round trip through JSON, so anything mapped after the cache
 * would work on a miss and break on a hit — `Date` objects come back as
 * strings, and a mapper calling `.toISOString()` on one throws. Every DTO in
 * this module carries dates as strings for the same reason.
 */
export async function withCache<T>(
  scope: DashboardCacheScope,
  userId: string,
  parts: Record<string, unknown>,
  loader: () => Promise<T>,
  options: {
    /**
     * Whether this particular value may be stored. Defaults to always.
     *
     * Exists for one case, and it is not an optimization: a composite response
     * in which a section FAILED must not be cached. Storing it would pin a
     * transient outage in place for the length of the TTL, so a subsystem that
     * recovered in two seconds would go on showing an empty panel for a minute
     * to everyone whose dashboard happened to be built during it.
     */
    cacheable?: (value: T) => boolean;
  } = {}
): Promise<T> {
  const generation = await compositeGeneration(userId);
  const key = buildKey(scope, userId, generation, parts);

  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    // A corrupt or unreadable entry must not break the endpoint until its TTL
    // lapses — fall through, and the write below replaces it.
    logger.warn({ err, scope }, 'dashboard: cache read failed');
  }

  const value = await loader();

  try {
    if (value !== undefined && (options.cacheable?.(value) ?? true)) {
      await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS[scope]);
    }
  } catch (err) {
    logger.warn({ err, scope }, 'dashboard: cache write failed');
  }

  return value;
}

/** Test seam: drops the in-process generation memo. */
export function resetGenerationMemo(): void {
  generationMemo.clear();
}
