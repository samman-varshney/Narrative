import { createHash } from 'crypto';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { logger } from '../../core/utils/logger';
import { exportQueue } from '../../core/providers/queue';
import { exportBuilder } from './export.builder';
import {
  EXPORT_COOLDOWN_HOURS,
  EXPORT_MAX_BYTES,
  EXPORT_TTL_DAYS,
} from './export.config';
import { exportRepository, type ExportRequestMetadata } from './export.repository';
import type { ExportRequestDTO } from './export.types';

const gzipAsync = promisify(gzip);

/** How many past requests the history endpoint returns. */
const HISTORY_LIMIT = 20;

export class ExportService {
  /**
   * Queues a new export.
   *
   * Two separate refusals, because they are different situations the user needs
   * told apart: one export is already building (wait for it), or the cooldown
   * has not elapsed (come back later). Collapsing them into one "try again"
   * makes the second indistinguishable from a stuck job.
   */
  async request(userId: string): Promise<ExportRequestDTO> {
    const inFlight = await exportRepository.countInFlight(userId);
    if (inFlight > 0) {
      throw new AppError(
        'An export is already being prepared for your account',
        409,
        'EXPORT_IN_PROGRESS'
      );
    }

    const latest = await exportRepository.findLatestForUser(userId);
    const readyAt = this.cooldownEndsAt(latest);
    if (readyAt) {
      throw new AppError(
        `You can request another export after ${readyAt.toISOString()}`,
        429,
        'EXPORT_COOLDOWN',
        true,
        { retryAfter: readyAt.toISOString() }
      );
    }

    const created = await exportRepository.create(userId);

    /**
     * Enqueued directly rather than through the domain event bus.
     *
     * This is a COMMAND — "build this export" — with exactly one handler, not a
     * fact several modules react to. Routing it through the bus would let any
     * subscriber start a second build of the same artifact, and would make the
     * job's retry policy the bus's rather than this module's.
     *
     * A failed enqueue leaves a PENDING row behind, which the user can see and
     * which the next request would block on. Marked FAILED immediately instead,
     * so a queue outage produces an honest error rather than a request that
     * waits forever.
     */
    try {
      await exportQueue.add('build-export', { exportId: created.id, userId });
    } catch (err) {
      logger.error({ err, exportId: created.id }, 'export: failed to enqueue build job');
      await exportRepository.transition(created.id, ['PENDING'], 'FAILED', {
        error: 'Could not be queued. Please try again.',
        completedAt: new Date(),
      });
      throw new AppError(
        'Could not queue the export. Please try again.',
        503,
        'EXPORT_QUEUE_UNAVAILABLE'
      );
    }

    return this.toDTO(created);
  }

  async getById(id: string, userId: string): Promise<ExportRequestDTO> {
    const found = await exportRepository.findById(id);
    if (!found || found.userId !== userId) {
      // 404 rather than 403 for someone else's export: a distinguishable
      // "forbidden" would confirm the id exists, which is an enumeration oracle
      // over other people's requests.
      throw new AppError('Export not found', 404, 'EXPORT_NOT_FOUND');
    }
    return this.toDTO(found);
  }

  async listForUser(userId: string): Promise<ExportRequestDTO[]> {
    const rows = await exportRepository.listForUser(userId, HISTORY_LIMIT);
    return rows.map((row) => this.toDTO(row));
  }

  /**
   * The bytes, with ownership and expiry decided on the same row that produced
   * them.
   *
   * Expiry is checked against the clock as well as against `status`: the sweep
   * runs periodically, so between an artifact lapsing and the sweep noticing
   * there is a window in which the row still says READY. Trusting the status
   * alone would serve an expired artifact for the length of that window.
   */
  async download(id: string, userId: string) {
    const found = await exportRepository.findArtifact(id);
    if (!found || found.userId !== userId) {
      throw new AppError('Export not found', 404, 'EXPORT_NOT_FOUND');
    }

    if (found.status !== 'READY' || !found.artifact) {
      throw new AppError(
        found.status === 'EXPIRED'
          ? 'This export has expired. Request a new one.'
          : 'This export is not ready to download',
        409,
        found.status === 'EXPIRED' ? 'EXPORT_EXPIRED' : 'EXPORT_NOT_READY'
      );
    }

    if (found.expiresAt && found.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        'This export has expired. Request a new one.',
        409,
        'EXPORT_EXPIRED'
      );
    }

