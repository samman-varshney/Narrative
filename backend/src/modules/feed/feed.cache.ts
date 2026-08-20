import { createHash } from 'crypto';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import { CACHE_TTL_SECONDS } from './feed.config';
import { canonicalize } from './feed.cursor';
import type { FeedPage } from './feed.types';

/**
 * Redis caching for feeds.
 *
 * Three distinct things are cached, for three distinct reasons, and conflating
 * them is how a feed cache leaks:
 *
 *   PAGES of the shared feeds (latest, explore, trending)
 *     Viewer-independent by construction — the eligibility rules resolve to
 *     PUBLIC-only and the ranking is not personalized — so one entry is correct
 *     for every caller, including anonymous ones. This is the property that
 *     makes them cacheable at all, and it is load-bearing: if personalization is
 *     ever added, the viewer id must enter the key IN THE SAME CHANGE.
 *
 *   The FOLLOWING feed's first page, per viewer
 *     Genuinely user-specific, so the viewer id is in the key and nothing else
 *     can read it. Only the FIRST page is cached: that is the one every client
 *     requests on every app open, while deep pages are walked once by one
 *     person. Caching every cursor would grow the keyspace by the number of
 *     users times the depth they scroll, for entries that are never read twice.
 *
 *   RANKED SNAPSHOTS
 *     Not a performance cache but a CONSISTENCY mechanism: the frozen ordering a
 *     ranked cursor walks. See `feed.cursor.ts`.
 *
 * ── Why generation counters, not key deletion ───────────────────────────────
 * A feed cache key encodes the filters, the options and the cursor, so a single
 * blog being published invalidates an unknowable set of keys. `SCAN`+`DEL` is
 * O(keyspace) on a shared Redis and `KEYS` is worse. Instead each scope carries
 * a generation number that is part of the key, and invalidation is one `INCR`:
 * old keys become unreachable instantly and are reclaimed by their own TTL.
 * O(1) per event however large the cache grows. Same design as the Search
 * module, for the same reason.
 *
 * ── The cache can never break a feed ────────────────────────────────────────
 * Every Redis call here is best-effort. Redis being down, slow, or returning
 * garbage must degrade a feed to "uncached", never to "500" — so every failure
 * path logs and falls through to the loader.
 */

/** Bumped when a cached VALUE's shape changes (a DTO field added or removed). */
const CACHE_VERSION = 'v1';

const PREFIX = `feed:${CACHE_VERSION}`;

/** Cache scopes with a shared, viewer-independent page cache. */
export type FeedCacheScope = 'latest' | 'explore' | 'trending';

export const FEED_CACHE_SCOPES: FeedCacheScope[] = ['latest', 'explore', 'trending'];

/**
 * How long a generation may be reused from process memory.
 *
 * Reading the counter from Redis on every request would double the round trips
 * on the hot path. Memoizing cuts that to roughly one read per scope per window,
 * at the cost of up to this many extra seconds of staleness after an
 * invalidation on ANOTHER instance — well inside what a 30-second TTL already
 * allows.
 */
const GENERATION_MEMO_MS = 5_000;

interface MemoEntry {
  value: number;
  expiresAt: number;
}

const generationMemo = new Map<FeedCacheScope, MemoEntry>();

const generationKey = (scope: FeedCacheScope): string => `${PREFIX}:gen:${scope}`;
const snapshotKey = (snapshotId: string): string => `${PREFIX}:snap:${snapshotId}`;
const followingKey = (viewerId: string): string => `${PREFIX}:following:${viewerId}`;

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

/**
 * Current generation for a scope. Falls back to 0 when Redis is unavailable:
 * feeds still work, and the worst case is that an entry written during the
 * outage is reused for its TTL.
 */
export async function currentGeneration(scope: FeedCacheScope): Promise<number> {
  const memo = generationMemo.get(scope);
  const now = Date.now();
  if (memo && memo.expiresAt > now) return memo.value;

  let value = 0;
  try {
    const raw = await redis.get(generationKey(scope));
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    if (Number.isFinite(parsed)) value = parsed;
  } catch (err) {
    logger.warn({ err, scope }, 'feed: failed to read cache generation');
  }

  generationMemo.set(scope, { value, expiresAt: now + GENERATION_MEMO_MS });
  return value;
}

/**
 * Invalidates every cached page in a scope by advancing its generation.
 *
 * The in-process memo is dropped for the bumped scopes so the change is visible
 * immediately on this instance; other instances pick it up within
 * GENERATION_MEMO_MS — bounded, documented, and far cheaper than a pub/sub
 * fan-out for entries that expire in half a minute anyway.
 */
