import { createHash } from 'crypto';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import {
  CACHE_TTL_SECONDS,
  GENERATION_MEMO_MS,
  SEO_DOCUMENT_VERSION,
} from './seo.config';
import type { RenderedDocument, ResolvedMetadata, SitemapSection } from './seo.types';

/**
 * Redis caching for resolved metadata and rendered crawler documents.
 *
 * ── Two invalidation mechanisms, for two different keyspaces ────────────────
 * The Feed, Search and RSS caches all invalidate by GENERATION: a counter is
 * part of every key, and invalidation is one `INCR` that makes an unknowable
 * set of keys unreachable at once. This module uses that for the sitemap, and
 * deliberately does NOT use it for per-resource metadata.
 *
 *   SITEMAP    One counter, `sitemap`. Any publish can move a post between
 *              chunks, so the blast radius genuinely is "all of it", and a
 *              single counter expresses that in one operation.
 *
 *   METADATA   Exact-key deletion. A generation per resource would mean one
 *              Redis counter per blog, per author and per tag — a counter
 *              keyspace that grows with the platform forever and is never
 *              reclaimed, which is precisely the "unbounded memory store" a
 *              cache must not become. Metadata keys are deterministic from the
 *              resource's identity, so the subscriber can compute the exact key
 *              and `DEL` it: O(1), precise, and nothing accumulates.
 *
 * The ROOT generation sits above both. It is the sledgehammer for events whose
 * blast radius cannot be enumerated cheaply — a suspension removes an entire
 * catalogue from the indexable set, and finding every page that mentions it is
 * an unbounded query on a path that must be immediate.
 *
 * ── The cache can never break a page ────────────────────────────────────────
 * Every Redis call here is best-effort. Redis being down, slow, or returning
 * garbage must degrade a response to "uncached", never to a 500 — so every
 * failure path logs and returns a value that makes the caller fall through to
 * the database. A missing generation reads as 0, which is a valid generation:
 * the worst case is that an entry written during an outage is reused for its
 * TTL.
 */

/** Bumped when a cached VALUE's shape changes. Distinct from the document version. */
const CACHE_VERSION = 'v1';

const PREFIX = `seo:${CACHE_VERSION}`;

/** The only two counters this module keeps. Both are bounded by construction. */
export type GenerationKey = 'root' | 'sitemap';

/** Metadata is cached per resource kind and identifier. */
export type MetadataCacheKind = 'site' | 'blog' | 'author' | 'category' | 'tag';

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
 * Batched through a pipeline because a sitemap request needs two of them, and
 * two sequential round trips in front of a response that is usually a 304 is
 * exactly the latency this cache exists to remove. Memoized entries are
 * answered from memory and never reach the pipeline.
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
    logger.warn({ err, keys: missing }, 'seo: failed to read cache generations');
    for (const key of missing) if (!result.has(key)) result.set(key, 0);
  }

  return result;
}

/**
 * Advances one or more generations, making every key that carries them
 * unreachable.
 *
 * De-duplicated first, and the memo is dropped even when the `INCR` fails — a
 * stale memo after a failed bump would keep this instance serving the old
 * generation for the memo window on top of whatever the failure already cost.
 */
export async function bumpGenerations(keys: GenerationKey[]): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;

  try {
    const pipeline = redis.pipeline();
    for (const key of unique) pipeline.incr(generationRedisKey(key));
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, keys: unique }, 'seo: failed to bump cache generations');
  } finally {
    for (const key of unique) generationMemo.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The cache key for one resource's resolved metadata.
 *
 * Deterministic from the document version, the resource's kind and its
 * identifier — which is what lets the subscriber recompute and delete the exact
 * key from an event, with no lookup. The identifier is hashed rather than
 * embedded so a pathological slug cannot produce an oversized Redis key.
 *
 * ── The identifier is a database id for blogs and authors ──────────────────
 * Not the slug or username from the URL, because both are MUTABLE:
 * `blogService` re-slugs a post when its title changes, and
 * `userService.updateProfile` lets a username change. An entry keyed by the old
 * name would go on being served under an address that now 404s, carrying a
 * canonical tag pointing at it — the exact duplicate-content failure this
 * module exists to prevent. It is also what lets an event carrying a `blogId`
 * delete the entry directly.
 *
 * Categories and tags ARE keyed by slug: the platform has no route that renames
 * one, so the value is immutable in practice and resolving an id first would be
 * a query that bought nothing. See `seo.service`.
 */
export function metadataKey(
  kind: MetadataCacheKind,
  identifier: string,
  rootGeneration: number
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([SEO_DOCUMENT_VERSION, kind, identifier]))
    .digest('hex')
    .slice(0, 32);

  return `${PREFIX}:meta:${kind}:r${rootGeneration}:${digest}`;
}

