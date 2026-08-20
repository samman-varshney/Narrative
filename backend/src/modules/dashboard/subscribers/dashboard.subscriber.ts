import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { bumpGeneration } from '../dashboard.cache';

/**
 * Cache invalidation for the Dashboard module.
 *
 * The module's only inbound coupling, and it is one-directional: Dashboard
 * listens, and never asks a sibling whether something changed. No new events
 * were introduced — every subscription below is to an event the Blog, Follow,
 * Bookmark or Comment module was already emitting — which is what keeps
 * Dashboard a leaf in the dependency graph.
 *
 * ── Which user's dashboard is invalidated ───────────────────────────────────
 * Every handler exists to answer one question: whose dashboard would now show a
 * different number? That is not always the actor. A comment invalidates the
 * BLOG AUTHOR's dashboard, not the commenter's. A follow invalidates BOTH — the
 * followed user's follower count and the follower's own following count are on
 * two different dashboards, and missing either is a user watching a number not
 * change after they changed it.
 *
 * ── What is deliberately NOT subscribed ─────────────────────────────────────
 * BLOG_VIEWED. It is by far the highest-volume event on the bus — one per read
 * of every published post — and subscribing would mean a Redis write per page
 * view, permanently, to invalidate a number that has not moved yet: views do
 * not reach the database until the analytics flush. They arrive on the
 * dashboard through the ANALYTICS generation instead, which the flush worker
 * bumps for exactly the authors it wrote. That is the same freshness at a
 * fraction of the cost, and it is why the cache key carries two generations.
 *
 * AUTOSAVE is the one gap, and it is upstream: `blogService.autosave` emits
 * nothing on purpose ("intentionally silent, to avoid downstream churn"), so a
 * draft edited by autosave alone can sit in the wrong position in the drafts
 * panel until that panel's 30-second TTL lapses. Subscribing to a
 * once-every-few-seconds editor event to reorder a five-row panel would be a bad
 * trade, and inventing an event here to get one would be worse.
 *
 * ── Never on the write path ─────────────────────────────────────────────────
 * These handlers run in the domain-events worker, after the user's request has
 * returned, and every one is best-effort. Publishing a post cannot fail, slow
 * down or roll back because a cache generation could not be bumped — the
 * consequence of a failure is a stale panel for at most its TTL, which is what
 * the TTL is for.
 */

/**
 * Events carrying `{ authorId }` — the owner of the affected content.
 *
 * Blog lifecycle changes the counters (`published`, `drafts`, `archived`) and
 * the content panels together, so they are treated as one class rather than
 * mapped to individual panels. Splitting them would mean maintaining a table of
 * which event touches which panel, for an invalidation that is O(1) either way.
 *
 * BLOG_CREATED is on the list even though the endpoint that emits it returns the
 * new draft to the caller, who therefore already knows. The dashboard is a
 * SEPARATE surface — very often a separate tab — and since the content counters
 * are read live (see the stats builder), leaving it off would mean a draft that
 * exists, is listed by `/dashboard/drafts`, and is missing from the count beside
 * it for up to a minute. Creating a blog is a rare event; the bump is free.
 */
const AUTHOR_EVENTS = [
  EVENTS.BLOG_CREATED,
  EVENTS.BLOG_PUBLISHED,
  EVENTS.BLOG_UPDATED,
  EVENTS.BLOG_UNPUBLISHED,
  EVENTS.BLOG_ARCHIVED,
  EVENTS.BLOG_RESTORED,
  EVENTS.BLOG_DELETED,
  EVENTS.BLOG_COVER_UPDATED,
] as const;

/**
 * Comment events, which carry `{ authorId, blogAuthorId }`.
 *
 * `blogAuthorId` is the one that matters — the comment appears on the BLOG
 * AUTHOR's activity feed and in their comment count. The commenter's own
 * dashboard shows nothing about comments they left, so bumping them too would
 * be a wasted invalidation on every reply.
 */
const COMMENT_EVENTS = [EVENTS.COMMENT_CREATED, EVENTS.COMMENT_REPLIED] as const;

/** Bookmark events, `{ blogId, userId }` — the SAVER's own library changed. */
const BOOKMARK_EVENTS = [EVENTS.BLOG_BOOKMARKED, EVENTS.BLOG_UNBOOKMARKED] as const;

/** Follow events, `{ followerId, followingId }`. Both dashboards change. */
const FOLLOW_EVENTS = [EVENTS.USER_FOLLOWED, EVENTS.USER_UNFOLLOWED] as const;

let registered = false;

/**
 * Registers every dashboard cache-invalidation subscriber.
 *
 * MUST be called from `server.ts`, never from `app.ts`: registering at app
 * import time would make every test that touches `app` issue Redis writes as a
 * side effect of unrelated service calls. Same rule, and same reason, as the
 * Notification, Search, Analytics and Feed registrations.
 *
 * Idempotent — a second call is ignored, so a stray import cannot double-bump
 * every generation.
 */
export function registerDashboardSubscribers(): void {
  if (registered) return;
  registered = true;

  for (const event of AUTHOR_EVENTS) {
    eventBus.on(event, (payload: { authorId?: string }) =>
      invalidate([payload?.authorId], event)
    );
  }

  for (const event of COMMENT_EVENTS) {
    eventBus.on(event, (payload: { blogAuthorId?: string }) =>
      invalidate([payload?.blogAuthorId], event)
    );
  }

  for (const event of BOOKMARK_EVENTS) {
    eventBus.on(event, (payload: { userId?: string }) =>
      invalidate([payload?.userId], event)
    );
  }

  for (const event of FOLLOW_EVENTS) {
    eventBus.on(event, (payload: { followerId?: string; followingId?: string }) =>
      invalidate([payload?.followerId, payload?.followingId], event)
    );
  }

  logger.info('Dashboard cache subscribers registered');
}

/**
 * Bumps the generation for every affected user, in one round trip.
 *
 * Ids that are absent from a payload are dropped rather than throwing: a
 * malformed event must not fail the job carrying it, and the worst case is a
 * panel that stays stale until its TTL. Logged, because an event that
 * repeatedly arrives without its owner id is a real defect upstream and the log
 * line is the only place it would ever surface.
 */
async function invalidate(userIds: (string | undefined)[], event: string): Promise<void> {
  const present = userIds.filter((id): id is string => Boolean(id));

  if (present.length === 0) {
    logger.warn({ event }, 'dashboard: event carried no user id — cache not invalidated');
    return;
  }

  try {
    await bumpGeneration(present);
  } catch (err) {
    logger.warn({ err, event }, 'dashboard: cache invalidation failed');
  }
}

/** Test seam. */
export function resetDashboardSubscriberRegistration(): void {
  registered = false;
}
