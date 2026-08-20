import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { notificationOrchestrator } from '../notification.orchestrator';

interface CommentCreatedPayload {
  commentId: string;
  blogId: string;
  authorId: string;
  blogAuthorId: string;
  parentId: string | null;
}

interface CommentRepliedPayload {
  commentId: string;
  blogId: string;
  authorId: string;
  parentId: string;
  parentAuthorId: string;
  /** The blog owner. May be the replier or the parent author — see below. */
  blogAuthorId: string;
}

/**
 * COMMENT_CREATED → COMMENT notification for the blog owner.
 *
 * Replies are skipped here. A reply emits BOTH COMMENT_CREATED and
 * COMMENT_REPLIED, so handling both unconditionally would notify twice for one
 * action. COMMENT_REPLIED is the more specific event and owns that case.
 *
 * Self-comments are dropped by the orchestrator (actor === recipient).
 */
export async function onCommentCreated(payload: CommentCreatedPayload): Promise<void> {
  const { commentId, blogId, authorId, blogAuthorId, parentId } = payload;
  if (!commentId || !blogAuthorId) return;

  if (parentId) return; // COMMENT_REPLIED handles replies

  await notificationOrchestrator.dispatch({
    recipientId: blogAuthorId,
    actorId: authorId,
    type: 'COMMENT',
    entityType: 'COMMENT',
    entityId: commentId,
    metadata: { blogId },
    dedupeKey: `COMMENT:${commentId}`,
  });
}

/**
 * COMMENT_REPLIED → REPLY for the parent comment's author, and COMMENT for the
 * blog owner.
 *
 * `onCommentCreated` returns early for ANY `parentId`, so this handler is the
 * ONLY path by which a reply can reach the blog owner. Without the second
 * dispatch, someone replying to a third party's comment on your post notifies
 * you not at all.
 *
 * The two dispatches go to different people, so this is not double-notifying —
 * but the three roles (replier, parent author, blog owner) can overlap in every
 * combination, which is what `shouldNotifyBlogOwner` below decides.
 */
export async function onCommentReplied(payload: CommentRepliedPayload): Promise<void> {
  const { commentId, blogId, authorId, parentAuthorId, blogAuthorId } = payload;
  if (!commentId || !parentAuthorId) return;

  await notificationOrchestrator.dispatch({
    recipientId: parentAuthorId,
    actorId: authorId,
    type: 'REPLY',
    entityType: 'COMMENT',
    entityId: commentId,
    metadata: { blogId },
    dedupeKey: `REPLY:${commentId}`,
  });

  if (!blogAuthorId || !shouldNotifyBlogOwner({ authorId, parentAuthorId, blogAuthorId })) {
    return;
  }

  await notificationOrchestrator.dispatch({
    recipientId: blogAuthorId,
    actorId: authorId,
    type: 'COMMENT',
    entityType: 'COMMENT',
    entityId: commentId,
    metadata: { blogId },
    // Distinct from the REPLY key above: the same comment produces two
    // notifications for two different people, so one shared key would let
    // whichever dispatch ran second silently no-op.
    dedupeKey: `COMMENT:${commentId}`,
  });
}

/**
 * Decides whether the blog owner gets a COMMENT notification for a reply, given
 * the three people involved. Returning false means they get nothing.
 */
function shouldNotifyBlogOwner(roles: {
  /** Who wrote the reply. */
  authorId: string;
  /** Who wrote the comment being replied to — already getting a REPLY. */
  parentAuthorId: string;
  /** Who owns the blog. */
  blogAuthorId: string;
}): boolean {
  // The owner wrote the reply themselves. The orchestrator drops this anyway
  // (actor === recipient), but returning here skips a preference read and an
  // insert attempt on a path that runs for every single reply.
  if (roles.blogAuthorId === roles.authorId) return false;

  // The owner IS the person being replied to, so they are already getting the
  // REPLY above. Nothing downstream would collapse the pair — the two
  // dispatches carry different dedupeKeys by design — so it has to stop here.
  if (roles.blogAuthorId === roles.parentAuthorId) return false;

  return true;
}

export function registerCommentSubscriber(): void {
  eventBus.on(EVENTS.COMMENT_CREATED, onCommentCreated);
  eventBus.on(EVENTS.COMMENT_REPLIED, onCommentReplied);
}
