import {
  createWorker,
  QUEUES,
  notificationQueue,
  emailQueue,
} from '../../core/providers/queue';
import { notificationRepository } from './notification.repository';
import { notificationDeliveryRepository } from './notificationDelivery.repository';
import { notificationOrchestrator } from './notification.orchestrator';
import {
  SEND_NOTIFICATION_EMAIL,
  emailJobId,
  type NotificationEmailJob,
} from './channels/email.channel';
import { followRepository } from '../follow/follow.repository';
import { blogRepository } from '../blog/blog.repository';
import { logger } from '../../core/utils/logger';
import {
  FANOUT_BLOG_PUBLISHED,
  type BlogPublishedFanoutJob,
} from './subscribers/blog.subscriber';
import type { NotificationRequest } from './notification.types';

/**
 * Follower ids per batch. Large enough that a typical author finishes in one
 * pass, small enough that a single `createMany` and its follow-up preference
 * reads stay bounded for an author with hundreds of thousands of followers.
 */
const FANOUT_BATCH_SIZE = 1000;

/**
 * NOTIFICATION worker — blog-publish fan-out.
 *
 * Each job handles ONE batch and, if more remain, enqueues a continuation for
 * the next keyset position. Chaining rather than looping means a single job
 * never runs unboundedly long, progress survives a crash mid-fan-out (the
 * completed batches stay written), and a retry replays only the failed batch.
 *
 * IMPORTANT: opens a Redis connection on construction — import ONLY from
 * server.ts. See media.worker.ts.
 */
export const notificationWorker = createWorker(QUEUES.NOTIFICATION, async (job) => {
  if (job.name !== FANOUT_BLOG_PUBLISHED) {
    logger.warn({ jobName: job.name }, 'Unknown notification job — skipped');
    return;
  }

  const { blogId, authorId, slug, runId, afterId } = job.data as BlogPublishedFanoutJob;

  // Re-check the blog each batch: it may have been unpublished, hidden or
  // deleted partway through a long fan-out, and continuing would notify people
  // about something they can no longer open.
  const blog = await blogRepository.findVisibilityById(blogId);
  if (!blog || blog.status !== 'PUBLISHED') {
    logger.info({ blogId }, 'Blog no longer published — fan-out stopped');
    return;
  }

  // Status alone is not permission. A PRIVATE or MEMBERS_ONLY blog is PUBLISHED
  // but unreadable to an ordinary follower, so fanning out would push a row —
  // and an EMAIL CARRYING THE TITLE — to people `blogService.canView` rejects.
  // UNLISTED is excluded too: it means "reachable by link, absent from
  // discovery", and a notification to every follower is a discovery surface.
  if (blog.visibility !== 'PUBLIC') {
    logger.info(
      { blogId, visibility: blog.visibility },
      'Blog is not publicly visible — fan-out skipped'
    );
    return;
  }

  const { ids, nextAfterId } = await followRepository.getFollowerIdsBatch(authorId, {
    afterId,
    limit: FANOUT_BATCH_SIZE,
  });

  if (ids.length > 0) {
    await fanOutBatch({ blogId, authorId, slug, title: blog.title }, ids);
  }

  if (nextAfterId) {
    await notificationQueue.add(
      FANOUT_BLOG_PUBLISHED,
      { blogId, authorId, slug, runId, afterId: nextAfterId } satisfies BlogPublishedFanoutJob,
      // Deterministic id: a retry (or a stall after the continuation was already
      // added) would otherwise fork a second chain from the same position and
      // double the remaining work, compounding down a long fan-out.
      //
      // Scoped by runId, NOT just position. Completed jobs linger for an hour
      // (removeOnComplete), and `add` on an existing id is a SILENT no-op — so
      // keying on (blogId, position) alone meant an archive->publish cycle
      // within that hour reused the previous run's ids and the chain simply
      // stopped after batch one, with nothing logged.
      { jobId: `fanout:${blogId}:${runId}:${nextAfterId}` }
    );
  }
});

/**
 * Writes one batch of notifications, then queues the email sends.
 *
 * Every step is bulk. In-app rows go in with a single insert — per-recipient
 * orchestrator calls would mean 1000 round trips per batch. `skipDuplicates`
 * plus the dedupeKey unique index makes a replayed batch a no-op, so a retry
 * cannot double-notify, and the enqueue below is idempotent for the same reason
 * at the job level.
 */
