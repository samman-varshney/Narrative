import { createWorker, QUEUES } from '../../core/providers/queue';
import { mediaRepository } from './media.repository';
import { logger } from '../../core/utils/logger';

/**
 * MEDIA_PROCESSING worker.
 *
 * IMPORTANT: A BullMQ Worker opens a Redis connection and starts polling as soon
 * as it is constructed. This module must therefore be imported ONLY from
 * server.ts — never from app.ts or the service layer — so test suites that import
 * `app` do not spin up a live worker.
 *
 * Current scope: verify/backfill derived metadata. Thumbnail generation and other
 * derived variants are future extension points.
 */
export const mediaWorker = createWorker(QUEUES.MEDIA_PROCESSING, async (job) => {
  const { mediaId } = job.data as { mediaId?: string };
  if (!mediaId) return;

  const media = await mediaRepository.findById(mediaId);
  if (!media) {
    logger.warn({ mediaId }, 'Media processing job skipped — record not found or deleted');
    return;
  }

  // Future work: generate thumbnails / responsive variants, extract richer metadata.
  // For now we simply confirm the asset is present and processable.
  logger.info({ mediaId, provider: media.provider }, 'Processed media asset');
});