/** The cache key for the sitemap index. */
export function sitemapIndexKey(rootGeneration: number, sitemapGeneration: number): string {
  return `${PREFIX}:sitemap:index:r${rootGeneration}:s${sitemapGeneration}:${SEO_DOCUMENT_VERSION}`;
}

/** The cache key for one rendered chunk of one section. */
export function sitemapChunkKey(
  section: SitemapSection,
  page: number,
  rootGeneration: number,
  sitemapGeneration: number
): string {
  return `${PREFIX}:sitemap:${section}:${page}:r${rootGeneration}:s${sitemapGeneration}:${SEO_DOCUMENT_VERSION}`;
}

/**
 * The cache key for `robots.txt`.
 *
 * Carries the root generation only. The document is a function of configuration
 * alone, so nothing a user does can change it — but a platform-wide flush
 * should still reach it, and configuration changes arrive with a deploy.
 */
export function robotsKey(rootGeneration: number): string {
  return `${PREFIX}:robots:r${rootGeneration}:${SEO_DOCUMENT_VERSION}`;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * Reads resolved metadata.
 *
 * Returns `null` for every kind of failure — a miss, an unreachable Redis, an
 * unparsable or structurally wrong payload — because the caller's response to
 * all of them is identical: resolve it from the database. A corrupt entry must
 * not poison a page forever, and the write that follows a fall-through
 * overwrites it.
 *
 * `ResolvedMetadata` carries no `Date`: every instant in it is already an ISO
 * string, so it round-trips through JSON unchanged and needs no revival step.
 */
export async function readMetadata(key: string): Promise<ResolvedMetadata | null> {
  try {
    const hit = await redis.get(key);
    if (!hit) return null;

    const parsed = JSON.parse(hit) as ResolvedMetadata;
    if (typeof parsed?.canonicalUrl !== 'string' || typeof parsed?.title !== 'string') {
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn({ err }, 'seo: metadata cache read failed');
    return null;
  }
}

export async function writeMetadata(key: string, metadata: ResolvedMetadata): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(metadata), 'EX', CACHE_TTL_SECONDS.metadata);
  } catch (err) {
    logger.warn({ err }, 'seo: metadata cache write failed');
  }
}

/**
 * Drops one resource's cached metadata.
 *
 * The precise half of this module's invalidation: publishing a post drops that
 * post's entry and its author's, and leaves every other page on the platform
 * exactly as it was.
 */
export async function dropMetadata(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err }, 'seo: metadata cache invalidation failed');
  }
}

// ---------------------------------------------------------------------------
// Rendered documents (sitemaps, robots.txt)
// ---------------------------------------------------------------------------

/** What is actually stored. `lastModified` travels as an ISO string. */
interface CachedDocument {
  body: string;
  contentType: string;
  etag: string;
  lastModified: string | null;
}

export async function readDocument(key: string): Promise<RenderedDocument | null> {
  try {
    const hit = await redis.get(key);
    if (!hit) return null;

    const parsed = JSON.parse(hit) as CachedDocument;
    if (typeof parsed?.body !== 'string' || typeof parsed?.etag !== 'string') return null;

    return {
      body: parsed.body,
      contentType: parsed.contentType,
      etag: parsed.etag,
      lastModified: parsed.lastModified ? new Date(parsed.lastModified) : null,
    };
  } catch (err) {
    logger.warn({ err }, 'seo: document cache read failed');
    return null;
  }
}

export async function writeDocument(
  key: string,
  document: RenderedDocument,
  ttlSeconds: number
): Promise<void> {
  const payload: CachedDocument = {
    body: document.body,
    contentType: document.contentType,
    etag: document.etag,
    lastModified: document.lastModified ? document.lastModified.toISOString() : null,
  };

  try {
    await redis.set(key, JSON.stringify(payload), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err }, 'seo: document cache write failed');
  }
}

/** Test seam: drops the in-process generation memo. */
export function resetGenerationMemo(): void {
  generationMemo.clear();
}
