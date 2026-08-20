import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { rssService } from '../rss.service';

/**
 * Cache invalidation for the RSS module.
 *
 * This is the module's ONLY inbound coupling to the rest of the platform, and it
 * is one-directional: RSS listens, and never asks a sibling whether something
 * changed. No new events were introduced — every subscription below is to an
 * event the Blog, User or Moderation flow was already emitting — which is what
 * keeps RSS a leaf in the dependency graph. RSS is an event CONSUMER and never a
 * producer; nothing in this module emits.
 *
 * ── Invalidation is never on the write path ─────────────────────────────────
 * These handlers run in the domain-events worker, after the user's request has
 * already returned, and every one of them is best-effort. Publishing a post
 * cannot fail, slow down, or roll back because a generation could not be
 * bumped — the consequence of a failure here is a stale feed for at most its
 * TTL, which is what the TTL is for.
 *
 * ── Three tiers, chosen by blast radius ─────────────────────────────────────
 *
 *   PER-BLOG    The frequent case, and the precise one. A post entering or
 *               leaving the eligible set — or changing what its item says —
 *               affects exactly four kinds of feed: global, its author's, and
 *               one per tag and category it carries. `invalidateForBlog` looks
 *               those up and bumps only them. Publishing a post about
 *               `postgres` leaves every other author, tag and category alone,
 *               which is the brief's "publishing a blog should not blindly
 *               invalidate every author/category/tag feed".
 *
 *   PER-AUTHOR  A profile edit changes what an author's items SAY without
 *               changing which posts exist. Their name is embedded in every
 *               item they wrote, including items sitting in tag and category
 *               feeds — and those are deliberately left to expire. A display
 *               name up to five minutes stale in a syndication document is not
 *               worth an unbounded fan-out over every term an author has ever
 *               used; content that must LEAVE a feed is a different question,
 *               answered below.
 *
 *   EVERYTHING  Account status and moderation outcomes. Each removes (or
 *               restores) an entire catalogue at once, and enumerating the tags
 *               and categories that catalogue touches is an unbounded query on
 *               a path that must be immediate. One `INCR` on the root
 *               generation makes every cached feed on the platform unreachable,
 *               and it costs the same whatever the cache holds.
 *
 * Eligibility alone is not enough to justify skipping any of this. The
 * predicate lives in the query, so a suspended author or a hidden post leaves
 * every feed on the next UNCACHED read — but a document written a moment
 * earlier would go on being served, and re-served to conditional requests as a
 * 304, for the rest of its TTL. For an ordinary staleness that is fine; for
 * content a moderator has just removed it is not, which is the whole reason the
 * root tier exists.
 *
 * ── Idempotence ────────────────────────────────────────────────────────────
 * Every handler is idempotent in the only sense that matters here: bumping a
 * generation twice for the same event is indistinguishable from bumping it
 * once, because what invalidates a key is the number CHANGING, not its value.
 * The domain-events queue is at-least-once, so a redelivered job simply
 * advances a counter again. That is why none of these handlers reads
 * `meta.eventId` to deduplicate — there is nothing to deduplicate.
 */

/**
 * Blog lifecycle: a post enters or leaves the syndicatable set, or the text of
 * its item changes.
 *
 * All carry `{ blogId, authorId }`. `BLOG_CREATED` is absent on purpose — a new
 * post is a DRAFT, which no feed can contain, so invalidating on it would drop
 * every cache entry on the platform's most frequent content write for no
 * possible change in output. `BLOG_PUBLISHED` is the event that matters.
 */
const BLOG_EVENTS = [
  EVENTS.BLOG_PUBLISHED,
  EVENTS.BLOG_UPDATED,
  EVENTS.BLOG_UNPUBLISHED,
  EVENTS.BLOG_ARCHIVED,
  EVENTS.BLOG_RESTORED,
  EVENTS.BLOG_DELETED,
  EVENTS.BLOG_COVER_UPDATED, // the cover is an item's enclosure
] as const;

/**
 * Author events that change embedded item text but not which posts exist.
 *
 * Carry `{ userId }`. The avatar is included even though a feed never renders
 * one, because the two events are emitted from adjacent paths and a future item
 * field that did use it would otherwise be stale with nothing to notice.
 */
const AUTHOR_EVENTS = [
  EVENTS.USER_PROFILE_UPDATED,
  EVENTS.USER_AVATAR_UPDATED,
] as const;

