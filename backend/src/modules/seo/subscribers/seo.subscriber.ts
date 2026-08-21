import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { seoRepository } from '../seo.repository';
import { seoService } from '../seo.service';
import { sitemapService } from '../sitemap.service';

/**
 * Cache invalidation for the SEO module.
 *
 * This is the module's ONLY inbound coupling to the rest of the platform, and it
 * is one-directional: SEO listens, and never asks a sibling whether something
 * changed. No new events were introduced — every subscription below is to an
 * event the Blog, User or Moderation flow was already emitting — which is what
 * keeps SEO a leaf in the dependency graph. SEO is an event CONSUMER and never a
 * producer; nothing in this module emits.
 *
 * ── Events the brief suggested that do not exist ────────────────────────────
 * `USER_UPDATED`, `CATEGORY_UPDATED` and `TAG_UPDATED` are not in the platform's
 * catalogue and are NOT subscribed to. The closest real events are
 * `USER_PROFILE_UPDATED` (which is what a profile edit emits) and
 * `CATEGORY_CREATED`; tags have no lifecycle event at all, because they are
 * created implicitly when a post is published and are never edited. Tag pages
 * are therefore kept current by the blog events below and by their TTL, which is
 * exactly right for a page whose only content is a term's name.
 *
 * ── Invalidation is never on the write path ─────────────────────────────────
 * These handlers run in the domain-events worker, after the user's request has
 * already returned, and every one of them is best-effort. Publishing a post
 * cannot fail, slow down, or roll back because a cache key could not be
 * dropped — the consequence of a failure here is a stale page for at most its
 * TTL, which is what the TTL is for.
 *
 * ── Three tiers, chosen by blast radius ─────────────────────────────────────
 *
 *   PER-BLOG    The frequent case, and the precise one. A post entering or
 *               leaving the indexable set — or changing what its tags say —
 *               affects its own page, its author's profile (whose indexability
 *               depends on having published something) and the sitemap.
 *               `invalidateForBlog` drops exactly those. Publishing a post
 *               leaves every other page on the platform untouched.
 *
 *   PER-AUTHOR  A profile edit changes the profile page and nothing else. The
 *               author's name is embedded in the structured data of every post
 *               they wrote, and those are deliberately left to expire: a display
 *               name up to five minutes stale in a JSON-LD node is not worth an
 *               unbounded fan-out over an author's entire catalogue on an event
 *               a user can fire by changing their bio.
 *
 *   EVERYTHING  Account status and moderation outcomes. Each removes (or
 *               restores) an entire catalogue at once, and enumerating the pages
 *               that catalogue touches is an unbounded query on a path that must
 *               be immediate. One `INCR` on the root generation makes every
 *               cached page and sitemap on the platform unreachable, and it
 *               costs the same whatever the cache holds.
 *
 * Indexability alone is not enough to justify skipping any of this. The rules
 * live in the resolver, so a suspended author's post resolves to `noindex` on
 * the next UNCACHED read — but a document written a moment earlier would go on
 * being served, and re-served to conditional requests as a 304, for the rest of
 * its TTL. For an ordinary staleness that is fine; for content a moderator has
 * just removed it is not, which is the whole reason the root tier exists.
 *
 * ── Idempotence ────────────────────────────────────────────────────────────
 * Every handler is idempotent in the only sense that matters here: deleting a
 * key twice is indistinguishable from deleting it once, and bumping a
 * generation twice is indistinguishable from bumping it once — what invalidates
 * a key is the number CHANGING, not its value. The domain-events queue is
 * at-least-once, so a redelivered job simply repeats a no-op. That is why none
 * of these handlers reads `meta.eventId` to deduplicate: there is nothing to
 * deduplicate.
 */

/**
 * Blog lifecycle: a post enters or leaves the indexable set, or its page's
 * metadata changes.
 *
 * All carry `{ blogId, authorId }`. `BLOG_CREATED` is absent on purpose — a new
 * post is a DRAFT, which has no public page and appears in no sitemap, so
 * invalidating on it would drop cache entries on the platform's most frequent
 * content write for no possible change in output. `BLOG_PUBLISHED` is the event
 * that matters.
 */
const BLOG_EVENTS = [
  EVENTS.BLOG_PUBLISHED,
  EVENTS.BLOG_UPDATED, // covers a retitle, a re-slug, an SEO override edit
  EVENTS.BLOG_UNPUBLISHED,
  EVENTS.BLOG_ARCHIVED,
  EVENTS.BLOG_RESTORED,
  EVENTS.BLOG_DELETED,
  EVENTS.BLOG_COVER_UPDATED, // the cover is the page's `og:image`
] as const;

