import type {
  INotificationChannel,
  NotificationRequest,
  ResolvedPreferences,
} from '../notification.types';
import { notificationDeliveryRepository } from '../notificationDelivery.repository';
import { emailQueue } from '../../../core/providers/queue';
import { logger } from '../../../core/utils/logger';

/** Job name on email_queue. Named (not anonymous) so the worker can route. */
export const SEND_NOTIFICATION_EMAIL = 'send:notification-email';

export interface NotificationEmailJob {
  notificationId: string;
  deliveryId: string;
}

/**
 * Deterministic job id for a delivery's send.
 *
 * BullMQ collapses an `add` whose job id already exists, so enqueueing the same
 * delivery twice yields ONE job. That is the guard the bulk fan-out path relies
 * on: `createMany` cannot report which rows it inserted, so "did I create the
 * row?" is unavailable there and the job id has to carry the send-once property
 * instead. Safe to reuse forever — a delivery id is never recycled, so a second
 * add for the same id is always a duplicate we want dropped.
 */
export const emailJobId = (deliveryId: string): string => `email:${deliveryId}`;

/**
 * Email channel.
 *
 * Enqueues only — it never renders or sends. That is what keeps email fully off
 * the HTTP request path: rendering and provider I/O happen in the email worker,
 * where a slow or failing provider costs a retry rather than a request timeout.
 */
export class EmailNotificationChannel implements INotificationChannel {
  readonly name = 'EMAIL' as const;

  supports(request: NotificationRequest, prefs: ResolvedPreferences): boolean {
    return prefs[request.type]?.email ?? false;
  }

  async deliver(_request: NotificationRequest, notificationId: string): Promise<void> {
    // The PENDING row is created BEFORE enqueueing, so a job can never reference
    // a delivery that does not exist yet — the worker would otherwise race it.
    const delivery = await notificationDeliveryRepository.create(notificationId, 'EMAIL');

    // Someone already claimed this (notification, channel) — a replayed fan-out
    // batch or a retried dispatch. The send is already queued or done; enqueueing
    // again would deliver the same email twice.
    if (!delivery.created) return;

    try {
      await emailQueue.add(
        SEND_NOTIFICATION_EMAIL,
        { notificationId, deliveryId: delivery.id } satisfies NotificationEmailJob,
        { jobId: emailJobId(delivery.id) }
      );
    } catch (err) {
      // A queue outage must not fail the caller — but the PENDING row cannot be
      // left behind either. Its existence is exactly what makes the next
      // `create` return `created: false`, so an orphaned row would block every
      // future retry from ever re-queueing this email: one Redis blip would
      // lose it permanently. Rolling it back restores the invariant "a delivery
      // row exists <=> a job was enqueued", so a replayed dispatch recreates it.
      logger.error(
        { err, notificationId, deliveryId: delivery.id },
        'Failed to enqueue notification email — rolling back the delivery row'
      );

      await notificationDeliveryRepository.delete(delivery.id).catch((deleteErr) =>
        // Now genuinely stuck: PENDING with no job behind it. findStuckPending
        // is what surfaces this, so it is loud rather than silent.
        logger.error(
          { err: deleteErr, notificationId, deliveryId: delivery.id },
          'Failed to roll back delivery row — email is stuck PENDING'
        )
      );
    }
  }
}

export const emailNotificationChannel = new EmailNotificationChannel();
