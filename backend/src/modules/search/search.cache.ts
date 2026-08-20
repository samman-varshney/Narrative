import { createHash } from 'crypto';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import { canonicalize } from './search.cursor';

/**
 * Redis caching for search reads.
 *
 * ── Why generation counters, not key deletion ────────────────────────────────
 * A search cache key encodes the query, the filters, the sort and the cursor —
 * so a single blog being published invalidates an unknowable set of keys. The
 * usual reflexes are both wrong here: `SCAN`+`DEL` is O(keyspace) on a shared
 * Redis and blocks other work, and `KEYS` is worse.
 *
 * Instead every scope carries a monotonically increasing GENERATION number that
 * is part of the key:
 *
 *     search:v1:blogs:g7:<hash>
 *                    ^^ bumped by a domain event
 *
 * Invalidation is a single `INCR`. Old keys become unreachable instantly and are
 * reclaimed by their own TTL. Cost is O(1) per event regardless of how many
 * cached queries existed.
 *
 * ── Why the cache can never break search ─────────────────────────────────────
 * Every Redis call here is best-effort. Redis being down, slow, or returning
 * garbage must degrade search to "uncached", never to "500". Every failure path
 * therefore logs and falls through to the loader.
 *
 * ── What is NOT cached ───────────────────────────────────────────────────────
 * Nothing viewer-specific. Public search results are identical for every caller
 * by construction (the engine hard-filters to PUBLISHED + PUBLIC + ACTIVE
 * author), which is exactly what makes them safe to share across viewers. A
 * user's search history is never cached — it is per-user data that would need
 * the user id in the key to be safe, and it is already a single Redis read.
 */

/** Bumped when the cached VALUE shape changes (a DTO field added/removed). */
const CACHE_VERSION = 'v1';

const KEY_PREFIX = `search:${CACHE_VERSION}`;

/** Cache scopes. Each has its own generation counter and its own TTL. */
export type CacheScope = 'blogs' | 'users' | 'tags' | 'categories' | 'suggestions' | 'global';

/**
 * Per-scope TTLs, in seconds.
 *
 * Blog and user results get a short TTL because they are the ones a reader
 * notices going stale. Tag and category vocabularies change rarely and are read
 * on every keystroke of the suggestions box, so they get a long one.
 *
 * These are an upper bound on staleness only in the absence of events — a
 * relevant write bumps the generation and invalidates immediately.
 */
export const CACHE_TTL_SECONDS: Record<CacheScope, number> = {
  blogs: 60,
  users: 60,
  global: 60,
  suggestions: 120,
  tags: 300,
  categories: 300,
};

/**
 * How long a generation number may be reused from process memory.
 *
 * Reading the counter from Redis on every search would double the round trips
 * on the hot path. Memoizing it for a few seconds cuts that back to ~one read
 * per scope per window, at the cost of serving up to this many extra seconds of
 * stale results after an invalidation — well inside what the TTLs already allow.
 */
const GENERATION_MEMO_MS = 5_000;

interface MemoEntry {
  value: number;
  expiresAt: number;
}

const generationMemo = new Map<CacheScope, MemoEntry>();

function generationKey(scope: CacheScope): string {
  return `${KEY_PREFIX}:gen:${scope}`;
}

/**
 * Current generation for a scope. Falls back to generation 0 when Redis is
 * unavailable: search still works, and the worst case is that a cache entry
 * written during the outage is reused for its TTL.
 */
export async function currentGeneration(scope: CacheScope): Promise<number> {
  const memo = generationMemo.get(scope);
  const now = Date.now();
  if (memo && memo.expiresAt > now) return memo.value;

  let value = 0;
  try {
    const raw = await redis.get(generationKey(scope));
    value = raw ? Number.parseInt(raw, 10) : 0;
    if (!Number.isFinite(value)) value = 0;
  } catch (err) {
    logger.warn({ err, scope }, 'search: failed to read cache generation');
  }

  generationMemo.set(scope, { value, expiresAt: now + GENERATION_MEMO_MS });
  return value;
}

/**
 * Invalidates every cached entry in a scope by advancing its generation.
 *
 * The in-process memo is cleared for ALL scopes on this instance so the bump is
 * visible immediately here. Other instances pick it up within
 * GENERATION_MEMO_MS — bounded, documented, and far cheaper than a pub/sub
 * fan-out for a cache whose entries expire in a minute anyway.
 */
export async function bumpGeneration(scopes: CacheScope[]): Promise<void> {
  if (scopes.length === 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const scope of scopes) pipeline.incr(generationKey(scope));
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, scopes }, 'search: failed to bump cache generation');
  } finally {
    for (const scope of scopes) generationMemo.delete(scope);
  }
}

/**
 * Builds the cache key for one request.
 *
 * `parts` is canonicalized before hashing so that logically identical requests
 * — same filters in a different key order, same tags in a different array order
 * — land on the same key instead of each paying for its own miss.
 */
export function buildCacheKey(
  scope: CacheScope,
  generation: number,
  parts: Record<string, unknown>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(parts)))
    .digest('base64url')
    .slice(0, 32);
  return `${KEY_PREFIX}:${scope}:g${generation}:${digest}`;
}

/**
 * Read-through cache around a loader.
 *
 * `loader` is always the source of truth. A cache hit short-circuits it; every
 * kind of cache failure — miss, unreachable Redis, unparsable payload — runs it.
 */
export async function withCache<T>(
  scope: CacheScope,
  parts: Record<string, unknown>,
  loader: () => Promise<T>
): Promise<T> {
  const generation = await currentGeneration(scope);
  const key = buildCacheKey(scope, generation, parts);

  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    // A corrupt entry must not poison the endpoint forever — fall through and
    // the successful write below overwrites it.
    logger.warn({ err, scope }, 'search: cache read failed');
  }

  const value = await loader();

  try {
    // `JSON.stringify(undefined)` is `undefined`, which ioredis would reject —
    // no loader returns it today, but a cache write must never be the thing that
    // turns a working search into a 500.
    if (value !== undefined) {
      await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS[scope]);
    }
  } catch (err) {
    logger.warn({ err, scope }, 'search: cache write failed');
  }

  return value;
}

/** Test seam: drops the in-process generation memo. */
export function resetGenerationMemo(): void {
  generationMemo.clear();
}