    // Best-effort: a counter that fails must not fail the download the user is
    // actually here for.
    exportRepository
      .incrementDownloadCount(id)
      .catch((err) => logger.warn({ err, exportId: id }, 'export: download count failed'));

    return {
      artifact: Buffer.from(found.artifact),
      checksum: found.checksum,
      sizeBytes: found.sizeBytes,
      filename: `narrative-export-${id}.json.gz`,
    };
  }

  /**
   * Builds and stores an artifact. Called by the worker, never by a request.
   *
   * Claims the job with a conditional PENDING → PROCESSING transition. BullMQ is
   * at-least-once, so a retry after a worker died mid-build would otherwise run
   * a second build concurrently with the first and race it to the same row.
   */
  async process(exportId: string, userId: string): Promise<void> {
    const claimed = await exportRepository.transition(exportId, ['PENDING'], 'PROCESSING', {
      startedAt: new Date(),
    });

    if (!claimed) {
      logger.info({ exportId }, 'export: job already claimed or finished, skipping');
      return;
    }

    try {
      const document = await exportBuilder.build(exportId, userId);
      const artifact = await gzipAsync(Buffer.from(JSON.stringify(document, null, 2), 'utf8'));

      /**
       * Over the cap: FAIL rather than truncate.
       *
       * A silently partial export of your own data is worse than none — you
       * cannot tell which half is missing, and the failure is invisible exactly
       * when the export matters most. The user gets an error naming the size so
       * a human can act on it.
       */
      if (artifact.length > EXPORT_MAX_BYTES) {
        await this.fail(
          exportId,
          `The export is too large to deliver (${artifact.length} bytes). Please contact support.`
        );
        logger.error({ exportId, bytes: artifact.length }, 'export: artifact exceeds cap');
        return;
      }

      const checksum = createHash('sha256').update(artifact).digest('hex');
      const expiresAt = new Date(Date.now() + EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000);

      const stored = await exportRepository.markReady(exportId, artifact, checksum, expiresAt);
      if (!stored) {
        logger.warn({ exportId }, 'export: row was no longer PROCESSING at store time');
        return;
      }

      eventBus.emit(EVENTS.DATA_EXPORT_READY, { userId, exportId, expiresAt });
    } catch (err) {
      logger.error({ err, exportId, userId }, 'export: build failed');
      await this.fail(exportId, 'The export could not be generated. Please try again.');
      // Rethrown so BullMQ records the failure and applies its retry policy —
      // `fail` above records what the USER sees, not what the queue does.
      throw err;
    }
  }

  /** Drops expired artifacts. Called by the scheduled sweep. */
  async sweepExpired(): Promise<number> {
    const count = await exportRepository.expireArtifacts(new Date());
    if (count > 0) logger.info({ count }, 'export: expired artifacts dropped');
    return count;
  }

  /**
   * When the cooldown lapses, or null if the user may request now.
   *
   * Measured from the last request of ANY status, including FAILED. Anchoring on
   * successes only would let a user whose exports keep failing retry in a loop —
   * and a failing export is the expensive case, since it fails at the END of a
   * full build.
   */
  private cooldownEndsAt(latest: ExportRequestMetadata | null): Date | null {
    if (!latest) return null;
    const readyAt = new Date(
      latest.requestedAt.getTime() + EXPORT_COOLDOWN_HOURS * 60 * 60 * 1000
    );
    return readyAt.getTime() > Date.now() ? readyAt : null;
  }

  private async fail(exportId: string, message: string): Promise<void> {
    await exportRepository.transition(exportId, ['PROCESSING'], 'FAILED', {
      error: message,
      completedAt: new Date(),
    });
  }

  private toDTO(row: ExportRequestMetadata): ExportRequestDTO {
    return {
      id: row.id,
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      sizeBytes: row.sizeBytes,
      checksum: row.checksum,
      downloadCount: row.downloadCount,
      error: row.error,
      downloadable:
        row.status === 'READY' &&
        (!row.expiresAt || row.expiresAt.getTime() > Date.now()),
    };
  }
}

export const exportService = new ExportService();
