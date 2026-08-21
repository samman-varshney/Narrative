import { env } from '../config/env';

/**
 * The platform's public URL vocabulary — one owner, consumed by every module
 * that has to name a page a human can visit.
 *
 * ── Why this is in `core/` and not in a module ──────────────────────────────
 * Four places need to answer "where does this post live": the RSS module (an
 * item's `<link>`), the SEO module (a canonical URL, an `og:url`, a sitemap
 * `<loc>`), the Notification templates (a link in an email), and any future
 * distribution surface. Before this file, RSS and Notification each had their
 * own copy of `${APP_URL}/blog/${slug}` — which agreed only because someone
 * checked. A canonical URL that disagrees with the link in the email announcing
 * the post is a duplicate-content bug that nobody notices until a search engine
 * does, so the answer belongs in exactly one place.
 *
 * Nothing here depends on a module, so every module may depend on it and no
 * cycle can form.
 *
 * ── Configuration, never request headers ────────────────────────────────────
 * Nothing in this file reads a `Request`. Public URLs come from `APP_URL`, and
 * the alternative is a vulnerability rather than a style preference: `Host` and
 * `X-Forwarded-Host` are attacker-controlled on a public endpoint, and both the
 * RSS and SEO modules CACHE documents built from these URLs — so a single
 * request carrying a spoofed host would poison the copy served to everyone
 * afterwards, with canonical tags and syndication links pointing at the
 * attacker's domain under the platform's name.
 *
 * Building from configuration makes that unrepresentable rather than guarded.
 *
 * ── These paths are the product's public routes ─────────────────────────────
 * `PUBLIC_PATHS` is the authority on what a reader-facing URL looks like. It is
 * deliberately a small, closed vocabulary: adding a public page type means
 * adding a line here, which is also the moment to decide whether it belongs in
 * the sitemap and what its canonical form is.
 */

/**
 * The reader-facing paths the platform publishes.
 *
 * `blog` and `author` predate this file — the Notification templates have been
 * building `/blog/<slug>` and `/@<username>` since that module shipped, and RSS
 * adopted them rather than inventing a second answer. `category` and `tag` were
 * first named by the RSS module and are recorded here as the platform's choice.
 *
 * Every builder below applies `encodeSegment` to its input, so these take an
 * already-encoded segment and only decide the SHAPE of the path.
 */
export const PUBLIC_PATHS = {
  home: () => '/',
  blog: (slug: string) => `/blog/${slug}`,
  author: (username: string) => `/@${username}`,
  category: (slug: string) => `/categories/${slug}`,
  tag: (slug: string) => `/tags/${slug}`,
} as const;

/** The kinds of public resource the platform can name a URL for. */
export type PublicResourceKind = 'home' | 'blog' | 'author' | 'category' | 'tag';

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * Percent-encodes one path segment.
 *
 * Slugs and usernames are already constrained by their own validators; this is
 * the belt to that braces, so a vocabulary change upstream cannot produce a
 * malformed URL in a public document. Exported because callers that build a
 * path outside `PUBLIC_PATHS` (a feed's own address, a sitemap chunk) need the
 * same treatment.
 */
export const encodeSegment = (value: string): string => encodeURIComponent(value);

/**
 * Base URL of the reader-facing application — where a public link sends a human.
 *
 * Read through a function rather than captured in a constant so a test can
 * change `APP_URL` and see the effect, and so import order never decides what a
 * link says.
 */
export const appBaseUrl = (): string => trimTrailingSlash(env.APP_URL);

// ---------------------------------------------------------------------------
// Public page URLs
// ---------------------------------------------------------------------------

/**
 * The home page.
 *
 * Returns the base URL WITHOUT a trailing slash rather than `${base}/`, so the
 * platform has exactly one spelling of its own front page. Which spelling is
 * arbitrary; having two is not — `https://site` and `https://site/` are distinct
 * URLs to a crawler, and a canonical tag that disagrees with a sitemap `<loc>`
 * about which one is real is precisely the duplicate-content problem canonical
 * tags exist to solve. See SEO_MODULE.md § Duplicate content protection.
 */
export const homeUrl = (): string => appBaseUrl();

export const blogUrl = (slug: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.blog(encodeSegment(slug))}`;

export const authorUrl = (username: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.author(encodeSegment(username))}`;

export const categoryUrl = (slug: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.category(encodeSegment(slug))}`;

export const tagUrl = (slug: string): string =>
  `${appBaseUrl()}${PUBLIC_PATHS.tag(encodeSegment(slug))}`;

// ---------------------------------------------------------------------------
// Untrusted URL handling
// ---------------------------------------------------------------------------

/**
 * Returns `value` if it is an absolute `http`/`https` URL, otherwise `null`.
 *
 * The scheme allowlist is the point. `BlogSEO.canonicalUrl` and
 * `BlogSEO.ogImage` are author-supplied and validated only as well-formed URLs
 * — and `javascript:alert(1)` IS a well-formed URL as far as a URL parser is
 * concerned. Rendering that into a public document's `<link>`, a canonical tag
 * or an `og:image` would hand every consumer an executable reference, which
 * several desktop feed readers and preview crawlers will happily activate.
 * Anything that is not plain web addressing is refused here and the caller falls
 * back to the URL the platform derived itself.
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
 * Resolves a stored media URL to something a consumer on another host can
 * actually fetch.
 *
 * Absolute `http(s)` URLs — what the Cloudinary provider stores — pass through.
 * A ROOT-RELATIVE path — what the local development provider stores
 * (`/uploads/...`) — is resolved against `APP_URL`, because a relative URL in a
 * syndication document or an Open Graph tag is resolved by the consumer against
 * nothing useful. Anything else (a bare filename, a `data:` URI, a storage
 * `publicId` that somehow reached here) is refused, so an internal storage path
 * can never be published.
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
