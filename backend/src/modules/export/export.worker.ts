import { createWorker, exportQueue, QUEUES } from '../../core/providers/queue';
import { logger } from '../../core/utils/logger';
import { exportService } from './export.service';
import type { ExportJobData } from './export.types';

/**
 * DATA_EXPORT worker — builds artifacts and drops expired ones.
 *
 * Two jobs share the queue, discriminated by name, the same arrangement the
 * analytics worker uses:
 *
 *   BUILD_JOB  assembles one user's export. Enqueued on demand by
 *              `exportService.request`.
 *   SWEEP_JOB  nulls the bytes of artifacts past their expiry. Repeatable,
 *              hourly.
 *
 * IMPORTANT: constructing a BullMQ Worker opens a Redis connection and starts
 * polling, so this module must be imported ONLY from server.ts — never from
 * app.ts or a service — or every test suite that touches `app` spins up a live
 * export worker against the test Redis. Same rule as media.worker.ts and
 * analytics.worker.ts.
 *
 * ── Why the sweep is a repeatable job, not a TTL ────────────────────────────
 * The artifact lives in a Postgres column, and Postgres has no expiry. Something
 * has to run the DELETE. A repeatable job is scheduled once in Redis and
 * delivered to exactly one worker, so adding instances does not multiply the
 * sweep — and the download path checks `expiresAt` against the clock anyway, so
 * an artifact is unreachable the moment it lapses whether or not the sweep has
 * caught up. The sweep reclaims the space; it does not enforce the expiry.
 */

export const BUILD_JOB = 'export.build';
export const SWEEP_JOB = 'export.sweep';

const SWEEP_SCHEDULE_ID = 'export-sweep-schedule';

/** Hourly, at :40 — off the hour, away from the analytics jobs. */
const SWEEP_CRON = '40 * * * *';

let started = false;

export function startExportWorker(): void {
  if (started) return;
  started = true;

  createWorker(QUEUES.DATA_EXPORT, async (job) => {
    if (job.name === SWEEP_JOB) {
      return exportService.sweepExpired();
    }

    const { exportId, userId } = job.data as ExportJobData;
    if (!exportId || !userId) {
      // Malformed job: nothing to build, and retrying cannot make it valid.
      logger.error({ jobId: job.id, data: job.data }, 'export: malformed job, discarding');
      return;
    }

    await exportService.process(exportId, userId);
  });

  logger.info('Export worker started');
}

/**
 * Registers the sweep schedule. Idempotent, and safe to call from every instance
 * on every boot — `upsertJobScheduler` replaces whatever is registered under the
 * id rather than adding a second schedule under a new options hash.
 *
 * Failures are logged, not thrown: a queue unreachable at boot must not stop the
 * API from serving. The consequence of a missed sweep is retained bytes, not a
 * leaked artifact — expiry is enforced on the download path.
 */
export async function registerExportSchedules(): Promise<void> {
  try {
    await exportQueue.upsertJobScheduler(
      SWEEP_SCHEDULE_ID,
      { pattern: SWEEP_CRON },
      {
        name: SWEEP_JOB,
        opts: {
          attempts: 3,
          removeOnComplete: { count: 10 },
          removeOnFail: { count: 20 },
        },
      }
    );
    logger.info({ sweepCron: SWEEP_CRON }, 'Export schedules registered');
  } catch (err) {
    logger.error({ err }, 'export: failed to register the sweep schedule');
  }
}
