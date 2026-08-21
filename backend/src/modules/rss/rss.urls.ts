import { env } from '../../core/config/env';
import { appBaseUrl, encodeSegment } from '../../core/utils/publicUrls';
import { DEFAULT_ITEM_COUNT } from './rss.config';
import type { RssFeedScope } from './rss.types';

/**
 * Every URL and every identifier RSS puts into a document.
 *
 * ── Public page URLs live in `core/utils/publicUrls` ────────────────────────
 * `blogUrl`, `authorUrl`, `categoryUrl` and `tagUrl` are re-exported below
 * rather than defined here. They started in this file, and moved out when the
 * SEO module needed the same answers for canonical tags and sitemap entries:
 * a canonical URL that disagreed with the `<link>` in the feed would be a
 * duplicate-content bug neither module could see from the inside. This file
 * keeps what is genuinely RSS's — feed addresses and feed identifiers — and
 * re-exports the shared vocabulary so nothing in this module has to know the
 * difference.
 *
 * ── Configured URLs, never request headers ──────────────────────────────────
 * Nothing here reads `req`. Public URLs are built from `APP_URL` and
 * `RSS_SELF_BASE_URL`, both of which come from the environment, because the
 * alternative is a vulnerability rather than a style preference: `Host` and
 * `X-Forwarded-Host` are attacker-controlled on a public endpoint, and this
 * module CACHES the documents it builds — so a single request carrying a spoofed
 * host would poison the copy served to every subsequent subscriber, with links
 * pointing at the attacker's domain and the platform's name on the channel.
 *
 * ── Identifiers are not URLs ────────────────────────────────────────────────
 * `blogGuid` and `channelId` return `urn:` identifiers, not links. See the
 * comment on `blogGuid` for why a feed's notion of identity must survive a
 * change of address.
 */

export {
  appBaseUrl,
  blogUrl,
  authorUrl,
  categoryUrl,
  tagUrl,
  safeHttpUrl,
  absolutePublicUrl,
} from '../../core/utils/publicUrls';

/** The API path this module is mounted at. Kept beside the URLs it composes. */
export const RSS_MOUNT_PATH = '/api/v1/rss';

/** The URN namespace every identifier this module mints lives under. */
const URN_PREFIX = 'urn:narrative';

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * Base URL of the RSS endpoints themselves — where `<atom:link rel="self">`
 * points.
 *
 * Defaults to the API path under `APP_URL`, which is correct for the common
 * single-origin deployment. `RSS_SELF_BASE_URL` overrides it when the API is
 * served from another host or behind a path-rewriting proxy.
 */
export const selfBaseUrl = (): string =>
  trimTrailingSlash(env.RSS_SELF_BASE_URL ?? `${appBaseUrl()}${RSS_MOUNT_PATH}`);

// ---------------------------------------------------------------------------
// Feed URLs
// ---------------------------------------------------------------------------

/** The path of one feed, relative to `selfBaseUrl()`. */
export function feedPath(scope: RssFeedScope, key?: string): string {
  switch (scope) {
    case 'author':
      return `/authors/${encodeSegment(key ?? '')}`;
    case 'category':
      return `/categories/${encodeSegment(key ?? '')}`;
    case 'tag':
      return `/tags/${encodeSegment(key ?? '')}`;
    case 'global':
    default:
      return '';
  }
}

/**
 * The absolute URL of a feed document — its `rel="self"` address.
 *
 * `limit` appears only when it differs from the default, so the ordinary
 * subscription URL stays clean and two clients that both took the default
 * resolve to the same self link (and therefore the same cache entry and the
 * same ETag).
 */
export function feedSelfUrl(scope: RssFeedScope, key?: string, limit?: number): string {
  const base = `${selfBaseUrl()}${feedPath(scope, key)}`;
  return limit !== undefined && limit !== DEFAULT_ITEM_COUNT ? `${base}?limit=${limit}` : base;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * The permanent identity of a post in a feed.
 *
 * A feed reader uses the GUID to decide whether an item is one it has already
 * shown. That makes the choice of what goes in it a product decision, not a
 * formatting one:
 *
 *   NOT the link       a canonical URL contains the SLUG, and an author may
 *                      retitle a post — `blogService` re-slugs on a title
 *                      change. Using the URL would resurface every renamed post
 *                      in every subscriber's unread list, and leave the original
 *                      behind as a duplicate that never goes away.
 *
 *   NOT a content hash a corrected typo is not a new article.
 *
 *   THE ROW ID         `Blog.id` is a cuid assigned at creation, never written
 *                      again, and unique across the platform. It survives
 *                      retitling, re-slugging, unpublishing and republishing,
 *                      archiving and restoration — which is exactly the set of
 *                      events after which a reader should see the item it
 *                      already has, not a new one.
 *
 * Rendered with `isPermaLink="false"`, because a URN is an identifier and not a
 * URL a client may fetch. A `urn:` scheme rather than a bare id so it is
 * globally unambiguous and cannot collide with an identifier minted by another
 * producer whose items a reader also holds.
 */
export const blogGuid = (blogId: string): string => `${URN_PREFIX}:blog:${blogId}`;

/**
 * The permanent identity of a CHANNEL, independent of the URL it is served at.
 *
 * Built from the subject's database id, not its slug, for the same reason
 * `blogGuid` is: a category renamed from `web-dev` to `web-development` is the
 * same channel, and a subscriber should not be asked to resubscribe.
 */
export const channelId = (scope: RssFeedScope, subjectId: string | null): string =>
  subjectId ? `${URN_PREFIX}:feed:${scope}:${subjectId}` : `${URN_PREFIX}:feed:${scope}`;
