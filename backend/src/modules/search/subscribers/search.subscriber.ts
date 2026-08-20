import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { bumpGeneration, type CacheScope } from '../search.cache';

/**
 * Cache invalidation for the Search module.
 *
 * This is the module's ONLY inbound coupling to the rest of the platform, and it
 * is one-directional: Search listens, and never calls BlogService, UserService,
 * or any sibling repository to ask whether something changed. That constraint is
 * what keeps Search a leaf in the dependency graph — extracting it into its own
 * service later means re-pointing these subscriptions at a message broker and
 * nothing else.
 *
 * ── What each event invalidates ─────────────────────────────────────────────
 * Blog lifecycle events move a blog into or out of the publicly searchable set,
 * or change the text that set is ranked on, so they invalidate the blog scope.
 * They also touch `suggestions`, which draws blog titles.
 *
 * User events are subtler and are the reason this list is longer than the
 * brief's minimum. A blog hit EMBEDS its author's username, display name, avatar
 * and verified badge — so a profile edit makes cached BLOG results stale, not
 * just cached user results. Missing that would leave a renamed author showing
 * their old name in search for the life of the entry. `USER_SETTINGS_UPDATED`
 * matters for the same class of reason: it carries the `isPrivate` toggle, which
 * decides whether a user appears in search at all.
 *
 * ── Why generation bumps, not targeted deletes ──────────────────────────────
 * See `search.cache.ts`. One `INCR` per scope invalidates every cached query in
 * it, regardless of how many entries exist, which is the only approach that
 * stays O(1) as the cache grows.
 *
 * ── Coarseness is deliberate ────────────────────────────────────────────────
 * A single blog being published drops every cached blog search, not just the
 * ones that would have matched it — which is unknowable without re-running them.
 * With a 60-second TTL the entries were nearly worthless anyway, and correctness
 * is worth more than a hit-rate point on a cache this short-lived.
 */

/** Blog lifecycle: changes what is searchable, or the text it ranks on. */
const BLOG_EVENTS = [
  EVENTS.BLOG_CREATED, // may mint new tags, which suggestions draw from
  EVENTS.BLOG_UPDATED,
  EVENTS.BLOG_PUBLISHED,
  EVENTS.BLOG_UNPUBLISHED,
  EVENTS.BLOG_ARCHIVED,
  EVENTS.BLOG_RESTORED,
  EVENTS.BLOG_DELETED,
  EVENTS.BLOG_COVER_UPDATED, // the cover URL is part of every blog hit
] as const;

/** User events: change embedded author data, or whether a user is findable. */
const USER_EVENTS = [
  EVENTS.USER_PROFILE_UPDATED,
  EVENTS.USER_AVATAR_UPDATED,
  EVENTS.USER_SETTINGS_UPDATED, // carries the isPrivate visibility toggle
  EVENTS.USER_DELETED,
] as const;

/** Scopes invalidated by a blog change. */
const BLOG_SCOPES: CacheScope[] = ['blogs', 'global', 'tags', 'suggestions'];

/**
 * Scopes invalidated by a user change. Includes `blogs` because author fields
 * are denormalized into every blog hit.
 */
const USER_SCOPES: CacheScope[] = ['users', 'blogs', 'global', 'suggestions'];

/** Scopes invalidated when the curated category vocabulary changes. */
const CATEGORY_SCOPES: CacheScope[] = ['categories', 'global', 'suggestions'];

let registered = false;

/**
 * Registers every search cache-invalidation subscriber.
 *
 * MUST be called from `server.ts`, never from `app.ts` — registering at app
 * import time would make every test that touches `app` start issuing Redis
 * writes as a side effect of unrelated service calls. Same rule, and same
 * reason, as `registerNotificationSubscribers`.
 *
 * Idempotent: a second call is ignored, so a stray import cannot double-register
 * and double-bump every generation.
 */
export function registerSearchSubscribers(): void {
  if (registered) return;
  registered = true;

  for (const event of BLOG_EVENTS) {
    eventBus.on(event, () => invalidate(BLOG_SCOPES, event));
  }
  for (const event of USER_EVENTS) {
    eventBus.on(event, () => invalidate(USER_SCOPES, event));
  }
  eventBus.on(EVENTS.CATEGORY_CREATED, () =>
    invalidate(CATEGORY_SCOPES, EVENTS.CATEGORY_CREATED)
  );

  logger.info('Search cache subscribers registered');
}

/**
 * A failed invalidation must never fail the job that carried the event — the
 * consequence is a stale cache entry for at most its TTL, which is exactly what
 * the TTL is there to bound.
 */
async function invalidate(scopes: CacheScope[], event: string): Promise<void> {
  try {
    await bumpGeneration(scopes);
  } catch (err) {
    logger.warn({ err, event, scopes }, 'search: cache invalidation failed');
  }
}

/** Test seam. */
export function resetSearchSubscriberRegistration(): void {
  registered = false;
}
