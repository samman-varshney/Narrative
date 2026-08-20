import { eventBus, EVENTS, type DomainEventMeta } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { analyticsIngestionService } from '../ingestion/RedisAnalyticsIngestionService';
import type { AnalyticsEventType } from '../analytics.types';

/**
 * Follow domain events → audience-growth analytics.
 *
 * ── Whose row this is ───────────────────────────────────────────────────────
 * `USER_FOLLOWED` is `{ followerId, followingId }`, and the metric belongs to
 * `followingId` — the person GAINING a follower. Getting this backwards would
 * silently populate every author's chart with their own following activity, and
 * the numbers would look entirely plausible.
 *
 * ── Why gains and losses are separate counters ─────────────────────────────
 * The Follow module emits only on a real state change (both `followUser` and
 * `unfollowUser` guard on whether the row actually changed), so these events are
 * already free of no-op churn. Storing gained and lost separately rather than a
 * single net delta preserves the distinction between a quiet day and a day that
 * gained fifty followers and lost fifty — which is the day an author most needs
 * to see.
 */

interface FollowPayload {
  followerId?: string;
  followingId?: string;
}

/** Shared shape for follow/unfollow, which differ only in which counter moves. */
function followHandler(eventType: AnalyticsEventType) {
  return async (payload: FollowPayload, meta: DomainEventMeta): Promise<void> => {
    if (!payload?.followingId) return;

    await analyticsIngestionService.recordEvent({
      eventId: meta.eventId,
      eventType,
      occurredAt: new Date(meta.emittedAt),
      // The FOLLOWED user — see the module doc.
      entityType: 'USER',
      entityId: payload.followingId,
      ownerId: payload.followingId,
      ...(payload.followerId && { userId: payload.followerId }),
    });
  };
}

export const onUserFollowed = followHandler('USER_FOLLOWED');
export const onUserUnfollowed = followHandler('USER_UNFOLLOWED');

export function registerUserAnalyticsSubscriber(): void {
  eventBus.on(EVENTS.USER_FOLLOWED, onUserFollowed);
  eventBus.on(EVENTS.USER_UNFOLLOWED, onUserUnfollowed);

  logger.debug('Analytics user subscriber registered');
}
