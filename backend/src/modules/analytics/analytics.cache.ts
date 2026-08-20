import { createHash } from 'crypto';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import { generationKey, reportKey } from './analytics.keys';

/**
 * Read-through caching for analytics reports.
 *
 * Analytics queries are the most expensive reads the dashboard makes — each one
 * aggregates a date range across a table that grows by a row per blog per day —
 * and they are also the most repeated: a dashboard poll, a tab switch and a page
 * refresh all ask the identical question.
 *
 * ── Per-OWNER generations, not per-scope ────────────────────────────────────
 * The Search module invalidates by scope: one blog published drops every cached
 * blog search, because nobody can know which cached queries would have matched.
 * Analytics is in the luckier position of knowing exactly whose numbers changed
 * — the flush worker just wrote them — so invalidation is precise here. Each
 * author has their own generation counter embedded in their keys; a flush
 * `INCR`s only the authors it touched, and every other author's cached reports
 * survive. On a platform where most authors see no traffic in a given minute,
 * scope-wide invalidation would throw away almost every useful entry, every
 * minute, forever.
 *
 * ── Never load-bearing ──────────────────────────────────────────────────────
 * Every Redis call is best-effort. A cache failure must degrade an analytics
 * request to "slow", never to "500", so every path falls through to the loader.
 */

/**
 * Bumped when a cached DTO's SHAPE changes, invalidating old entries globally.
 *
 * v2: views DTOs split `uniqueViews` into `uniqueReaderDays` (always present)
 * and `uniqueViews` (null above a one-day window). Without the bump, a deploy
 * over a warm Redis would keep serving pre-change entries for their TTL — and
 * those carry the OLD meaning under the old name, which is precisely the
 * misreading the split exists to prevent.
 */
const CACHE_VERSION = 'v2';

/** Report families. Each has its own TTL. */
export type ReportScope =
  | 'user-overview'
  | 'user-views'
  | 'user-engagement'
  | 'user-followers'
  | 'user-top-blogs'
  | 'blog-overview'
  | 'blog-views'
  | 'blog-engagement'
  | 'blog-reading';

/**
 * Per-scope TTLs, in seconds.
 *
 * The ceiling that matters is the flush interval: data cannot be fresher than
 * the last flush, so caching for around that long adds no staleness a user could
 * perceive — the generation bump is what actually invalidates. Overviews get
 * longer because they are the landing-page query, fired on every dashboard open.
 */
export const CACHE_TTL_SECONDS: Record<ReportScope, number> = {
  'user-overview': 120,
  'user-views': 60,
  'user-engagement': 60,
  'user-followers': 120,
  'user-top-blogs': 120,
  'blog-overview': 120,
  'blog-views': 60,
  'blog-engagement': 60,
  'blog-reading': 60,
};

/**
 * How long a generation may be reused from process memory.
 *
 * Reading the counter from Redis on every request would double the round trips
 * on a path whose entire point is to avoid work. The cost is up to this many
 * extra seconds of staleness after a flush on OTHER instances — trivial against
 * a pipeline that is eventually consistent by design and a flush interval
 * measured in tens of seconds.
 */
const GENERATION_MEMO_MS = 5_000;

interface MemoEntry {
  value: number;
  expiresAt: number;
}

const generationMemo = new Map<string, MemoEntry>();

/**
 * Current generation for an owner. Falls back to 0 when Redis is unreachable,
 * which makes the cache behave as if nothing had ever been invalidated — bounded
 * by the TTL, and the correct direction to fail for a cache.
 */
export async function currentGeneration(ownerId: string): Promise<number> {
  const memo = generationMemo.get(ownerId);
  const now = Date.now();
  if (memo && memo.expiresAt > now) return memo.value;

  let value = 0;
  try {
    const raw = await redis.get(generationKey(ownerId));
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    if (Number.isFinite(parsed)) value = parsed;
  } catch (err) {
    logger.warn({ err, ownerId }, 'analytics: failed to read cache generation');
  }

  generationMemo.set(ownerId, { value, expiresAt: now + GENERATION_MEMO_MS });
  return value;
}

/**
 * Invalidates every cached report for these owners, in one round trip.
 *
 * Called by the flush worker with exactly the authors whose rows it wrote.
 * O(owners touched), not O(cached entries) and not O(keyspace) — the property
 * that lets this run on every flush cycle forever.
 */
export async function bumpGenerations(ownerIds: string[]): Promise<void> {
  const unique = [...new Set(ownerIds)].filter(Boolean);
  if (unique.length === 0) return;

  try {
    const pipeline = redis.pipeline();
    for (const ownerId of unique) pipeline.incr(generationKey(ownerId));
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, count: unique.length }, 'analytics: failed to bump cache generations');
  } finally {
    // Dropped even on failure: a stale memo is the one state that would keep
    // serving invalidated data past the TTL on this instance.
    for (const ownerId of unique) generationMemo.delete(ownerId);
  }
}

/**
 * Builds a cache key.
 *
 * `parts` carries everything that changes the answer — date range, granularity,
 * metric, cursor, page size — and is canonicalized so two spellings of the same
 * request share an entry instead of each paying for a miss. The owner id is in
 * the generation, not the digest, so one author's invalidation cannot reach
 * another's entries.
 */
export function buildReportKey(
  scope: ReportScope,
  ownerId: string,
  generation: number,
  parts: Record<string, unknown>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: CACHE_VERSION, o: ownerId, p: canonicalize(parts) }))
    .digest('base64url')
    .slice(0, 32);
  return reportKey(scope, generation, digest);
}

/** Stable JSON form: keys sorted, `undefined` dropped, Dates as ISO strings. */
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
 * `ownerId` is the user whose data this report is about — the author for both
 * `user-*` and `blog-*` scopes, since a blog's numbers are invalidated by the
 * same flush that touches its author.
 */
export async function withReportCache<T>(
  scope: ReportScope,
  ownerId: string,
  parts: Record<string, unknown>,
  loader: () => Promise<T>
): Promise<T> {
  const generation = await currentGeneration(ownerId);
  const key = buildReportKey(scope, ownerId, generation, parts);

  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    // A corrupt entry must not break the endpoint until its TTL lapses — fall
    // through, and the write below replaces it.
    logger.warn({ err, scope }, 'analytics: report cache read failed');
  }

  const value = await loader();

  try {
    if (value !== undefined) {
      await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS[scope]);
    }
  } catch (err) {
    logger.warn({ err, scope }, 'analytics: report cache write failed');
  }

  return value;
}

/** Test seam: drops the in-process generation memo. */
export function resetGenerationMemo(): void {
  generationMemo.clear();
}
