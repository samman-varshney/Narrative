import { createWorker, QUEUES } from '../../core/providers/queue';
import { emailProvider } from '../../core/providers/email';
import { notificationRepository } from './notification.repository';
import { notificationDeliveryRepository } from './notificationDelivery.repository';
import { userRepository } from '../user/user.repository';
import { blogRepository } from '../blog/blog.repository';
import { renderNotificationEmail } from './templates';
import { logger } from '../../core/utils/logger';
import {
  SEND_NOTIFICATION_EMAIL,
  type NotificationEmailJob,
} from './channels/email.channel';

/**
 * EMAIL worker — renders and sends notification emails.
 *
 * This is the only place that touches an email provider, so a slow or failing
 * vendor costs a retry rather than an HTTP request. Every terminal state is
 * written to NotificationDelivery, so "did this email go out?" is answerable
 * after the fact.
 *
 * IMPORTANT: opens a Redis connection on construction — import ONLY from
 * server.ts. See media.worker.ts.
 */
export const emailWorker = createWorker(QUEUES.EMAIL, async (job) => {
  if (job.name !== SEND_NOTIFICATION_EMAIL) {
    logger.warn({ jobName: job.name }, 'Unknown email job — skipped');
    return;
  }

  const { notificationId, deliveryId } = job.data as NotificationEmailJob;

  // The delivery cascades away with its notification, so a deleted notification
  // (or a deleted recipient) leaves this job pointing at nothing. Bail before
  // touching it — incrementing attempts on a missing row would throw and burn
  // all five retries on something that can never succeed.
  const existing = await notificationDeliveryRepository.findById(deliveryId);
  if (!existing) {
    logger.info({ notificationId, deliveryId }, 'Delivery gone — email job discarded');
    return;
  }

  // THE exactly-once guard. The unique (notificationId, channel) index prevents
  // duplicate ENQUEUE, not duplicate SEND — a retry after a successful send would
  // otherwise mail the user again. Reachable whenever the process dies between
  // `send()` and the SENT write, when a stalled job's lock expires, or when a
  // provider times out on a message it actually accepted.
  if (existing.status === 'SENT') {
    logger.info({ notificationId, deliveryId }, 'Delivery already SENT — retry ignored');
    return;
  }

  const attempts = await notificationDeliveryRepository.incrementAttempts(deliveryId);

  try {
    const notification = await notificationRepository.findById(notificationId);
    if (!notification) {
      // Deleted between the delivery lookup above and now — vanishingly rare,
      // but the delivery row may still exist, so record why it stopped.
      logger.warn({ notificationId }, 'Notification gone — email skipped');
      await notificationDeliveryRepository
        .updateStatus(deliveryId, 'FAILED', { error: 'Notification no longer exists' })
        .catch(() => {}); // it may have cascaded away in the meantime
      return;
    }

    const recipient = await userRepository.findById(notification.recipientId);
    if (!recipient?.email) {
      logger.warn({ notificationId }, 'Recipient has no email — skipped');
      await notificationDeliveryRepository.updateStatus(deliveryId, 'FAILED', {
        error: 'Recipient has no email address',
      });
      return;
    }

    // Deleted/suspended accounts must stop receiving mail even if a job for them
    // was already queued.
    if (recipient.status !== 'ACTIVE') {
      logger.info({ notificationId }, 'Recipient not active — email skipped');
      await notificationDeliveryRepository.updateStatus(deliveryId, 'FAILED', {
        error: `Recipient status is ${recipient.status}`,
      });
      return;
    }

    const metadata: Record<string, unknown> = {
      ...((notification.metadata as Record<string, unknown>) ?? {}),
      username: notification.actor?.username,
    };

    // COMMENT/REPLY notifications carry only `blogId`, but their templates need
    // a title and slug to render a headline and a working link. Resolved here
    // (send path only) rather than denormalised onto every notification row,
    // which would also go stale when a blog is renamed.
    if (!metadata.slug && typeof metadata.blogId === 'string') {
      const blog = await blogRepository.findVisibilityById(metadata.blogId);
      if (blog) {
        metadata.slug = blog.slug;
        metadata.blogTitle = blog.title;
      }
    }

    const rendered = renderNotificationEmail(notification.type, {
      recipientName: recipient.name,
      actorName: notification.actor?.name ?? null,
      metadata,
      entityId: notification.entityId,
    });

    const { providerMessageId } = await emailProvider.send({
      to: recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    await notificationDeliveryRepository.updateStatus(deliveryId, 'SENT', {
      provider: emailProvider.name,
      providerMessageId,
    });

    logger.info({ notificationId, deliveryId, attempts }, 'Notification email sent');
  } catch (err) {
    await notificationDeliveryRepository.updateStatus(deliveryId, 'FAILED', {
      provider: emailProvider.name,
      error: err instanceof Error ? err.message : String(err),
    });

    // Rethrow so BullMQ retries with the configured exponential backoff. The
    // delivery row already records the failure, so if every attempt fails the
    // reason survives.
    throw err;
  }
});
