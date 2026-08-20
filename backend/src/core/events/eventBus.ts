import { randomUUID } from 'crypto';
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

/**
 * Delivery metadata handed to every subscriber alongside the payload.
 *
 * `eventId` is minted once, at emit time, and travels inside the queue job — so
 * it is IDENTICAL across every retry of that job, and different for two
 * genuinely separate emissions of the same payload. That is exactly the
 * property an at-least-once consumer needs to deduplicate: hashing the payload
 * cannot distinguish "the same event redelivered" from "the user did that twice"
 * (bookmark → unbookmark → bookmark produces byte-identical payloads).
 *
 * Analytics is the first consumer that needs it. Existing subscribers declare a
 * single parameter and are unaffected — a narrower function is assignable to a
 * wider signature.
 */
export interface DomainEventMeta {
  /** Stable across retries, unique per emission. */
  eventId: string;
  event: string;
  emittedAt: string;
}

export type DomainEventHandler = (
  payload: any,
  meta: DomainEventMeta
) => void | Promise<void>;

const handlers = new Map<string, DomainEventHandler[]>();

/**
 * In-flight inline dispatches, tracked ONLY under NODE_ENV=test.
 *
 * `emit` is fire-and-forget by contract, so in tests the inline dispatch it
 * starts is still running when the emitting request returns. A test that emits
 * and then immediately inspects what a subscriber wrote is therefore racing it —
 * and loses, intermittently, in a way that looks like a lost event rather than a
 * test-harness problem.
 *
 * `settled()` below lets a test wait for exactly those dispatches. Empty and
 * unused outside tests, where `emit` enqueues instead of dispatching.
 */