/**
 * Author events that change a profile page.
 *
 * Carry `{ userId }`. The avatar is included because it IS the profile page's
 * `og:image` and its `Person.image`, so an avatar change makes the cached
 * profile metadata wrong in a way a preview card will show.
 */
const AUTHOR_EVENTS = [
  EVENTS.USER_PROFILE_UPDATED,
  EVENTS.USER_AVATAR_UPDATED,
] as const;

/**
 * Events that add or remove a whole catalogue.
 *
 * Account status is the User module's fact — SEO subscribes to it and still has
 * no dependency on the Moderation module, exactly as Feed, Search and RSS do.
 * `USER_DELETED` and `USER_DEACTIVATED` matter for the same predicate as
 * `USER_SUSPENDED`: the indexable set requires an ACTIVE author, so all three
 * need the same immediacy — a suspended author's posts must stop asking to be
 * indexed now, not in five minutes, because a search index remembers far longer
 * than a cache does.
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
 * comment — never by Moderation. Only `BLOG` targets are relevant: comments have
 * no page of their own and appear in no sitemap, so a comment hide invalidates
 * nothing, and the payload is filtered rather than the event catalogue being
 * split to suit one consumer.
 *
 * A blog target takes the root path rather than the per-blog one even though the
 * blog id is right there in the payload. A moderator removing content is the one
 * case where being a few hundred milliseconds slow — or getting a stale answer
 * from a lookup — is not acceptable, and one `INCR` is both faster and
 * unconditionally correct.
 */
const MODERATION_EVENTS = [EVENTS.CONTENT_MODERATED, EVENTS.CONTENT_RESTORED] as const;

let registered = false;

/**
 * Registers every SEO cache-invalidation subscriber.
 *
 * MUST be called from `server.ts`, never from `app.ts`: registering at app
 * import time would make every test that touches `app` start issuing Redis
 * writes as a side effect of unrelated service calls. Same rule, and same
 * reason, as the Notification, Search, Feed, Dashboard, Moderation and RSS
 * registrations.
 *
 * Idempotent — a second call is ignored, so a stray import cannot double-
 * register and make one publish invalidate twice.
 */
export function registerSeoSubscribers(): void {
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

  // A new category is a new public page and a new sitemap entry — but only once
  // something is published into it, so nothing per-page needs dropping. The
  // sitemap is bumped so the section picks it up on its next build rather than
  // at the hour's TTL.
  eventBus.on(EVENTS.CATEGORY_CREATED, () => onSitemapChanged(EVENTS.CATEGORY_CREATED));

  logger.info('SEO cache subscribers registered');
}

/**
 * A failed invalidation must never fail the job that carried the event. Every
 * handler below therefore swallows and logs: the consequence is a stale page
 * for at most its TTL, which is exactly what the TTL is there to bound.
 */
async function onBlogChanged(
  event: string,
  payload: { blogId?: string; authorId?: string }
): Promise<void> {
  if (!payload?.blogId) {
    // A blog event with no id cannot be resolved to the pages it affects.
    // Logged rather than escalated to a root bump: an unknown payload shape is a
    // bug to fix, not a reason to flush the platform's cache on every delivery.
    logger.warn({ event }, 'seo: blog event without a blogId — cache not invalidated');
    return;
  }

  try {
    // Most blog events carry the author, and the lookup is skipped when they do.
    // The fallback exists because the author's profile page is genuinely
    // affected — its indexability depends on having published something — and
    // resolving one id is cheaper than leaving that page wrong for a TTL.
    const authorId =
      payload.authorId ??
      (await seoRepository.findBlogAuthorId(payload.blogId).catch((err) => {
        logger.warn({ err, event }, 'seo: could not resolve a blog author for invalidation');
        return null;
      })) ??
      undefined;

    await seoService.invalidateForBlog(payload.blogId, authorId);
  } catch (err) {
    logger.warn({ err, event }, 'seo: blog cache invalidation failed');
  }
}

async function onAuthorChanged(event: string, payload: { userId?: string }): Promise<void> {
  if (!payload?.userId) {
    logger.warn({ event }, 'seo: author event without a userId — cache not invalidated');
    return;
  }

  try {
    await seoService.invalidateForAuthor(payload.userId);
  } catch (err) {
    logger.warn({ err, event }, 'seo: author cache invalidation failed');
  }
}

async function onCatalogueChanged(event: string): Promise<void> {
  try {
    await seoService.invalidateEverything();
  } catch (err) {
    logger.warn({ err, event }, 'seo: global cache invalidation failed');
  }
}

async function onSitemapChanged(event: string): Promise<void> {
  try {
    await sitemapService.invalidate();
  } catch (err) {
    logger.warn({ err, event }, 'seo: sitemap cache invalidation failed');
  }
}

/** Test seam. */
export function resetSeoSubscriberRegistration(): void {
  registered = false;
}
