import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { FEED_CACHE_SCOPES } from '../feed.cache';
import { feedService } from '../feed.service';

/**
 * Cache invalidation for the Feed module.
 *
 * This is the module's ONLY inbound coupling to the rest of the platform, and it
 * is one-directional: Feed listens and never asks a sibling whether something
 * changed. No new events were introduced — every subscription below is to an
 * event the Blog, User or Follow module was already emitting — which is what
 * keeps Feed a leaf in the dependency graph. Extracting it into its own service
 * later means re-pointing these subscriptions at a broker and nothing else.
 *
 * ── Feed processing is never on the write path ──────────────────────────────
 * These handlers run in the domain-events worker, after the user's request has
 * already returned, and every one of them is best-effort. Publishing a blog
 * cannot fail, slow down, or roll back because a cache generation could not be
 * bumped — the consequence of a failure here is a stale entry for at most its
 * TTL, which is what the TTL is for.
 *
 * ── What each event invalidates ─────────────────────────────────────────────
 * Blog lifecycle events move a post into or out of the discoverable set, or
 * change what a card renders, so they invalidate all three shared feeds. They
 * are deliberately treated as one class: a published post changes Latest
 * obviously, Explore because it is a fresh candidate, and Trending because the
 * candidate re-check would otherwise keep serving a withdrawn post until its
 * snapshot expired.
 *
 * User events matter for a subtler reason: a feed card EMBEDS its author's
 * username, display name, avatar and verified badge, so a profile edit makes
 * cached BLOG pages stale, not just user-shaped ones. A deleted account is
 * stronger still — every one of their posts must leave every feed.
 *
 * Moderation events are the newest members of that list, and they arrived
 * exactly as this comment predicted they would: `USER_SUSPENDED` is emitted by
 * the User module (which owns account status) and `CONTENT_MODERATED` by the
 * module that owns the content, so Feed subscribes to a fact and still has no
 * dependency on the Moderation module.
 *
 * They matter because eligibility alone is not enough. `u."status" = 'ACTIVE'`
 * and `b."isHidden" = false` sit in the query predicate, so a suspended author
 * or a hidden post leaves every feed on the next uncached read — but a cached
 * page written a moment earlier would go on serving it for the rest of its TTL.
 * For an ordinary staleness that is fine; for content a moderator just removed
 * it is not, which is the whole reason these three lines exist.
 *
 * Follow events are the only PRECISE invalidation here: we know exactly whose
 * feed changed, so one key is dropped rather than a generation bumped. Without
 * it a user would follow someone and watch their feed not change — the one kind
 * of staleness a reader reads as a bug rather than as caching.
 *
 * ── What is deliberately NOT invalidated ────────────────────────────────────
 * A newly published blog does not drop the cached following feed of every
 * follower. That would be a fan-out over an unbounded set on the platform's
 * hottest write, to save at most 30 seconds of staleness on a feed nobody is
 * looking at in that instant. The TTL covers it. If following feeds are ever
 * materialized (see FEED_MODULE.md § Future evolution), that fan-out becomes the
 * write path itself and this note is where it starts.
 */

/** Blog lifecycle: changes what is discoverable, or what a card shows. */
const BLOG_EVENTS = [
  EVENTS.BLOG_PUBLISHED,
  EVENTS.BLOG_UPDATED,
  EVENTS.BLOG_UNPUBLISHED,
  EVENTS.BLOG_ARCHIVED,
  EVENTS.BLOG_RESTORED,
  EVENTS.BLOG_DELETED,
  EVENTS.BLOG_COVER_UPDATED, // the cover URL is part of every card
] as const;

/** User events: change embedded author fields, or whether an author is visible. */
const USER_EVENTS = [
  EVENTS.USER_PROFILE_UPDATED,
  EVENTS.USER_AVATAR_UPDATED,
  EVENTS.USER_DELETED, // a deleted account's posts must leave every feed
  EVENTS.USER_SUSPENDED, // ...and so must a suspended one's, immediately
  EVENTS.USER_UNSUSPENDED, // reinstated: their posts become discoverable again
  EVENTS.USER_DEACTIVATED, // self-service exit — same predicate, same staleness
  EVENTS.USER_REACTIVATED, // ...and back on the next login
] as const;

/**
 * Moderation outcomes: content enters or leaves the discoverable set the moment
 * a moderator acts, so the cached pages that still carry it must go now rather
 * than at TTL.
 */
const MODERATION_EVENTS = [
  EVENTS.CONTENT_MODERATED,
  EVENTS.CONTENT_RESTORED,
] as const;

let registered = false;

/**
 * Registers every feed cache-invalidation subscriber.
 *
 * MUST be called from `server.ts`, never from `app.ts`: registering at app
 * import time would make every test that touches `app` start issuing Redis
 * writes as a side effect of unrelated service calls. Same rule, and same
 * reason, as the Notification, Search and Analytics registrations.
 *
 * Idempotent — a second call is ignored, so a stray import cannot double-bump
 * every generation.
 */
export function registerFeedSubscribers(): void {
  if (registered) return;
  registered = true;

  for (const event of [...BLOG_EVENTS, ...USER_EVENTS, ...MODERATION_EVENTS]) {
    eventBus.on(event, () => invalidateShared(event));
  }

  // Payload: { followerId, followingId }. The FOLLOWER's feed is the one whose
  // contents changed; the followed user's is untouched.
  for (const event of [EVENTS.USER_FOLLOWED, EVENTS.USER_UNFOLLOWED]) {
    eventBus.on(event, (payload: { followerId?: string }) =>
      invalidateFollowing(payload?.followerId, event)
    );
  }

  logger.info('Feed cache subscribers registered');
}

/**
 * A failed invalidation must never fail the job that carried the event — the
 * consequence is a stale entry for at most its TTL.
 */
async function invalidateShared(event: string): Promise<void> {
  try {
    await feedService.invalidateSharedFeeds(FEED_CACHE_SCOPES);
  } catch (err) {
    logger.warn({ err, event }, 'feed: shared cache invalidation failed');
  }
}

async function invalidateFollowing(viewerId: string | undefined, event: string): Promise<void> {
  if (!viewerId) {
    logger.warn({ event }, 'feed: follow event without a followerId — cache not invalidated');
    return;
  }
  try {
    await feedService.invalidateFollowingFeed(viewerId);
  } catch (err) {
    logger.warn({ err, event }, 'feed: following cache invalidation failed');
  }
}

/** Test seam. */
export function resetFeedSubscriberRegistration(): void {
  registered = false;
}
