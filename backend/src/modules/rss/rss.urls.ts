import { env } from '../../core/config/env';
import { DEFAULT_ITEM_COUNT, PUBLIC_PATHS } from './rss.config';
import type { RssFeedScope } from './rss.types';

/**
 * Every URL and every identifier RSS puts into a document.
 *
 * ── Configured URLs, never request headers ──────────────────────────────────
 * Nothing in this file reads `req`. Public URLs are built from `APP_URL` and
 * `RSS_SELF_BASE_URL`, both of which come from the environment, because the
 * alternative is a vulnerability rather than a style preference: `Host` and
 * `X-Forwarded-Host` are attacker-controlled on a public endpoint, and this
 * module CACHES the documents it builds — so a single request carrying a spoofed
 * host would poison the copy served to every subsequent subscriber, with links
 * pointing at the attacker's domain and the platform's name on the channel.
 *
 * Building from configuration makes that unrepresentable rather than guarded.
 *
 * ── Identifiers are not URLs ────────────────────────────────────────────────
 * `blogGuid` and `channelId` return `urn:` identifiers, not links. See the
 * comment on `blogGuid` for why a feed's notion of identity must survive a
 * change of address.
 */

/** The API path this module is mounted at. Kept beside the URLs it composes. */
export const RSS_MOUNT_PATH = '/api/v1/rss';

/** The URN namespace every identifier this module mints lives under. */
const URN_PREFIX = 'urn:narrative';

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * Base URL of the reader-facing application — where a `<link>` sends a human.
 *
 * Read through a function rather than captured in a constant so a test can
 * change `APP_URL` and see the effect, and so import order never decides what a
 * link says.
 */
export const appBaseUrl = (): string => trimTrailingSlash(env.APP_URL);

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
// Public application URLs
// ---------------------------------------------------------------------------

/** Percent-encodes one path segment. Slugs and usernames are already safe by
 *  validation; this is the belt to that braces, so a vocabulary change upstream
 *  cannot produce a malformed URL in a public document. */
const segment = (value: string): string => encodeURIComponent(value);

export const blogUrl = (slug: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.blog(segment(slug))}`;

export const authorUrl = (username: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.author(segment(username))}`;

export const categoryUrl = (slug: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.category(segment(slug))}`;

export const tagUrl = (slug: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.tag(segment(slug))}`;

// ---------------------------------------------------------------------------
// Feed URLs
// ---------------------------------------------------------------------------

/** The path of one feed, relative to `selfBaseUrl()`. */
export function feedPath(scope: RssFeedScope, key?: string): string {
  switch (scope) {
    case 'author':
      return `/authors/${segment(key ?? '')}`;
    case 'category':
      return `/categories/${segment(key ?? '')}`;
    case 'tag':
      return `/tags/${segment(key ?? '')}`;
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

// ---------------------------------------------------------------------------
// Untrusted URL handling
// ---------------------------------------------------------------------------

/**
 * Returns `value` if it is an absolute `http`/`https` URL, otherwise `null`.
 *
 * The scheme allowlist is the point. `BlogSEO.canonicalUrl` is author-supplied
 * and validated only as a well-formed URL — and `javascript:alert(1)` IS a
 * well-formed URL as far as a URL parser is concerned. Rendering that into a
 * public document's `<link>` would hand every subscriber's reader an executable
 * href, which several desktop readers will happily activate. Anything that is
 * not plain web addressing is refused here and the caller falls back to the
 * URL the platform derived itself.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Resolves a stored media URL to something a feed reader on another host can
 * actually fetch.
 *
 * Absolute `http(s)` URLs — what the Cloudinary provider stores — pass through.
 * A ROOT-RELATIVE path — what the local development provider stores
 * (`/uploads/...`) — is resolved against `APP_URL`, because a relative URL in a
 * syndication document is resolved by the reader against nothing useful.
 * Anything else (a bare filename, a `data:` URI, a storage `publicId` that
 * somehow reached here) is refused, so an internal storage path can never be
 * published.
 */
export function absolutePublicUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('/')) {
    // `//host/path` is protocol-relative, i.e. an absolute reference to another
    // origin. Not a platform-served path, so it is not resolved as one.
    if (value.startsWith('//')) return null;
    return `${appBaseUrl()}${value}`;
  }
  return safeHttpUrl(value);
}
