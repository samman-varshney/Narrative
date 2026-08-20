import { domainEventsQueue } from '../providers/queue';
import { logger } from '../utils/logger';
import { env } from '../config/env';

/**
 * Durable domain event bus.
 *
 * Previously a bare in-process `EventEmitter`: handlers ran synchronously inside
 * the emitting request, a throwing handler propagated into the caller's stack,
 * and nothing survived a process restart. Events are now published to a BullMQ
 * queue and dispatched by a worker, which buys:
 *
 *   - durability — a job survives a crash and is retried with backoff
 *   - isolation  — a failing subscriber cannot break the HTTP request
 *   - scale      — dispatch capacity is independent of the web process
 *
 * `emit(event, payload)` keeps its original fire-and-forget signature, so all
 * existing call sites and their tests are unchanged.
 *
 * Residual gap (documented, not solved): a crash between the database commit and
 * the enqueue completing loses that event. Closing it fully requires a
 * transactional outbox — writing the event in the same transaction as the
 * business change. That is the natural next step if lost events ever matter.
 */

export type DomainEventHandler = (payload: any) => void | Promise<void>;

const handlers = new Map<string, DomainEventHandler[]>();

/**
 * Plain class, NOT an EventEmitter subclass. `on` writes to this module's own
 * handler map, so inheriting EventEmitter would leave `once`, `off`,
 * `removeListener` and `listenerCount` silently operating on an unused internal
 * registry — anyone reaching for the standard API would register a handler that
 * never fires.
 */
class EventBus {
  /**
   * Publishes a domain event. Fire-and-forget by design: a queue outage must
   * never fail the user's request, so enqueue errors are logged, not thrown —
   * the same contract `mediaService.enqueueProcessing` already follows.
   */
  emit(event: string, payload?: any): boolean {
    // In tests the queue is not drained and Redis state would leak between
    // suites; handlers are invoked inline instead so assertions stay simple.
    if (env.NODE_ENV === 'test') {
      void this.dispatch(event, payload);
      return true;
    }

    domainEventsQueue
      .add(event, { event, payload, emittedAt: new Date().toISOString() })
      .catch((err) =>
        logger.error({ err, event }, 'Failed to publish domain event — event lost')
      );
    return true;
  }

  /** Registers a handler. Called by module subscribers at bootstrap. */
  on(event: string, handler: DomainEventHandler): this {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return this;
  }

  /**
   * Runs every handler for an event. Each is isolated: one throwing handler must
   * not prevent the others from running, nor fail the job that carries them.
   * Called by the dispatcher worker.
   */
  async dispatch(event: string, payload: any): Promise<void> {
    const list = handlers.get(event);
    if (!list?.length) return;

    await Promise.all(
      list.map((handler) =>
        Promise.resolve()
          .then(() => handler(payload))
          .catch((err) =>
            logger.error({ err, event, payload }, 'Domain event handler failed')
          )
      )
    );
  }

  /** Test seam: drops all registered handlers. */
  clearHandlers(): void {
    handlers.clear();
  }

  handlerCount(event: string): number {
    return handlers.get(event)?.length ?? 0;
  }
}

export const eventBus = new EventBus();

// Strongly typed event names
export const EVENTS = {
  USER_REGISTERED: 'USER_REGISTERED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  EMAIL_VERIFICATION_REQUESTED: 'EMAIL_VERIFICATION_REQUESTED',
  USER_PROFILE_UPDATED: 'USER_PROFILE_UPDATED',
  USER_AVATAR_UPDATED: 'USER_AVATAR_UPDATED',
  USER_SETTINGS_UPDATED: 'USER_SETTINGS_UPDATED',
  USER_DELETED: 'USER_DELETED',

  // Media — payloads:
  //  MEDIA_UPLOADED { mediaId, userId, secureUrl }
  //  MEDIA_REPLACED { mediaId, userId, secureUrl, oldPublicId }
  //  MEDIA_DELETED  { mediaId, userId }
  MEDIA_UPLOADED: 'MEDIA_UPLOADED',
  MEDIA_REPLACED: 'MEDIA_REPLACED',
  MEDIA_DELETED: 'MEDIA_DELETED',

  // Follow — payloads:
  //  USER_FOLLOWED   { followerId, followingId }
  //  USER_UNFOLLOWED { followerId, followingId }
  USER_FOLLOWED: 'USER_FOLLOWED',
  USER_UNFOLLOWED: 'USER_UNFOLLOWED',

  // Blog — payloads:
  //  BLOG_CREATED       { blogId, authorId, slug }
  //  BLOG_UPDATED       { blogId, authorId }
  //  BLOG_PUBLISHED     { blogId, authorId, slug, publishedAt }
  //  BLOG_UNPUBLISHED   { blogId, authorId }
  //  BLOG_ARCHIVED      { blogId, authorId }
  //  BLOG_RESTORED      { blogId, authorId, status }
  //  BLOG_DELETED       { blogId, authorId }
  //  BLOG_COVER_UPDATED { blogId, authorId, coverImage }
  BLOG_CREATED: 'BLOG_CREATED',
  BLOG_UPDATED: 'BLOG_UPDATED',
  BLOG_PUBLISHED: 'BLOG_PUBLISHED',
  BLOG_UNPUBLISHED: 'BLOG_UNPUBLISHED',
  BLOG_ARCHIVED: 'BLOG_ARCHIVED',
  BLOG_RESTORED: 'BLOG_RESTORED',
  BLOG_DELETED: 'BLOG_DELETED',
  BLOG_COVER_UPDATED: 'BLOG_COVER_UPDATED',

  // Taxonomy — payloads:
  //  CATEGORY_CREATED { categoryId, name, slug }
  // Emitted by the Blog module (the owner of the curated category vocabulary).
  // Search subscribes to it so a new category is suggestible immediately rather
  // than after its 5-minute cache TTL lapses.
  CATEGORY_CREATED: 'CATEGORY_CREATED',

  // Comment — payloads:
  //  COMMENT_CREATED  { commentId, blogId, authorId, blogAuthorId, parentId }
  //  COMMENT_REPLIED  { commentId, blogId, authorId, parentId, parentAuthorId, blogAuthorId }
  //  COMMENT_UPDATED  { commentId, blogId, authorId }
  //  COMMENT_DELETED  { commentId, blogId, authorId }
  //  COMMENT_RESTORED { commentId, blogId, authorId }
  //  COMMENT_HIDDEN   { commentId, blogId, authorId }
  COMMENT_CREATED: 'COMMENT_CREATED',
  COMMENT_REPLIED: 'COMMENT_REPLIED',
  COMMENT_UPDATED: 'COMMENT_UPDATED',
  COMMENT_DELETED: 'COMMENT_DELETED',
  COMMENT_RESTORED: 'COMMENT_RESTORED',
  COMMENT_HIDDEN: 'COMMENT_HIDDEN',

  // Bookmark — payloads:
  //  BLOG_BOOKMARKED   { blogId, userId }
  //  BLOG_UNBOOKMARKED { blogId, userId }
  BLOG_BOOKMARKED: 'BLOG_BOOKMARKED',
  BLOG_UNBOOKMARKED: 'BLOG_UNBOOKMARKED',
};
