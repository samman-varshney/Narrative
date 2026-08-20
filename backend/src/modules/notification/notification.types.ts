import { NotificationType, DeliveryChannel } from '@prisma/client';

/**
 * The single currency of this module: subscribers translate domain events into
 * NotificationRequests, and the orchestrator turns those into persisted rows and
 * queued deliveries. Nothing upstream knows which channels exist.
 */
export interface NotificationRequest {
  recipientId: string;
  /** Who caused it. Null/undefined for SYSTEM notifications. */
  actorId?: string | null;
  type: NotificationType;
  entityType?: 'BLOG' | 'COMMENT' | 'USER';
  entityId?: string;
  /**
   * Render inputs (blogTitle, commentExcerpt, slug...) — never rendered text.
   * Templates and the read API turn this into copy at read/send time.
   */
  metadata?: Record<string, unknown>;
  /**
   * Idempotency key. Two requests carrying the same key produce one row, so a
   * retried job or a duplicated event cannot double-notify.
   */
  dedupeKey: string;
}

/** In-app is a pseudo-channel: persisted directly, with no delivery tracking. */
export type ChannelName = 'IN_APP' | DeliveryChannel;

/**
 * Strategy interface. Adding Push/SMS/WebSocket means adding an implementation
 * and registering it — the orchestrator never changes.
 */
export interface INotificationChannel {
  readonly name: ChannelName;
  /**
   * Whether this channel should handle the request, given the recipient's
   * resolved preferences. Keeps per-channel opt-out logic inside the channel.
   */
  supports(request: NotificationRequest, prefs: ResolvedPreferences): boolean;
  /**
   * Deliver. `notificationId` is null only when in-app persistence was skipped,
   * which today cannot happen — external channels always have a row to attach to.
   */
  deliver(request: NotificationRequest, notificationId: string): Promise<void>;
}

/** Per-type channel toggles, fully resolved (defaults already applied). */
export interface ChannelToggles {
  inApp: boolean;
  email: boolean;
}

export type ResolvedPreferences = Record<NotificationType, ChannelToggles>;
