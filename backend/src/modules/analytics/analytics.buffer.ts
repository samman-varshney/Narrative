import type { Redis } from 'ioredis';
import { redis as sharedRedis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import {
  BUFFER_TTL_SECONDS,
  DIRTY_SET_KEY,
  KEY_VERSION,
  blogBufferKey,
  blogDirtyMember,
  parseDirtyMember,
  uniqueViewersKey,
  userBufferKey,
  userDirtyMember,
  type BlogBufferField,
  type UserBufferField,
} from './analytics.keys';

/**
 * The Redis aggregation buffer — the write-side of the analytics pipeline.
 *
 * Everything a reader does lands here as an `HINCRBY` on a per-blog-per-day hash
 * and is drained into PostgreSQL in batches by the flush worker. No request, and
 * no event handler, ever writes to PostgreSQL.
 *
 * ── Why counters instead of an event log ────────────────────────────────────
 * The naive buffer is a Redis list of raw events that the worker replays. That
 * just moves the write amplification: a million views is a million list entries
 * and a million rows to fold. Incrementing a counter makes the buffer O(active
 * blogs × days) no matter how much traffic arrives, which is what keeps memory
 * predictable during exactly the traffic spike that would otherwise sink it.
 *
 * ── Draining is atomic ─────────────────────────────────────────────────────
 * The obvious drain — `HGETALL` then `DEL` — has a window between the two calls
 * where an increment is read AND then deleted, silently losing it. Worse, with
 * two workers both could read the same hash and both write it to PostgreSQL,
 * doubling the numbers. `DRAIN_SCRIPT` below does the whole thing inside one
 * Lua evaluation, which Redis runs to completion without interleaving anything
 * else — so a bucket is handed to exactly one caller, exactly once.
 *
 * ── The residual failure window ────────────────────────────────────────────
 * Once drained, the deltas live only in the worker's memory until PostgreSQL
 * accepts them. A failed write puts them back (`restore`) and the job retries.
 * A hard process crash in that window loses them. That is a deliberate trade:
 * the alternative (staging keys plus an orphan sweeper) costs a second round
 * trip on every flush to protect against a crash inside a window measured in
 * milliseconds, and the exposure is capped at one flush interval of counters.
 * See ANALYTICS_MODULE.md § "Failure handling".
 */

/** Hash field carrying the blog's author. Not a counter — excluded from deltas. */
const AUTHOR_FIELD = 'authorId';

/**
 * Buckets drained per flush cycle.
 *
 * Bounds both the Lua script's runtime (Redis is single-threaded — a script that
 * runs long blocks every other client, including the rate limiter in front of
 * the API) and the size of the batch INSERT that follows. Buckets left over stay
 * in the dirty set and are taken by the next cycle, so this caps latency, never
 * throughput.
 */
export const DRAIN_BATCH_SIZE = 500;

/**
 * Atomically claims up to N dirty buckets and empties them.
 *
 * `SPOP` removes the members BEFORE the hashes are read, which is the correct
 * order: an increment arriving after the pop re-adds its member, so it is
 * flushed next cycle. Popping after reading would let that increment's member be
 * removed while its value was already gone — the delta would then sit in a
 * hash nothing points at until it silently expired.
 *
 * The `PFCOUNT` is read but the HyperLogLog is NOT deleted: it accumulates the
 * whole day's distinct readers, so it must survive every intra-day flush. It is
 * written to PostgreSQL as an absolute value rather than a delta for that
 * reason, and expires on its own TTL.
 *
 * NOTE: this script derives key names from ARGV rather than declaring them in
 * KEYS, which Redis Cluster would reject. Narrative runs a single Redis; a move
 * to Cluster needs this rewritten to pop first and pipeline the rest.
 */
const DRAIN_SCRIPT = `
local dirty  = KEYS[1]
local prefix = ARGV[1]
local batch  = tonumber(ARGV[2])

local members = redis.call('SPOP', dirty, batch)
local out = {}

for i = 1, #members do
  local member = members[i]
  local scope, id, date = string.match(member, '^([^|]+)|([^|]+)|([^|]+)$')
  if scope then
    local key
    if scope == 'blog' then
      key = prefix .. ':buf:blog:' .. id .. ':' .. date
    else
      key = prefix .. ':buf:user:' .. id .. ':' .. date
    end

    local values = redis.call('HGETALL', key)
    redis.call('DEL', key)

    local unique = 0
    if scope == 'blog' then
      unique = redis.call('PFCOUNT', prefix .. ':uniq:' .. id .. ':' .. date)
    end

    out[#out + 1] = { member, values, unique }
  end
end

return out
`;

/** One bucket handed back by a drain, already parsed. */
export interface DrainedBucket {
  scope: 'blog' | 'user';
  /** blogId or userId. */
  id: string;
  date: string;
  /** Only set for blog buckets. */
  authorId?: string;
  /** Counter deltas. Fields absent from the hash are absent here. */
  counters: Record<string, number>;
  /** Absolute distinct-reader count for the day. Blog buckets only. */
  uniqueViews: number;
}

export class AnalyticsBuffer {
  constructor(private readonly redis: Redis = sharedRedis) {}

  // ---- Write side --------------------------------------------------------

  /**
   * Applies counter deltas to a blog's daily bucket and marks it dirty.
   *
   * One pipeline, so a view costs a single round trip regardless of how many
   * counters it touches. `authorId` rides along on every write rather than
   * being set once: the hash is deleted by each drain, so a "set it on create"
   * scheme would leave every post-drain bucket without an author.
   */
  async incrementBlog(
    blogId: string,
    authorId: string,
    date: string,
    deltas: Partial<Record<BlogBufferField, number>>
  ): Promise<void> {
    const key = blogBufferKey(blogId, date);
    const pipeline = this.redis.pipeline();

    pipeline.hset(key, AUTHOR_FIELD, authorId);
    for (const [field, value] of Object.entries(deltas)) {
      if (value) pipeline.hincrby(key, field, value);
    }
    pipeline.expire(key, BUFFER_TTL_SECONDS);
    pipeline.sadd(DIRTY_SET_KEY, blogDirtyMember(blogId, date));

    await pipeline.exec();
  }

  /** Applies counter deltas to a user's daily bucket and marks it dirty. */
  async incrementUser(
    userId: string,
    date: string,
    deltas: Partial<Record<UserBufferField, number>>
  ): Promise<void> {
    const key = userBufferKey(userId, date);
    const pipeline = this.redis.pipeline();

    for (const [field, value] of Object.entries(deltas)) {
      if (value) pipeline.hincrby(key, field, value);
    }
    pipeline.expire(key, BUFFER_TTL_SECONDS);
    pipeline.sadd(DIRTY_SET_KEY, userDirtyMember(userId, date));

    await pipeline.exec();
  }

  /**
   * Adds a reader to a blog's distinct-reader set for the day.
   *
   * A HyperLogLog, not a Redis Set. A Set is exact but grows with the audience —
   * a post read by a million people would hold a million 32-character hashes,
   * ~40MB, for one blog for one day. The HLL answers the same question in a
   * fixed 12KB with ~0.81% standard error, which is well inside what a
   * "unique readers" figure means to an author.
   */
  async addUniqueViewer(blogId: string, date: string, identityHash: string): Promise<void> {
    const key = uniqueViewersKey(blogId, date);
    const pipeline = this.redis.pipeline();
    pipeline.pfadd(key, identityHash);
    pipeline.expire(key, BUFFER_TTL_SECONDS);
    await pipeline.exec();
  }

  // ---- Drain side --------------------------------------------------------

  /**
   * Claims and empties up to `limit` dirty buckets.
   *
   * The caller now OWNS these deltas: they are gone from Redis, and losing them
   * loses data. Anything that fails downstream must hand them back via
   * `restore`.
   */
  async drain(limit: number = DRAIN_BATCH_SIZE): Promise<DrainedBucket[]> {
    const raw = (await this.redis.eval(
      DRAIN_SCRIPT,
      1,
      DIRTY_SET_KEY,
      `analytics:${KEY_VERSION}`,
      String(limit)
    )) as [string, string[], number][];

    const buckets: DrainedBucket[] = [];

    for (const [member, flat, unique] of raw ?? []) {
      const parsed = parseDirtyMember(member);
      if (!parsed) {
        logger.warn({ member }, 'analytics: unparsable dirty member skipped');
        continue;
      }

      const counters: Record<string, number> = {};
      let authorId: string | undefined;

      // Redis returns a hash as a flat [field, value, field, value, ...] array.
      for (let i = 0; i < flat.length; i += 2) {
        const field = flat[i]!;
        const value = flat[i + 1]!;
        if (field === AUTHOR_FIELD) {
          authorId = value;
          continue;
        }
        const parsedValue = Number.parseInt(value, 10);
        if (Number.isFinite(parsedValue)) counters[field] = parsedValue;
      }

      // An author-only hash means the bucket was marked dirty but every counter
      // was already drained — nothing to write.
      if (Object.keys(counters).length === 0 && unique === 0) continue;

      buckets.push({
        scope: parsed.scope,
        id: parsed.id,
        date: parsed.date,
        ...(authorId !== undefined && { authorId }),
        counters,
        uniqueViews: unique,
      });
    }

    return buckets;
  }

  /**
   * Returns drained deltas to Redis after a failed write.
   *
   * Additive, so it composes correctly with anything that arrived in the
   * meantime — the bucket simply ends up holding the sum, which is what the next
   * flush should write. `uniqueViews` is not restored because it was never
   * removed: the HyperLogLog it came from is untouched by a drain.
   *
   * Best-effort by necessity. If Redis is the reason the flush failed, this
   * fails too; it is logged and the deltas are lost, which is the same outcome
   * as the crash window above and no worse than not trying.
   */
  async restore(buckets: DrainedBucket[]): Promise<void> {
    if (buckets.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();

      for (const bucket of buckets) {
        const key =
          bucket.scope === 'blog'
            ? blogBufferKey(bucket.id, bucket.date)
            : userBufferKey(bucket.id, bucket.date);

        if (bucket.scope === 'blog' && bucket.authorId) {
          pipeline.hset(key, AUTHOR_FIELD, bucket.authorId);
        }
        for (const [field, value] of Object.entries(bucket.counters)) {
          if (value) pipeline.hincrby(key, field, value);
        }
        pipeline.expire(key, BUFFER_TTL_SECONDS);
        pipeline.sadd(
          DIRTY_SET_KEY,
          bucket.scope === 'blog'
            ? blogDirtyMember(bucket.id, bucket.date)
            : userDirtyMember(bucket.id, bucket.date)
        );
      }

      await pipeline.exec();
      logger.warn({ count: buckets.length }, 'analytics: drained buckets restored to Redis');
    } catch (err) {
      logger.error(
        { err, count: buckets.length },
        'analytics: FAILED to restore drained buckets — these counters are lost'
      );
    }
  }

  /** How many buckets are waiting. Operational visibility only. */
  async pendingBuckets(): Promise<number> {
    return this.redis.scard(DIRTY_SET_KEY);
  }
}

export const analyticsBuffer = new AnalyticsBuffer();
