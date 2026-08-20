import { analyticsQueue } from '../../core/providers/queue';
import { env } from '../../core/config/env';
import { logger } from '../../core/utils/logger';
import { FLUSH_JOB, PRUNE_JOB } from './analytics.worker';

/**
 * Registers the analytics module's repeatable jobs.
 *
 * Safe — and necessary — to call from every instance on every boot: a fresh
 * Redis holds no schedules at all, and an upsert of an identical schedule is a
 * no-op.
 *
 * ── Why `upsertJobScheduler`, not `add({ repeat })` ────────────────────────
 * `queue.add(name, data, { repeat })` keys the schedule by a HASH of the repeat
 * options. Change ANALYTICS_FLUSH_INTERVAL_MS and the next boot registers a
 * SECOND schedule under a new hash while the old one keeps firing — the flush
 * quietly runs on two cadences at once, which nothing surfaces until someone
 * reads a queue dashboard. Passing `jobId` does not help: for a repeatable job
 * that names the delivered jobs, not the schedule.
 *
 * `upsertJobScheduler` takes an explicit scheduler id and replaces whatever was
 * registered under it, so a changed interval updates the schedule in place and
 * there is exactly one at all times.
 */

const FLUSH_SCHEDULE_ID = 'analytics-flush-schedule';
const PRUNE_SCHEDULE_ID = 'analytics-prune-schedule';

/** Retention runs at 03:15 UTC — off the hour, away from typical traffic peaks. */
const PRUNE_CRON = '15 3 * * *';

let registered = false;

/**
 * Schedules the flush and prune jobs. Idempotent within a process.
 *
 * Failures are logged, not thrown: a queue that cannot be reached at boot must
 * not stop the API from serving requests. Analytics degrades to "buffers fill
 * and are flushed once the queue recovers", and the buffers' TTLs bound how much
 * a long outage can cost.
 */
export async function registerAnalyticsSchedules(): Promise<void> {
  if (registered) return;
  registered = true;

  try {
    await analyticsQueue.upsertJobScheduler(
      FLUSH_SCHEDULE_ID,
      { every: env.ANALYTICS_FLUSH_INTERVAL_MS },
      {
        name: FLUSH_JOB,
        opts: {
          // A flush that failed is not worth replaying minutes later: the next
          // cycle picks up the same buckets — they were restored to the dirty
          // set — and writes them with fresher data alongside. Retrying would
          // multiply the work during exactly the incident that caused the
          // failure.
          attempts: 1,
          // Bounded by COUNT rather than the platform default's 24-hour age.
          // At one job a minute an age-based policy would retain ~1,440 records
          // of a job whose only interesting state is "is it failing now".
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 50 },
        },
      }
    );

    await analyticsQueue.upsertJobScheduler(
      PRUNE_SCHEDULE_ID,
      { pattern: PRUNE_CRON },
      {
        name: PRUNE_JOB,
        opts: {
          attempts: 3,
          removeOnComplete: { count: 10 },
          removeOnFail: { count: 20 },
        },
      }
    );

    logger.info(
      { flushIntervalMs: env.ANALYTICS_FLUSH_INTERVAL_MS, pruneCron: PRUNE_CRON },
      'Analytics schedules registered'
    );
  } catch (err) {
    logger.error({ err }, 'analytics: failed to register schedules — flushes will not run');
  }
}

/** Test seam. */
export function resetAnalyticsScheduleRegistration(): void {
  registered = false;
}