export async function bumpGeneration(scopes: FeedCacheScope[]): Promise<void> {
  if (scopes.length === 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const scope of scopes) pipeline.incr(generationKey(scope));
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, scopes }, 'feed: failed to bump cache generation');
  } finally {
    for (const scope of scopes) generationMemo.delete(scope);
  }
}

// ---------------------------------------------------------------------------
// Shared page cache
// ---------------------------------------------------------------------------

/**
 * Read-through cache around a page loader.
 *
 * `loader` is always the source of truth. A hit short-circuits it; every kind of
 * failure — miss, unreachable Redis, unparsable payload — runs it.
 */
export async function withPageCache(
  scope: FeedCacheScope,
  parts: Record<string, unknown>,
  loader: () => Promise<FeedPage>
): Promise<FeedPage> {
  const generation = await currentGeneration(scope);
  const key = `${PREFIX}:page:${scope}:g${generation}:${digest(parts)}`;

  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as FeedPage;
  } catch (err) {
    // A corrupt entry must not poison the endpoint forever — fall through, and
    // the write below overwrites it.
    logger.warn({ err, scope }, 'feed: page cache read failed');
  }

  const page = await loader();

  try {
    await redis.set(key, JSON.stringify(page), 'EX', CACHE_TTL_SECONDS.page);
  } catch (err) {
    logger.warn({ err, scope }, 'feed: page cache write failed');
  }

  return page;
}

// ---------------------------------------------------------------------------
// Following feed (per viewer, first page only)
// ---------------------------------------------------------------------------

export async function readFollowingPage(viewerId: string): Promise<FeedPage | null> {
  try {
    const hit = await redis.get(followingKey(viewerId));
    return hit ? (JSON.parse(hit) as FeedPage) : null;
  } catch (err) {
    logger.warn({ err }, 'feed: following cache read failed');
    return null;
  }
}

export async function writeFollowingPage(viewerId: string, page: FeedPage): Promise<void> {
  try {
    await redis.set(
      followingKey(viewerId),
      JSON.stringify(page),
      'EX',
      CACHE_TTL_SECONDS.following
    );
  } catch (err) {
    logger.warn({ err }, 'feed: following cache write failed');
  }
}

/**
 * Drops one viewer's cached following feed.
 *
 * Precise, O(1), and used by the follow/unfollow subscribers: unlike the shared
 * feeds, we know exactly whose feed changed when an edge is created or removed,
 * so there is no reason to invalidate anything else. Without it a user would
 * follow someone and watch their feed not change for up to the TTL — the one
 * staleness a reader attributes to a bug rather than to caching.
 */
export async function dropFollowingPage(viewerId: string): Promise<void> {
  try {
    await redis.del(followingKey(viewerId));
  } catch (err) {
    logger.warn({ err }, 'feed: following cache invalidation failed');
  }
}

// ---------------------------------------------------------------------------
// Ranked snapshots
// ---------------------------------------------------------------------------

/**
 * Identifier for a ranked ordering: a digest of everything that determines it.
 *
 * Deterministic, so the same request in the same ranking bucket resolves to the
 * same snapshot — which is what lets a page-2 request reuse the ordering page 1
 * built, and what lets a rebuild after eviction reproduce it.
 */
export function snapshotId(parts: Record<string, unknown>): string {
  return digest(parts);
}

export async function readSnapshot(id: string): Promise<string[] | null> {
  try {
    const hit = await redis.get(snapshotKey(id));
    if (!hit) return null;
    const parsed = JSON.parse(hit);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch (err) {
    logger.warn({ err }, 'feed: snapshot read failed');
    return null;
  }
}

export async function writeSnapshot(id: string, blogIds: string[]): Promise<void> {
  try {
    await redis.set(
      snapshotKey(id),
      JSON.stringify(blogIds),
      'EX',
      CACHE_TTL_SECONDS.snapshot
    );
  } catch (err) {
    logger.warn({ err }, 'feed: snapshot write failed');
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Hashes a parameter bag into a fixed-length key component.
 *
 * Canonicalized first so logically identical requests — the same filters in a
 * different key order, the same tags in a different array order — land on one
 * key instead of each paying for its own miss.
 */
function digest(parts: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(parts)))
    .digest('hex')
    .slice(0, 32);
}

/** Test seam: drops the in-process generation memo. */
export function resetGenerationMemo(): void {
  generationMemo.clear();
}
