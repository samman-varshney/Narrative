import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { notificationOrchestrator } from '../notification.orchestrator';

interface UserFollowedPayload {
  followerId: string;
  followingId: string;
}

/**
 * USER_FOLLOWED → FOLLOW notification for the followed user.
 *
 * The upstream emit is already guarded by `if (created)`, so a repeat follow
 * emits nothing and cannot double-notify. The dedupeKey covers the remaining
 * case: a retried dispatch job.
 */
export async function onUserFollowed(payload: UserFollowedPayload): Promise<void> {
  const { followerId, followingId } = payload;
  if (!followerId || !followingId) return;

  await notificationOrchestrator.dispatch({
    recipientId: followingId,
    actorId: followerId,
    type: 'FOLLOW',
    entityType: 'USER',
    entityId: followerId,
    // One notification per follow edge. A re-follow after unfollowing reuses
    // this key, so it will not notify twice — deliberate: it is the same fact.
    dedupeKey: `FOLLOW:${followerId}:${followingId}`,
  });
}

export function registerFollowSubscriber(): void {
  eventBus.on(EVENTS.USER_FOLLOWED, onUserFollowed);
}
