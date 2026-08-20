import { eventBus, EVENTS, type DomainEventMeta } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { analyticsIngestionService } from '../ingestion/RedisAnalyticsIngestionService';
import type { AnalyticsEventType } from '../analytics.types';

/**
 * Engagement domain events → analytics events.
 *
 * Covers the two engagement signals Narrative actually has: bookmarks and
 * comments.
 *
 * ── Why there is no BLOG_LIKED here ────────────────────────────────────────
 * There is a `Like` table in the Prisma schema and a `LIKE` value in the
 * NotificationType enum, but no Like module: nothing creates a like, nothing
 * removes one, and no event is emitted. Wiring a `BLOG_LIKED` subscriber to a
 * source that does not exist would add a column, a DTO field and an API
 * contract that permanently read zero — worse than absent, because a dashboard
 * showing "0 likes" reads as "nobody liked this" rather than "this platform has
 * no likes yet".
 *
 * When the Like module lands, this becomes: one event name, one handler below,
 * one column on `BlogAnalyticsDaily`, one DTO field. See ANALYTICS_MODULE.md
 * § "Deliberate scope exclusion: likes".
 *
 * ── Why bookmarks need no author on the payload ────────────────────────────
 * `BLOG_BOOKMARKED` is `{ blogId, userId }` — the Bookmark module has no reason
 * to load a blog on its write path, and making it do so to satisfy analytics
 * would put a query on a user-facing request in order to serve a dashboard. The
 * ingestion service resolves the author from its own cache instead, off the
 * request path entirely.
 */

interface BookmarkPayload {
  blogId?: string;
  userId?: string;
}

interface CommentCreatedPayload {
  blogId?: string;
  /** The COMMENT's author — the person engaging. */
  authorId?: string;
  /** The BLOG's author — whose dashboard this rolls up to. */
  blogAuthorId?: string;
}

/** Shared shape for the two bookmark events, which differ only in direction. */
function bookmarkHandler(eventType: AnalyticsEventType) {
  return async (payload: BookmarkPayload, meta: DomainEventMeta): Promise<void> => {
    if (!payload?.blogId) return;

    await analyticsIngestionService.recordEvent({
      eventId: meta.eventId,
      eventType,
      occurredAt: new Date(meta.emittedAt),
      entityType: 'BLOG',
      entityId: payload.blogId,
      // No ownerId: the ingestion service resolves it. See the module doc.
      ...(payload.userId && { userId: payload.userId }),
    });
  };
}

export const onBlogBookmarked = bookmarkHandler('BLOG_BOOKMARKED');
export const onBlogUnbookmarked = bookmarkHandler('BLOG_UNBOOKMARKED');

/**
 * COMMENT_CREATED → a comment on the blog's engagement.
 *
 * Only top-level comments and replies alike count; the Comment module emits
 * COMMENT_CREATED for every new comment (and COMMENT_REPLIED additionally for
 * replies), so subscribing to CREATED alone counts each comment exactly once.
 * Subscribing to both would double-count every reply.
 *
 * `blogAuthorId` rides along on the payload already — the Notification module
 * needed it for the same reason — so this needs no lookup at all.
 */
export async function onCommentCreated(
  payload: CommentCreatedPayload,
  meta: DomainEventMeta
): Promise<void> {
  if (!payload?.blogId) return;

  await analyticsIngestionService.recordEvent({
    eventId: meta.eventId,
    eventType: 'BLOG_COMMENTED',
    occurredAt: new Date(meta.emittedAt),
    entityType: 'BLOG',
    entityId: payload.blogId,
    ...(payload.blogAuthorId && { ownerId: payload.blogAuthorId }),
    // The commenter, so the ingestion service can drop an author's replies on
    // their own post — participation, not audience engagement.
    ...(payload.authorId && { userId: payload.authorId }),
  });
}

export function registerEngagementAnalyticsSubscriber(): void {
  eventBus.on(EVENTS.BLOG_BOOKMARKED, onBlogBookmarked);
  eventBus.on(EVENTS.BLOG_UNBOOKMARKED, onBlogUnbookmarked);
  eventBus.on(EVENTS.COMMENT_CREATED, onCommentCreated);

  logger.debug('Analytics engagement subscriber registered');
}
