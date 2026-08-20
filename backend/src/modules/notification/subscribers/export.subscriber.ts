import { eventBus, EVENTS, type DomainEventMeta } from '../../../core/events/eventBus';
import { notificationOrchestrator } from '../notification.orchestrator';

/**
 * "Your data export is ready" → a notification.
 *
 * Same arrangement as the moderation subscriber: the Export module emits a fact
 * and knows nothing about notifications, and this file turns that fact into
 * copy. Export stays a leaf that Notification depends on rather than the other
 * way round.
 *
 * ── SYSTEM, and no actor ────────────────────────────────────────────────────
 * Nobody did this to the user — they asked for it — so `actorId` is null and the
 * type is SYSTEM. SYSTEM also already defaults to `{ inApp: true, email: true }`
 * in the preference matrix, which matters here more than it does for most
 * notifications: an artifact expires in seven days, and someone who muted this
 * would silently lose an export they asked for.
 *
 * ── The link is not in the notification ─────────────────────────────────────
 * `metadata` carries the export id and the expiry, not a download URL. The
 * download requires an authenticated request that proves ownership, so there is
 * no URL that would work on its own — and putting one in an email would create
 * the impression that there is.
 */

interface ExportReadyPayload {
  userId?: string;
  exportId?: string;
  expiresAt?: string | Date;
}

export async function onDataExportReady(
  payload: ExportReadyPayload,
  meta: DomainEventMeta
): Promise<void> {
  const { userId, exportId } = payload ?? {};
  if (!userId || !exportId) return;

  const expiresAt =
    payload.expiresAt instanceof Date
      ? payload.expiresAt.toISOString()
      : payload.expiresAt ?? null;

  await notificationOrchestrator.dispatch({
    recipientId: userId,
    actorId: null,
    type: 'SYSTEM',
    entityType: 'USER',
    entityId: userId,
    metadata: {
      title: 'Your data export is ready',
      body: expiresAt
        ? `Your export is ready to download. It will remain available until ${expiresAt}.`
        : 'Your export is ready to download.',
      exportId,
      expiresAt,
    },
    // Keyed on the export id, not the event id: an export is built once, and a
    // redelivered job must not produce a second notification about the same
    // artifact. (The moderation subscriber keys on eventId for the opposite
    // reason — a blog can genuinely be hidden twice.)
    dedupeKey: `export-ready:${exportId}`,
  });
}

export function registerExportNotificationSubscriber(): void {
  eventBus.on(EVENTS.DATA_EXPORT_READY, onDataExportReady);
}