async function fanOutBatch(
  blog: { blogId: string; authorId: string; slug: string; title: string },
  recipientIds: string[]
): Promise<void> {
  const requests: NotificationRequest[] = recipientIds.map((recipientId) => ({
    recipientId,
    actorId: blog.authorId,
    type: 'BLOG' as const,
    entityType: 'BLOG' as const,
    entityId: blog.blogId,
    metadata: { slug: blog.slug, blogTitle: blog.title },
    dedupeKey: `BLOG:${blog.blogId}:${recipientId}`,
  }));

  // ONE query for the whole batch. Per-recipient lookups here would be an N+1
  // that serializes ~1000 queries over the pool Express shares, stalling every
  // concurrent HTTP request behind the fan-out.
  const prefsById = await notificationOrchestrator.loadPreferencesBulk(
    requests.map((r) => r.recipientId)
  );

  // Pair each request with its resolved preferences up front, so the two never
  // drift apart as the list is filtered.
  // Optional chaining is load-bearing: a NotificationType added to the Prisma
  // enum but not to DEFAULT_PREFERENCES resolves to undefined here, and a bare
  // property read would throw and take the whole batch down.
  const pairs = requests
    .map((request) => ({ request, prefs: prefsById.get(request.recipientId)! }))
    .filter(({ request, prefs: p }) => p[request.type]?.inApp ?? false);

  if (pairs.length === 0) return;

  await notificationRepository.createMany(pairs.map((p) => p.request));

  const emailPairs = pairs.filter(({ request, prefs: p }) => p[request.type]?.email ?? false);
  if (emailPairs.length === 0) return;

  // createMany returns no ids, so resolve the rows in ONE query rather than per
  // recipient. Rows already present from an earlier attempt come back too —
  // harmless, because the enqueue below is idempotent.
  const rows = await notificationRepository.findIdsByDedupeKeys(
    emailPairs.map(({ request }) => request.dedupeKey)
  );
  const idByKey = new Map(rows.map((r) => [r.dedupeKey, r.id]));

  const notificationIds = emailPairs
    .map(({ request }) => idByKey.get(request.dedupeKey))
    .filter((id): id is string => !!id);

  await enqueueEmailsBulk(notificationIds);
}

/**
 * Queues the email sends for a whole batch in THREE round trips.
 *
 * The obvious implementation — `deliverExternal` per recipient under a
 * `Promise.all` — issued one INSERT and one Redis add for each of up to 1000
 * recipients. The pg pool (max 10) is shared with Express, so a single batch
 * parked ~1000 queued queries in front of every concurrent HTTP request: the
 * exact N+1 the bulk preference load above exists to avoid.
 *
 * Send-once still holds, by a different guard. `createMany` cannot report which
 * rows it inserted, so the per-row `created` flag is unavailable here — the
 * deterministic job id carries the property instead, and BullMQ collapses a
 * duplicate add into one job.
 */
async function enqueueEmailsBulk(notificationIds: string[]): Promise<void> {
  if (notificationIds.length === 0) return;

  await notificationDeliveryRepository.createManyPending(notificationIds, 'EMAIL');

  const deliveries = await notificationDeliveryRepository.findByNotificationIds(
    notificationIds,
    'EMAIL'
  );

  // Rows from an earlier run that already went out. The worker would refuse
  // them anyway; skipping here avoids waking it up to say so.
  const pending = deliveries.filter((d) => d.status !== 'SENT');
  if (pending.length === 0) return;

  try {
    await emailQueue.addBulk(
      pending.map((d) => ({
        name: SEND_NOTIFICATION_EMAIL,
        data: {
          notificationId: d.notificationId,
          deliveryId: d.id,
        } satisfies NotificationEmailJob,
        opts: { jobId: emailJobId(d.id) },
      }))
    );
  } catch (err) {
    // Rows stay PENDING with no job behind them. Unlike the single-dispatch
    // path there is nothing to roll back to — the next publish would dedupe —
    // so this is logged loudly and surfaced by findStuckPending.
    logger.error(
      { err, count: pending.length },
      'Failed to bulk-enqueue fan-out emails — deliveries left PENDING'
    );
  }
}
