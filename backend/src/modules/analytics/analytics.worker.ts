import { createWorker, QUEUES } from '../../core/providers/queue';
import { env } from '../../core/config/env';
import { logger } from '../../core/utils/logger';
import {
  AnalyticsBuffer,
  DRAIN_BATCH_SIZE,
  analyticsBuffer,
  type DrainedBucket,
} from './analytics.buffer';
import { bumpGenerations } from './analytics.cache';
import { analyticsStore } from './store/PostgresAnalyticsStore';
import type { IAnalyticsStore } from './store/IAnalyticsStore';
import { dateKey, reportingDaysAgo } from './analytics.time';
import type { BlogDailyDelta, UserDailyDelta } from './analytics.types';

/**
 * ANALYTICS_FLUSH worker — the only writer of the analytics tables.
 *
 * Two jobs share the queue, discriminated by name:
 *
 *   FLUSH_JOB  moves Redis buffers into PostgreSQL. Repeatable, every
 *              ANALYTICS_FLUSH_INTERVAL_MS.
 *   PRUNE_JOB  enforces retention. Repeatable, daily.
 *
 * IMPORTANT: constructing a BullMQ Worker opens a Redis connection and begins
 * polling, so this module must be imported ONLY from server.ts — never from
 * app.ts or a service — or every test suite that touches `app` spins up a live
 * flush worker against the test Redis. Same rule as media.worker.ts.
 *
 * ── Why a queue at all, rather than setInterval ────────────────────────────
 * The flush must run once per interval across the whole deployment, not once per
 * process. Two instances each running their own timer would both drain — safely,
 * thanks to the atomic drain, but at double the frequency and half the batch
 * size each. A repeatable job is scheduled once in Redis and delivered to
 * exactly one worker, so horizontal scaling changes nothing about the cadence.
 * It also inherits DEFAULT_JOB_OPTIONS: five attempts with exponential backoff,
 * and a failed job retained for a day to be looked at.
 */

export const FLUSH_JOB = 'analytics.flush';
export const PRUNE_JOB = 'analytics.prune';

/**
 * Drain rounds per flush run.
 *
 * A quiet platform finishes in one round. A busy one leaves the remainder in the
 * dirty set for the next cycle rather than letting a single job run unboundedly
 * long while holding a database connection — the same "bounded work per job,
 * leave the rest for the next one" shape the notification fan-out uses.
 */
const MAX_DRAIN_ROUNDS = 20;

/** Rows deleted per table per prune run. See `IAnalyticsStore.pruneBefore`. */
const PRUNE_BATCH_SIZE = 5_000;

export interface FlushSummary {
  blogRows: number;
  userRows: number;
  ownersInvalidated: number;
}

/**
 * Runs one flush cycle.
 *
 * Exported and dependency-injected so tests can drive it directly against real
 * Redis and PostgreSQL without standing up a BullMQ worker.
 */
export async function runFlush(
  buffer: AnalyticsBuffer = analyticsBuffer,
  store: IAnalyticsStore = analyticsStore
): Promise<FlushSummary> {
  let blogRows = 0;
  let userRows = 0;
  const touchedOwners = new Set<string>();

  for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
    const buckets = await buffer.drain(DRAIN_BATCH_SIZE);
    if (buckets.length === 0) break;

    const { blogDeltas, userDeltas, owners } = partition(buckets);

    try {
      // Sequential, not concurrent: both statements run on the pg pool Express
      // also uses, and a background flush has no deadline worth spending a
      // second connection on.
      if (blogDeltas.length > 0) await store.upsertBlogDaily(blogDeltas);
      if (userDeltas.length > 0) await store.upsertUserDaily(userDeltas);
    } catch (err) {
      // The deltas are already out of Redis and exist only in this function's
      // memory, so they MUST go back before this throws — otherwise the retry
      // drains an empty buffer and the counters are silently gone.
      await buffer.restore(buckets);
      logger.error(
        { err, buckets: buckets.length },
        'analytics: flush failed — buckets restored'
      );
      throw err;
    }

    blogRows += blogDeltas.length;
    userRows += userDeltas.length;
    for (const owner of owners) touchedOwners.add(owner);

    // A short round means the dirty set is drained; another `SPOP` would be a
    // wasted round trip.
    if (buckets.length < DRAIN_BATCH_SIZE) break;
  }

  // AFTER the write, never before. Bumping first opens a window where a request
  // repopulates the cache from pre-flush data and then looks fresh for a TTL.
  await bumpGenerations([...touchedOwners]);

  if (blogRows > 0 || userRows > 0) {
    logger.info(
      { blogRows, userRows, owners: touchedOwners.size },
      'analytics: flushed buffers to PostgreSQL'
    );
  }

  return { blogRows, userRows, ownersInvalidated: touchedOwners.size };
}

