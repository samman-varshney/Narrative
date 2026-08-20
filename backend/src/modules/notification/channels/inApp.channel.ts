import type {
  INotificationChannel,
  NotificationRequest,
  ResolvedPreferences,
} from '../notification.types';

/**
 * In-app channel.
 *
 * A pseudo-channel: the Notification row the orchestrator already persisted IS
 * the delivery, so `deliver` has nothing to do and no NotificationDelivery row
 * is written. It exists as a channel so preference handling and future
 * real-time push (WebSocket) have a uniform place to live.
 */
export class InAppNotificationChannel implements INotificationChannel {
  readonly name = 'IN_APP' as const;

  supports(request: NotificationRequest, prefs: ResolvedPreferences): boolean {
    return prefs[request.type]?.inApp ?? false;
  }

  async deliver(): Promise<void> {
    // No-op by design. Persistence happens in the orchestrator, which must
    // create the row before any external channel can reference it.
    //
    // Extension point: publish to a WebSocket topic here so an open client gets
    // the notification live instead of on next poll.
  }
}

export const inAppNotificationChannel = new InAppNotificationChannel();
