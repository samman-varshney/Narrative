import { createHash } from 'crypto';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import { CACHE_TTL_SECONDS, GENERATION_MEMO_MS, RSS_DOCUMENT_VERSION } from './rss.config';
import type { RenderedFeed, RssFeedScope } from './rss.types';

/**
 * Redis caching for rendered feeds.
 *
 * ── What is cached, and why it is the RENDERED document ─────────────────────
 * The cache stores the finished XML together with its ETag and `Last-Modified`
 * — not the rows, and not the intermediate `SyndicationDocument`. That choice
 * is what makes the common case cheap: an RSS reader polling on a timer sends a
 * conditional request, and answering it needs the VALIDATOR and nothing else.
 * With the validator cached, a 304 costs one Redis read and no rendering at all.
 *
 * ── Generation counters, not key deletion ───────────────────────────────────
 * A single publish can affect the global feed, its author's feed, and one feed
 * per tag and category it carries — and each of those exists once per requested
 * `limit`. `SCAN`+`DEL` over that is O(keyspace) on a shared Redis and `KEYS` is
 * worse. Instead every feed carries generation numbers IN its key, and
 * invalidation is an `INCR`: old keys become unreachable instantly and are
 * reclaimed by their own TTL, at O(1) per event however large the cache grows.
 * The same design the Search and Feed modules use, for the same reason.
 *
 * ── Two generations per key, and the reason for the second ──────────────────
 * Every key carries BOTH a root generation and its own scope's generation:
 *
 *     rss:v1:tag:<id>:r3:g11:<digest>
 *                     ^^  ^^
 *                  root   scope
 *
 * The scope generation is the precise one. Publishing a post bumps exactly the
 * feeds that post belongs to — its author's, its tags', its categories' and the
 * global feed — and leaves every other author and every unrelated tag untouched.
 * That is the brief's "publishing a blog should not blindly invalidate every
 * author/category/tag feed", and it is where nearly all the cache's value is.
 *
 * The root generation is the sledgehammer, reserved for events whose blast
 * radius genuinely cannot be enumerated cheaply. A suspension removes an
 * account's ENTIRE catalogue from discovery, and finding every tag and category
 * that catalogue touches is an unbounded query on a moderation path that must be
 * immediate. So suspension, deactivation, deletion and moderation outcomes bump
 * the root, and every cached feed on the platform becomes unreachable at once.
 *
 * Splitting it this way means the precise mechanism handles the frequent,
 * ordinary events and the coarse one handles the rare, security-critical ones —
 * rather than choosing between a cache that is useless and one that leaks.
 *
 * ── The cache can never break a feed ────────────────────────────────────────
 * Every Redis call here is best-effort. Redis being down, slow, or returning
 * garbage must degrade a feed to "uncached", never to a 500 — so every failure
 * path logs and returns a value that makes the caller fall through to the
 * database. A missing generation reads as 0, which is a valid generation: the
 * worst case is that an entry written during an outage is reused for its TTL.
 */

/** Bumped when a cached VALUE's shape changes. Distinct from the DOCUMENT version. */
const CACHE_VERSION = 'v1';

const PREFIX = `rss:${CACHE_VERSION}`;

/**
 * A generation counter's identity.
 *
 * `root` has no subject. The other three are always per-subject: `author:<id>`,
 * `category:<id>`, `tag:<id>`. `global` is a scope with no subject but is NOT
 * the root — a publish bumps `global` (every global feed changes) without
 * touching one author's feed.
 */
export type GenerationKey =
  | 'root'
  | 'global'
  | `author:${string}`
  | `category:${string}`
  | `tag:${string}`;

/** The generation key a feed of this scope and subject reads. */
export function scopeGeneration(scope: RssFeedScope, subjectId: string | null): GenerationKey {
  if (scope === 'global' || !subjectId) return 'global';
  return `${scope}:${subjectId}` as GenerationKey;
}

interface MemoEntry {
  value: number;
  expiresAt: number;
}

const generationMemo = new Map<GenerationKey, MemoEntry>();

const generationRedisKey = (key: GenerationKey): string => `${PREFIX}:gen:${key}`;

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

/**
 * Reads several generation counters at once.
 *
 * Batched through a pipeline because every request needs two of them (root and
 * its scope), and two sequential round trips in front of a response that is
 * usually a 304 is exactly the latency this cache exists to remove. Memoized
 * entries are answered from memory and never reach the pipeline.
 */
