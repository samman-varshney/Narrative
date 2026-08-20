import { eventBus, EVENTS, type DomainEventMeta } from '../../../core/events/eventBus';
import { notificationOrchestrator } from '../notification.orchestrator';

/**
 * Moderation outcomes → notifications for the person they happened to.
 *
 * ── Why this lives here ─────────────────────────────────────────────────────
 * The Moderation module never sends a notification. It emits a fact; this
 * subscriber turns that fact into copy, exactly as the follow, blog and comment
 * subscribers already do. That keeps notification policy — preferences,
 * channels, deduplication, delivery — in the module that owns it, and it means a
 * suspension applied by some future admin tool notifies the user without that
 * tool knowing notifications exist.
 *
 * ── The actor is deliberately not named ─────────────────────────────────────
 * Every dispatch here passes `actorId: null`, so these are SYSTEM notifications
 * from the platform rather than from a person. Telling an author which moderator
 * hid their post hands the angriest fraction of a user base a name to go after,
 * and moderation staff are already the most harassment-exposed people on any
 * platform. The moderator IS recorded — in the audit log, where an
 * administrator reviewing decisions can see it and the affected user cannot.
 *
 * ── Why SYSTEM and not a new NotificationType ───────────────────────────────
 * `SYSTEM` already exists, already defaults to reachable in the preference
 * matrix (`{ inApp: true, email: true }`), and already has an email template.
 * Adding MODERATION would mean a schema enum change, a template, a preference
 * default — and would let someone mute the message telling them their account
 * has been suspended. Account and safety matters are the case SYSTEM was for.
 *
 * ── Dedupe keys carry the event id ──────────────────────────────────────────
 * `eventId` is minted once per emission and is stable across retries, so a
 * redelivered job produces no second notification while a genuine
 * hide → restore → hide sequence produces three. A key built from the target id
 * alone would silently swallow the second hide.
 */

interface ContentModerationPayload {
  targetType?: 'BLOG' | 'COMMENT';
  targetId?: string;
  ownerId?: string;
  action?: 'HIDDEN' | 'DELETED';
  reason?: string | null;
  title?: string | null;
  /** Set on CONTENT_RESTORED: true when the restore undid a REMOVAL. */
  revived?: boolean;
}

interface UserStatusPayload {
  userId?: string;
  reason?: string | null;
}

/** Appends a moderator's rationale when there is one. */
const withReason = (body: string, reason?: string | null): string =>
  reason ? `${body} Reason given: ${reason}` : body;

export async function onContentModerated(
  payload: ContentModerationPayload,
  meta: DomainEventMeta
): Promise<void> {
  const { targetType, targetId, ownerId, action, reason } = payload;
  if (!targetType || !targetId || !ownerId) return;

  const noun = targetType === 'BLOG' ? 'post' : 'comment';
  const removed = action === 'DELETED';

  const subject = removed
    ? `Your ${noun} was removed`
    : `Your ${noun} was hidden by moderation`;

  const body = removed
    ? `Your ${noun} has been removed for breaching the community guidelines.`
    : `Your ${noun} has been hidden from public view while it is reviewed against the community guidelines.`;

  await notificationOrchestrator.dispatch({
    recipientId: ownerId,
    actorId: null,
    type: 'SYSTEM',
    entityType: targetType,
    entityId: targetId,
    metadata: {
      subject,
      body: withReason(body, reason),
      moderationAction: action ?? 'HIDDEN',
      targetType,
    },
    dedupeKey: `MODERATION:${action ?? 'HIDDEN'}:${targetId}:${meta.eventId}`,
  });
}

export async function onContentRestored(
  payload: ContentModerationPayload,
  meta: DomainEventMeta
): Promise<void> {
  const { targetType, targetId, ownerId, revived } = payload;
  if (!targetType || !targetId || !ownerId) return;

  const noun = targetType === 'BLOG' ? 'post' : 'comment';

  // A revived BLOG comes back as a draft — its pre-removal status is recorded
  // nowhere, and republishing on the author's behalf is not moderation's call.
  // Telling them it is "publicly visible again" would send them looking for a
  // post that is not there. A revived comment has no draft state to return to.
  const asDraft = targetType === 'BLOG' && revived === true;

  await notificationOrchestrator.dispatch({
    recipientId: ownerId,
    actorId: null,
    type: 'SYSTEM',
    entityType: targetType,
    entityId: targetId,
    metadata: {
      subject: `Your ${noun} has been restored`,
      body: asDraft
        ? 'Your post has been restored as a draft. Publish it again whenever you are ready.'
        : `Your ${noun} is publicly visible again. Thank you for your patience.`,
      moderationAction: 'RESTORED',
      targetType,
    },
    dedupeKey: `MODERATION:RESTORED:${targetId}:${meta.eventId}`,
  });
}

export async function onUserSuspended(
  payload: UserStatusPayload,
  meta: DomainEventMeta
): Promise<void> {
  const { userId, reason } = payload;
  if (!userId) return;

  await notificationOrchestrator.dispatch({
    recipientId: userId,
    actorId: null,
    type: 'SYSTEM',
    entityType: 'USER',
    entityId: userId,
    metadata: {
      subject: 'Your account has been suspended',
      body: withReason(
        'Your account has been suspended and you can no longer publish, comment or interact on Narrative.',
        reason
      ),
      moderationAction: 'SUSPENDED',
    },
    dedupeKey: `MODERATION:SUSPENDED:${userId}:${meta.eventId}`,
  });
}

export async function onUserUnsuspended(
  payload: UserStatusPayload,
  meta: DomainEventMeta
): Promise<void> {
  const { userId } = payload;
  if (!userId) return;

  await notificationOrchestrator.dispatch({
    recipientId: userId,
    actorId: null,
    type: 'SYSTEM',
    entityType: 'USER',
    entityId: userId,
    metadata: {
      subject: 'Your account has been restored',
      body: 'Your suspension has been lifted. You can sign in and use Narrative again.',
      moderationAction: 'UNSUSPENDED',
    },
    dedupeKey: `MODERATION:UNSUSPENDED:${userId}:${meta.eventId}`,
  });
}

export function registerModerationNotificationSubscriber(): void {
  eventBus.on(EVENTS.CONTENT_MODERATED, onContentModerated);
  eventBus.on(EVENTS.CONTENT_RESTORED, onContentRestored);
  eventBus.on(EVENTS.USER_SUSPENDED, onUserSuspended);
  eventBus.on(EVENTS.USER_UNSUSPENDED, onUserUnsuspended);
}
