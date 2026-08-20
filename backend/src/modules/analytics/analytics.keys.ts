import { createHash } from 'crypto';
import { env } from '../../core/config/env';

/**
 * The Analytics Redis keyspace — every key the module writes is built here.
 *
 * Centralised on purpose. The flush worker, the ingestion service and the
 * operational tooling all have to agree byte-for-byte on these strings; a key
 * built inline at three call sites is a silently orphaned buffer waiting to
 * happen. It also means the keyspace can be reviewed in one screen, which is how
 * a TTL gets noticed as missing.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 *
 *   analytics:v1:buf:blog:{blogId}:{date}   HASH  per-blog daily counters
 *   analytics:v1:buf:user:{userId}:{date}   HASH  per-user daily counters
 *   analytics:v1:uniq:{blogId}:{date}       HLL   distinct readers for the day
 *   analytics:v1:dirty                      SET   buckets awaiting a flush
 *   analytics:v1:owner:{blogId}             STR   cached blog author + reading time
 *   analytics:v1:dedupe:{eventId}           STR   at-least-once delivery guard
 *   analytics:v1:view:{blogId}:{identity}   STR   view dedupe window
 *   analytics:v1:read:{blogId}:{session}    STR   open reading session
 *   analytics:v1:readq:{blogId}:{identity}  STR   reads claimed per window
 *   analytics:v1:gen:{ownerId}              STR   report cache generation
 *   analytics:v1:rep:{scope}:g{n}:{hash}    STR   cached report payload
 *
 * ── Why aggregation and not an event log ────────────────────────────────────
 * There is deliberately NO key per event. A busy day would mint millions of
 * them, and Redis would become a queue of raw facts that PostgreSQL then has to
 * replay. Counters collapse an unbounded event stream into O(blogs × days)
 * keys, which is the property that makes the buffer's memory predictable.
 *
 * ── Why everything expires ──────────────────────────────────────────────────
 * Redis is a BUFFER, never the source of truth. Every key here has a TTL, so a
 * flush worker that stays down degrades to lost recent counters rather than an
 * ever-growing keyspace — and PostgreSQL still holds everything already
 * flushed. The one exception is the dirty set, which is drained by the flush
 * itself and is bounded by the number of active buckets.
 */

/** Bumped only if the SHAPE of a buffered value changes incompatibly. */
export const KEY_VERSION = 'v1';

const PREFIX = `analytics:${KEY_VERSION}`;

// ---------------------------------------------------------------------------
// TTLs
// ---------------------------------------------------------------------------

/**
 * Buffer and HyperLogLog lifetime.
 *
 * Must comfortably outlive the day the bucket belongs to plus the flush
 * interval, or a bucket could expire between its last increment and its final
 * flush — losing a whole day's tail. 48 hours gives a full day of slack for a
 * flush worker that was down overnight.
 */
export const BUFFER_TTL_SECONDS = 48 * 60 * 60;

/**
 * How long a processed event id is remembered.
 *
 * Only has to outlive BullMQ's retry envelope (5 attempts, exponential backoff
 * from 2s — minutes, not hours). A day is generous, and bounds the dedupe
 * keyspace to roughly one day of event volume.
 */
export const EVENT_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long an open reading session is remembered.
 *
 * Long enough for a genuinely slow read of a long post, short enough that an
 * abandoned tab does not let a completion be claimed the next day.
 */
export const READ_SESSION_TTL_SECONDS = 4 * 60 * 60;

/** Blog author + reading-time cache. Authorship is immutable; reading time is not. */
export const OWNER_CACHE_TTL_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Identity hashing
// ---------------------------------------------------------------------------

/**
 * Hashes a reader identity for use in a Redis key.
 *
 * Analytics needs to know that two requests came from the same reader; it never
 * needs to know WHO. Hashing with a private salt gives the first without the
 * second, so a Redis dump — the most likely place this data leaks from, since
 * it is the only place it is written at all — contains no user ids and no
 * client identifiers.
 *
 * 128 bits of the digest: collision-free at any plausible reader volume, and
 * half the key length of the full hex.
 */