export async function readGenerations(
  keys: GenerationKey[]
): Promise<Map<GenerationKey, number>> {
  const now = Date.now();
  const result = new Map<GenerationKey, number>();
  const missing: GenerationKey[] = [];

  for (const key of keys) {
    const memo = generationMemo.get(key);
    if (memo && memo.expiresAt > now) result.set(key, memo.value);
    else missing.push(key);
  }

  if (missing.length === 0) return result;

  try {
    const pipeline = redis.pipeline();
    for (const key of missing) pipeline.get(generationRedisKey(key));
    const replies = await pipeline.exec();

    missing.forEach((key, index) => {
      const [err, raw] = replies?.[index] ?? [new Error('no reply'), null];
      let value = 0;
      if (!err && typeof raw === 'string') {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) value = parsed;
      }
      result.set(key, value);
      generationMemo.set(key, { value, expiresAt: now + GENERATION_MEMO_MS });
    });
  } catch (err) {
    // Redis unreachable: every unresolved counter reads as generation 0. Feeds
    // still build from the database; the only consequence is that entries
    // written during the outage share a generation.
    logger.warn({ err, keys: missing }, 'rss: failed to read cache generations');
    for (const key of missing) if (!result.has(key)) result.set(key, 0);
  }

  return result;
}

/**
 * Advances one or more generations, making every key that carries them
 * unreachable.
 *
 * The in-process memo is dropped for the bumped keys so the change is visible
 * immediately on THIS instance; other instances pick it up within
 * `GENERATION_MEMO_MS`. That window is bounded, documented, and far cheaper than
 * a pub/sub fan-out for entries that expire in five minutes anyway.
 *
 * De-duplicated first: a post carrying the same tag twice, or an event handler
 * that computes overlapping scopes, must not double-increment — not for
 * correctness (any increment invalidates) but because a counter that advances by
 * an unpredictable amount is one nobody can reason about when debugging.
 */
export async function bumpGenerations(keys: GenerationKey[]): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;

  try {
    const pipeline = redis.pipeline();
    for (const key of unique) pipeline.incr(generationRedisKey(key));
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, keys: unique }, 'rss: failed to bump cache generations');
  } finally {
    // Dropped even on failure. A stale memo after a failed bump would keep this
    // instance serving the old generation for the memo window on top of
    // whatever the failure already cost.
    for (const key of unique) generationMemo.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Feed documents
// ---------------------------------------------------------------------------

/**
 * The cache key for one rendered feed.
 *
 * Everything that can change the BYTES is in it: the document version (a deploy
 * that changes the renderer must not serve documents built by the old one), the
 * scope and subject id, the requested item count, and the two generations.
 *
 * The subject is keyed by DATABASE ID, never by the slug or username from the
 * URL. A category renamed from `web-dev` to `web-development` is the same
 * channel with the same content, and keying on the slug would silently double
 * the entries for it — and, worse, leave the old key serving content under a
 * name that no longer exists.
 */
export function feedCacheKey(params: {
  scope: RssFeedScope;
  subjectId: string | null;
  limit: number;
  rootGeneration: number;
  scopeGeneration: number;
}): string {
  const subject = params.subjectId ?? '-';
  const digest = createHash('sha256')
    .update(
      JSON.stringify([RSS_DOCUMENT_VERSION, params.scope, subject, params.limit])
    )
    .digest('hex')
    .slice(0, 32);

  return `${PREFIX}:${params.scope}:r${params.rootGeneration}:g${params.scopeGeneration}:${digest}`;
}

/** What is actually stored. `lastModified` travels as an ISO string. */
interface CachedFeed {
  body: string;
  contentType: string;
  etag: string;
  lastModified: string | null;
  itemCount: number;
}

/**
 * Reads a rendered feed.
 *
 * Returns `null` for every kind of failure — a miss, an unreachable Redis, an
 * unparsable or structurally wrong payload — because the caller's response to
 * all of them is identical: build it from the database. A corrupt entry must not
 * poison an endpoint forever, and the write that follows a fall-through
 * overwrites it.
 */
export async function readFeed(key: string): Promise<RenderedFeed | null> {
  try {
    const hit = await redis.get(key);
    if (!hit) return null;

    const parsed = JSON.parse(hit) as CachedFeed;
    if (typeof parsed?.body !== 'string' || typeof parsed?.etag !== 'string') return null;

    return {
      body: parsed.body,
      contentType: parsed.contentType,
      etag: parsed.etag,
      lastModified: parsed.lastModified ? new Date(parsed.lastModified) : null,
      itemCount: parsed.itemCount ?? 0,
    };
  } catch (err) {
    logger.warn({ err }, 'rss: feed cache read failed');
    return null;
  }
}

/** Stores a rendered feed. Failure is logged and swallowed — the caller already
 *  has the document it was about to return. */
export async function writeFeed(key: string, feed: RenderedFeed): Promise<void> {
  const payload: CachedFeed = {
    body: feed.body,
    contentType: feed.contentType,
    etag: feed.etag,
    lastModified: feed.lastModified ? feed.lastModified.toISOString() : null,
    itemCount: feed.itemCount,
  };

  try {
    await redis.set(key, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, 'rss: feed cache write failed');
  }
}

/** Test seam: drops the in-process generation memo. */
export function resetGenerationMemo(): void {
  generationMemo.clear();
}