/**
 * Converts drained buckets into store rows.
 *
 * A blog bucket with no `authorId` is dropped: the column is NOT NULL, and the
 * only way to produce one is a hash that lost its author field while keeping its
 * counters — impossible in practice, since they share a key and a TTL. Logged
 * loudly rather than silently skipped, because if it ever does happen the
 * buffer's invariants have broken and that is worth knowing.
 */
function partition(buckets: DrainedBucket[]): {
  blogDeltas: BlogDailyDelta[];
  userDeltas: UserDailyDelta[];
  owners: string[];
} {
  const blogDeltas: BlogDailyDelta[] = [];
  const userDeltas: UserDailyDelta[] = [];
  const owners: string[] = [];

  for (const bucket of buckets) {
    if (bucket.scope === 'blog') {
      if (!bucket.authorId) {
        logger.warn(
          { blogId: bucket.id, date: bucket.date },
          'analytics: blog bucket without an author — dropped'
        );
        continue;
      }

      blogDeltas.push({
        blogId: bucket.id,
        authorId: bucket.authorId,
        date: bucket.date,
        views: bucket.counters.views ?? 0,
        uniqueViews: bucket.uniqueViews,
        readStarts: bucket.counters.readStarts ?? 0,
        readCompletions: bucket.counters.readCompletions ?? 0,
        totalReadingSeconds: bucket.counters.totalReadingSeconds ?? 0,
        bookmarks: bucket.counters.bookmarks ?? 0,
        unbookmarks: bucket.counters.unbookmarks ?? 0,
        comments: bucket.counters.comments ?? 0,
      });
      owners.push(bucket.authorId);
      continue;
    }

    userDeltas.push({
      userId: bucket.id,
      date: bucket.date,
      followersGained: bucket.counters.followersGained ?? 0,
      followersLost: bucket.counters.followersLost ?? 0,
      blogsPublished: bucket.counters.blogsPublished ?? 0,
    });
    // A user bucket is that user's own data, so they are their own cache owner.
    owners.push(bucket.id);
  }

  return { blogDeltas, userDeltas, owners };
}

/** Runs one retention pass. Exported for the same reason as `runFlush`. */
export async function runPrune(
  store: IAnalyticsStore = analyticsStore
): Promise<{ blogRows: number; userRows: number }> {
  // Derived through the same reporting-day helper the API's lookback bound uses.
  // Computing the cutoff straight from `new Date()` would put the two on
  // different calendars at a non-zero offset, and the prune would start deleting
  // a day the API still advertises as queryable.
  const cutoff = reportingDaysAgo(env.ANALYTICS_DAILY_RETENTION_DAYS);

  const result = await store.pruneBefore(cutoff, PRUNE_BATCH_SIZE);

  if (result.blogRows > 0 || result.userRows > 0) {
    logger.info(
      { ...result, cutoff: dateKey(cutoff) },
      'analytics: pruned expired aggregate rows'
    );
  }

  return result;
}

let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Starts the flush/prune consumer. Idempotent.
 *
 * A function rather than an import side effect, so server.ts controls exactly
 * when the Redis connection opens — matching `startDomainEventsWorker`.
 */
export function startAnalyticsWorker() {
  if (worker) return worker;

  worker = createWorker(QUEUES.ANALYTICS_FLUSH, async (job) => {
    switch (job.name) {
      case FLUSH_JOB:
        return runFlush();
      case PRUNE_JOB:
        return runPrune();
      default:
        logger.warn({ jobName: job.name }, 'analytics: unknown job — skipped');
        return;
    }
  });

  logger.info('Analytics worker started');
  return worker;
}