export function hashIdentity(identity: string): string {
  return createHash('sha256')
    .update(`${env.ANALYTICS_ID_SALT}:${identity}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The identity a view is deduplicated against.
 *
 * Signed-in readers are keyed by user id, so the same person is one reader
 * across devices. Anonymous readers are keyed by the client-supplied id.
 * `null` means the caller offered neither: the view is still counted (it
 * happened) but cannot be deduplicated or counted as unique, which is strictly
 * better than dropping it or falling back to an IP address.
 */
export function viewerIdentity(event: {
  userId?: string;
  anonymousId?: string;
}): string | null {
  if (event.userId) return hashIdentity(`u:${event.userId}`);
  if (event.anonymousId) return hashIdentity(`a:${event.anonymousId}`);
  return null;
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/**
 * Fields inside a blog buffer hash. Named separately from the Prisma column
 * names they map to so a schema rename cannot silently orphan a live buffer.
 */
export const BLOG_BUFFER_FIELDS = [
  'views',
  'readStarts',
  'readCompletions',
  'totalReadingSeconds',
  'bookmarks',
  'unbookmarks',
  'comments',
] as const;
export type BlogBufferField = (typeof BLOG_BUFFER_FIELDS)[number];

export const USER_BUFFER_FIELDS = [
  'followersGained',
  'followersLost',
  'blogsPublished',
] as const;
export type UserBufferField = (typeof USER_BUFFER_FIELDS)[number];

export const blogBufferKey = (blogId: string, date: string): string =>
  `${PREFIX}:buf:blog:${blogId}:${date}`;

export const userBufferKey = (userId: string, date: string): string =>
  `${PREFIX}:buf:user:${userId}:${date}`;

export const uniqueViewersKey = (blogId: string, date: string): string =>
  `${PREFIX}:uniq:${blogId}:${date}`;

// ---------------------------------------------------------------------------
// Dirty set
// ---------------------------------------------------------------------------

/**
 * Buckets with unflushed data.
 *
 * The flush is driven by this set, never by `SCAN`/`KEYS`: scanning is O(whole
 * keyspace) on a Redis shared with sessions, rate limiters and BullMQ, and it
 * grows more expensive exactly as the platform does. Reading the set is O(dirty
 * buckets), which is the number of blogs that saw traffic since the last flush.
 *
 * A member also survives a day boundary, so yesterday's final partial bucket is
 * flushed by today's first cycle with no special-casing.
 */
export const DIRTY_SET_KEY = `${PREFIX}:dirty`;

/** `blog|{blogId}|{date}` or `user|{userId}|{date}`. */
export type DirtyMember = string;

export const blogDirtyMember = (blogId: string, date: string): DirtyMember =>
  `blog|${blogId}|${date}`;

export const userDirtyMember = (userId: string, date: string): DirtyMember =>
  `user|${userId}|${date}`;

export interface ParsedDirtyMember {
  scope: 'blog' | 'user';
  id: string;
  date: string;
}

/**
 * Parses a dirty-set member. Returns null for anything malformed, so a stray
 * value written by an older build (or by hand) is skipped rather than crashing
 * the flush for every other bucket.
 */
export function parseDirtyMember(member: DirtyMember): ParsedDirtyMember | null {
  const parts = member.split('|');
  if (parts.length !== 3) return null;
  const [scope, id, date] = parts as [string, string, string];
  if (scope !== 'blog' && scope !== 'user') return null;
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { scope, id, date };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export const eventDedupeKey = (eventId: string): string => `${PREFIX}:dedupe:${eventId}`;

export const viewDedupeKey = (blogId: string, identityHash: string): string =>
  `${PREFIX}:view:${blogId}:${identityHash}`;

/**
 * An open reading session. Keyed by session id AND identity so one reader
 * cannot complete another's session by guessing an id.
 */
export const readSessionKey = (
  blogId: string,
  identityHash: string,
  sessionId: string
): string => `${PREFIX}:read:${blogId}:${identityHash}:${sessionId}`;

/**
 * Open reading sessions started by one reader on one blog inside the dedupe
 * window. A counter, not a set: it exists only to cap how many reads a single
 * client can claim, and the identities of those sessions are already tracked by
 * `readSessionKey`.
 */
export const readQuotaKey = (blogId: string, identityHash: string): string =>
  `${PREFIX}:readq:${blogId}:${identityHash}`;

/** Cached `{ authorId, readingTimeMinutes }` for a blog. */
export const blogOwnerKey = (blogId: string): string => `${PREFIX}:owner:${blogId}`;

// ---------------------------------------------------------------------------
// Report cache
// ---------------------------------------------------------------------------

/**
 * Per-owner cache generation.
 *
 * Analytics reads are cached by (owner, range, granularity, metric), so one
 * flush touching one author invalidates an unknowable set of keys. As in the
 * Search module, the fix is a generation number embedded in every key: the flush
 * `INCR`s the generation for exactly the authors it wrote, and their cached
 * reports become unreachable in O(1) — no scan, no delete list. Untouched
 * authors keep their cache, which per-scope invalidation would have thrown away.
 */
export const generationKey = (ownerId: string): string => `${PREFIX}:gen:${ownerId}`;

export const reportKey = (scope: string, generation: number, digest: string): string =>
  `${PREFIX}:rep:${scope}:g${generation}:${digest}`;