/**
 * Events that add or remove a whole catalogue.
 *
 * Account status is the User module's fact — RSS subscribes to it and still has
 * no dependency on the Moderation module, exactly as Feed and Search do.
 * `USER_DELETED` and `USER_DEACTIVATED` matter for the same predicate as
 * `USER_SUSPENDED`: `u."status" = 'ACTIVE'` covers all three, so all three need
 * the same immediacy.
 */
const ACCOUNT_EVENTS = [
  EVENTS.USER_SUSPENDED,
  EVENTS.USER_UNSUSPENDED,
  EVENTS.USER_DEACTIVATED,
  EVENTS.USER_REACTIVATED,
  EVENTS.USER_DELETED,
] as const;

/**
 * Moderation outcomes on content.
 *
 * Emitted by the module that OWNS the content — Blog for a blog, Comment for a
 * comment — never by Moderation. Only `BLOG` targets are relevant: comments are
 * not syndicated, so a comment hide invalidates nothing, and the payload is
 * filtered rather than the event catalogue being split to suit one consumer.
 *
 * A blog target takes the root path rather than the per-blog one even though the
 * blog id is right there in the payload. A moderator removing content is the one
 * case where being a few hundred milliseconds slow to a term lookup — or getting
 * a stale answer from it — is not acceptable, and one `INCR` is both faster and
 * unconditionally correct.
 */
const MODERATION_EVENTS = [EVENTS.CONTENT_MODERATED, EVENTS.CONTENT_RESTORED] as const;

let registered = false;

/**
 * Registers every RSS cache-invalidation subscriber.
 *
 * MUST be called from `server.ts`, never from `app.ts`: registering at app
 * import time would make every test that touches `app` start issuing Redis
 * writes as a side effect of unrelated service calls. Same rule, and same
 * reason, as the Notification, Search, Feed, Dashboard and Moderation
 * registrations.
 *
 * Idempotent — a second call is ignored, so a stray import cannot double-
 * register and make one publish bump every generation twice.
 */
export function registerRssSubscribers(): void {
  if (registered) return;
  registered = true;

  for (const event of BLOG_EVENTS) {
    eventBus.on(event, (payload: { blogId?: string; authorId?: string }) =>
      onBlogChanged(event, payload)
    );
  }

  for (const event of AUTHOR_EVENTS) {
    eventBus.on(event, (payload: { userId?: string }) => onAuthorChanged(event, payload));
  }

  for (const event of ACCOUNT_EVENTS) {
    eventBus.on(event, () => onCatalogueChanged(event));
  }

  for (const event of MODERATION_EVENTS) {
    eventBus.on(event, (payload: { targetType?: string }) => {
      if (payload?.targetType !== 'BLOG') return;
      return onCatalogueChanged(event);
    });
  }

  logger.info('RSS cache subscribers registered');
}

/**
 * A failed invalidation must never fail the job that carried the event. Every
 * handler below therefore swallows and logs: the consequence is a stale feed for
 * at most its TTL, which is exactly what the TTL is there to bound.
 */
async function onBlogChanged(
  event: string,
  payload: { blogId?: string; authorId?: string }
): Promise<void> {
  if (!payload?.blogId) {
    // A blog event with no id cannot be resolved to the feeds it belongs to.
    // Logged rather than escalated to a root bump: an unknown payload shape is a
    // bug to fix, not a reason to flush the platform's cache on every delivery.
    logger.warn({ event }, 'rss: blog event without a blogId — cache not invalidated');
    return;
  }

  try {
    await rssService.invalidateForBlog(payload.blogId, payload.authorId);
  } catch (err) {
    logger.warn({ err, event }, 'rss: blog cache invalidation failed');
  }
}

async function onAuthorChanged(event: string, payload: { userId?: string }): Promise<void> {
  if (!payload?.userId) {
    logger.warn({ event }, 'rss: author event without a userId — cache not invalidated');
    return;
  }

  try {
    await rssService.invalidateForAuthor(payload.userId);
  } catch (err) {
    logger.warn({ err, event }, 'rss: author cache invalidation failed');
  }
}

async function onCatalogueChanged(event: string): Promise<void> {
  try {
    await rssService.invalidateEverything();
  } catch (err) {
    logger.warn({ err, event }, 'rss: global cache invalidation failed');
  }
}

/** Test seam. */
export function resetRssSubscriberRegistration(): void {
  registered = false;
}
