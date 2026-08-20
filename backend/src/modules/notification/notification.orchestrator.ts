import { notificationRepository } from './notification.repository';
import { resolvePreferences } from './notification.preferences';
import { inAppNotificationChannel } from './channels/inApp.channel';
import { emailNotificationChannel } from './channels/email.channel';
import type {
  INotificationChannel,
  NotificationRequest,
  ResolvedPreferences,
} from './notification.types';
import { userRepository } from '../user/user.repository';
import { logger } from '../../core/utils/logger';

/**
 * The single entry point for creating a notification.
 *
 * Subscribers hand it NotificationRequests; it decides which channels apply and
 * dispatches to them. Business modules never see a channel, and nothing outside
 * this module calls a channel directly.
 *
 * Registration order is delivery order. Adding Push/SMS/WebSocket means adding
 * an entry here — no other file changes.
 */
export class NotificationOrchestrator {
  private readonly channels: INotificationChannel[] = [
    inAppNotificationChannel,
    emailNotificationChannel,
  ];

  /**
   * Processes one request end to end. Returns whether a new notification was
   * created (false when deduped), so callers can report accurately.
   */
  async dispatch(request: NotificationRequest): Promise<{ created: boolean }> {
    // Never notify someone about their own action — commenting on your own blog,
    // replying to yourself. Cheapest possible check, so it comes first.
    if (request.actorId && request.actorId === request.recipientId) {
      return { created: false };
    }

    const prefs = await this.loadPreferences(request.recipientId);

    // With in-app off, there is no row to hang deliveries off and nothing for the
    // user to come back to. Treat the whole notification as opted out.
    if (!inAppNotificationChannel.supports(request, prefs)) {
      return { created: false };
    }

    const { created, id } = await notificationRepository.create(request);

    // No id means the row was deduped AND then vanished before we could read it
    // back (a recipient deleted mid-flight cascades it away). There is nothing
    // left to attach a delivery to.
    if (!id) return { created: false };

    // Deliver even when the row already existed.
    //
    // Domain-event jobs are at-least-once, so a worker killed between the
    // INSERT and the enqueue must be able to finish the job on replay —
    // returning early here would strand the notification with no email, and
    // permanently: every later replay would take the same early exit.
    //
    // Re-delivering cannot double-send. The unique (notificationId, channel)
    // index stops a second delivery row, the deterministic job id stops a
    // second job, and the email worker refuses anything already marked SENT.
    // Send-once is those three guards' job, not this branch's.
    await this.deliverExternal(request, id, prefs);

    // Still reports whether THIS call created the notification, so callers and
    // their tests keep an accurate answer to "was this a new notification?".
    return { created };
  }

  /**
   * Fan-out path: rows are already bulk-inserted by the caller, so this only
   * dispatches external channels for the ones that were newly created.
   */
  async deliverExternal(
    request: NotificationRequest,
    notificationId: string,
    prefs: ResolvedPreferences
  ): Promise<void> {
    const external = this.channels.filter((c) => c.name !== 'IN_APP');

    await Promise.all(
      external.map(async (channel) => {
        if (!channel.supports(request, prefs)) return;
        try {
          await channel.deliver(request, notificationId);
        } catch (err) {
          // One failing channel must not prevent the others, nor undo the
          // notification that was already persisted.
          logger.error(
            { err, channel: channel.name, notificationId },
            'Notification channel delivery failed'
          );
        }
      })
    );
  }

  /**
   * Resolves preferences for MANY users in a single query. Used by fan-out,
   * where per-recipient lookups would be an N+1 over the shared pool.
   * Recipients with no settings row simply get defaults.
   */
  async loadPreferencesBulk(userIds: string[]): Promise<Map<string, ResolvedPreferences>> {
    const result = new Map<string, ResolvedPreferences>();
    if (userIds.length === 0) return result;

    let rows: { userId: string; notificationPreferences: unknown }[] = [];
    try {
      rows = (await userRepository.findSettingsByUserIds(userIds)) as any;
    } catch (err) {
      logger.error({ err }, 'Bulk preference load failed — using defaults for the batch');
    }

    const stored = new Map(rows.map((r) => [r.userId, r.notificationPreferences]));
    for (const userId of userIds) {
      result.set(userId, resolvePreferences(stored.get(userId) ?? null));
    }
    return result;
  }

  /**
   * Resolves preferences, defaulting when the settings row or the column is
   * absent. A lookup failure defaults rather than throws — a preferences read
   * must never be the reason a user misses a notification.
   */
  async loadPreferences(userId: string): Promise<ResolvedPreferences> {
    try {
      const settings = await userRepository.findSettingsByUserId(userId);
      return resolvePreferences(settings?.notificationPreferences ?? null);
    } catch (err) {
      logger.error({ err, userId }, 'Failed to load notification preferences — using defaults');
      return resolvePreferences(null);
    }
  }
}

export const notificationOrchestrator = new NotificationOrchestrator();