const pendingDispatches = new Set<Promise<void>>();

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
    const meta: DomainEventMeta = {
      eventId: randomUUID(),
      event,
      emittedAt: new Date().toISOString(),
    };

    // In tests the queue is not drained and Redis state would leak between
    // suites; handlers are invoked inline instead so assertions stay simple.
    if (env.NODE_ENV === 'test') {
      const dispatched = this.dispatch(event, payload, meta);
      pendingDispatches.add(dispatched);
      void dispatched.finally(() => pendingDispatches.delete(dispatched));
      return true;
    }

    domainEventsQueue
      .add(event, { event, payload, eventId: meta.eventId, emittedAt: meta.emittedAt })
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
  async dispatch(event: string, payload: any, meta?: DomainEventMeta): Promise<void> {
    const list = handlers.get(event);
    if (!list?.length) return;

    // A caller that supplies no meta gets a fresh id. Only reachable from a
    // direct `dispatch` call in a test — the two real entry points (emit, and
    // the worker) both carry one through.
    const delivery: DomainEventMeta = meta ?? {
      eventId: randomUUID(),
      event,
      emittedAt: new Date().toISOString(),
    };

    await Promise.all(
      list.map((handler) =>
        Promise.resolve()
          .then(() => handler(payload, delivery))
          .catch((err) =>
            logger.error({ err, event, payload }, 'Domain event handler failed')
          )
      )
    );
  }

  /**
   * Test seam: resolves once every inline dispatch started by `emit` has
   * settled.
   *
   * Only meaningful under NODE_ENV=test, where `emit` runs handlers inline. Lets
   * an integration test assert on what a subscriber wrote without a sleep — the
   * alternative being a timeout long enough to be slow and short enough to be
   * flaky. `allSettled`, because a failing subscriber is isolated by `dispatch`
   * and must not make this reject.
   *
   * Loops until the set is empty: a handler may emit a further event, and
   * awaiting one snapshot would miss the dispatch that snapshot started.
   */
  async settled(): Promise<void> {
    while (pendingDispatches.size > 0) {
      await Promise.allSettled([...pendingDispatches]);
    }
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

  // Self-service account lifecycle — payloads:
  //  USER_DEACTIVATED { userId }
  //  USER_REACTIVATED { userId }
  //
  // Deliberately NOT reusing USER_SUSPENDED/USER_UNSUSPENDED even though the
  // enforcement is identical (revoke sessions, prime the status cache). A
  // subscriber that cannot tell "the user left" from "a moderator acted" will
  // eventually get it wrong where it matters — Notification must not email
  // someone a suspension notice for a button they pressed themselves, and the
  // moderation audit log must not gain entries with no actor.
  //
  // Consumers today: Auth (revokes sessions, primes the account status cache),
  // Feed and Search (drop the cached pages that still carry the account).
  //
  // No blog row is ever touched: the discovery predicate is already
  // `u."status" = 'ACTIVE'`, so a deactivated author's whole catalogue leaves
  // every surface on the next uncached read, and comes back on reactivation for
  // the same reason. The cache invalidation is what makes that take effect NOW
  // rather than at TTL — the same gap USER_SUSPENDED closes.
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  USER_REACTIVATED: 'USER_REACTIVATED',

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
  //  BLOG_VIEWED        { blogId, authorId, slug, userId?, anonymousId? }
  //
  // BLOG_VIEWED is emitted by `blogService.getBySlug` — the platform's only
  // public full-read path — and ONLY for a PUBLISHED blog the viewer was
  // actually allowed to see. It is the one blog event that fires on a READ, so
  // it is by far the highest-volume event on the bus; every subscriber must
  // treat it as such. Exactly one of `userId` / `anonymousId` is normally
  // present (both are absent when an anonymous client sends no identifier, in
  // which case the view can be counted but not deduplicated).
  BLOG_CREATED: 'BLOG_CREATED',
  BLOG_UPDATED: 'BLOG_UPDATED',
  BLOG_PUBLISHED: 'BLOG_PUBLISHED',
  BLOG_UNPUBLISHED: 'BLOG_UNPUBLISHED',
  BLOG_ARCHIVED: 'BLOG_ARCHIVED',
  BLOG_RESTORED: 'BLOG_RESTORED',
  BLOG_DELETED: 'BLOG_DELETED',
  BLOG_COVER_UPDATED: 'BLOG_COVER_UPDATED',
  BLOG_VIEWED: 'BLOG_VIEWED',

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

  // Moderation — reports. Emitted by the Moderation module, which owns reports.
  //  REPORT_CREATED   { reportId, targetType, targetId, targetOwnerId, reporterId, reason, source }
  //  REPORT_ASSIGNED  { reportId, moderatorId, targetType, targetId }
  //  REPORT_RESOLVED  { reportId, moderatorId, targetType, targetId, resolution }
  //  REPORT_DISMISSED { reportId, moderatorId, targetType, targetId }
  //
  // A report is a request for review, never a decision, so NOTHING subscribes to
  // these to change what is visible. They exist for operational awareness —
  // queue depth, moderator throughput — and as the seam a future triage
  // automation would hook into.
  REPORT_CREATED: 'REPORT_CREATED',
  REPORT_ASSIGNED: 'REPORT_ASSIGNED',
  REPORT_RESOLVED: 'REPORT_RESOLVED',
  REPORT_DISMISSED: 'REPORT_DISMISSED',

  // Moderation — outcomes. Emitted by the module that OWNS the thing which
  // changed (Blog, Comment, User), not by Moderation: the fact is "this blog is
  // now hidden", and the only code that can truthfully state it is the code that
  // hid it. Moderation orchestrates and audits; it does not narrate.
  //
  //  CONTENT_MODERATED { targetType: 'BLOG' | 'COMMENT', targetId, ownerId, actorId, action, reason? }
  //  CONTENT_RESTORED  { targetType: 'BLOG' | 'COMMENT', targetId, ownerId, actorId, revived }
  //
  // `revived` distinguishes the two things a restore can undo: false lifts a
  // hide and the content is public again; true brings back a REMOVAL, and a
  // revived blog returns as a DRAFT — so the notification must not tell its
  // author it is visible when it is not.
  //  USER_SUSPENDED    { userId, actorId, reason? }
  //  USER_UNSUSPENDED  { userId, actorId }
  //
  // Consumers today: Notification (tells the author), Feed and Search (drop the
  // content from their caches), Auth (revokes sessions and primes the account
  // status cache on suspension). None of them depends on the Moderation module —
  // they subscribe to a fact, exactly as they already do for BLOG_PUBLISHED.
  CONTENT_MODERATED: 'CONTENT_MODERATED',
  CONTENT_RESTORED: 'CONTENT_RESTORED',
  USER_SUSPENDED: 'USER_SUSPENDED',
  USER_UNSUSPENDED: 'USER_UNSUSPENDED',
};
