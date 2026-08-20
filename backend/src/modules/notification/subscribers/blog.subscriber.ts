import { randomUUID } from 'crypto';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { notificationQueue } from '../../../core/providers/queue';
import { logger } from '../../../core/utils/logger';
import { env } from '../../../core/config/env';

/** Job name on notification_queue. */
export const FANOUT_BLOG_PUBLISHED = 'fanout:blog-published';

export interface BlogPublishedFanoutJob {
  blogId: string;
  authorId: string;
  slug: string;
  /**
   * Identifies ONE fan-out run. Continuation job ids are keyed on it so a
   * re-publish cannot collide with the previous run's ids — see the worker.
   */
  runId: string;
  /** Keyset position — the last Follow row id processed. */
  afterId?: string;
}

interface BlogPublishedPayload {
  blogId: string;
  authorId: string;
  slug: string;
  publishedAt?: string | Date;
}

/**
 * BLOG_PUBLISHED → notify the author's followers.
 *
 * This subscriber deliberately does NO database work. An author with 100k
 * followers would otherwise mean 100k inserts before the job completes; instead
 * it enqueues a single fan-out job and returns, and the worker pages through
 * followers in bounded batches.
 *
 * BLOG_UPDATED is intentionally NOT subscribed to: it fires on every draft edit,
 * for a blog followers cannot see yet, so notifying on it would be pure spam.
 */
export async function onBlogPublished(payload: BlogPublishedPayload): Promise<void> {
  const { blogId, authorId, slug } = payload;
  if (!blogId || !authorId) return;

  // Tests dispatch events inline and drain no queue, so enqueueing here would
  // pile orphaned jobs into the developer's Redis. Fan-out behaviour is covered
  // by invoking the worker's processor directly instead.
  if (env.NODE_ENV === 'test') return;

  try {
    // Fresh per run. A retried domain-event job mints a new one and re-walks the
    // followers, which is redundant work but never a duplicate notification —
    // every batch is guarded by the dedupeKey unique index.
    const runId = randomUUID();

    await notificationQueue.add(FANOUT_BLOG_PUBLISHED, {
      blogId,
      authorId,
      slug,
      runId,
    } satisfies BlogPublishedFanoutJob);
  } catch (err) {
    logger.error({ err, blogId }, 'Failed to enqueue blog-published fan-out');
  }
}

export function registerBlogSubscriber(): void {
  eventBus.on(EVENTS.BLOG_PUBLISHED, onBlogPublished);
}
