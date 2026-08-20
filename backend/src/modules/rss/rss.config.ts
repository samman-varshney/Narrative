/**
 * RSS & Distribution configuration — every tunable number and every piece of
 * fixed channel copy in the module, in one file.
 *
 * Kept apart from the code that applies it for the same reasons `feed.config.ts`
 * is: these are the values most likely to be tuned, they are the part a unit
 * test can assert on without a database or a Redis, and a renderer reads as a
 * renderer only when the constants live somewhere else.
 *
 * Nothing here is an environment variable. The single deployment-dependent
 * value RSS needs is the public base URL of its own endpoints, and that one IS
 * in `core/config/env.ts` (`RSS_SELF_BASE_URL`) because it differs per
 * environment; everything below is a product decision that should be identical
 * in dev and production.
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Bumped when the RENDERED DOCUMENT changes shape — a new element, a changed
 * GUID scheme, a different date format.
 *
 * It is part of every cache key, so a deploy that changes the output cannot
 * serve documents built by the previous version, and it is folded into the
 * ETag, so a client holding a validator from the old shape revalidates instead
 * of being told 304 about a document that no longer exists.
 */
export const RSS_DOCUMENT_VERSION = 'v1';

// ---------------------------------------------------------------------------
// Feed size
// ---------------------------------------------------------------------------

/**
 * Items in a feed when the client does not ask.
 *
 * 20 is the convention readers expect and is roughly what a polling client
 * wants: enough that an hour of missed polls is still fully covered, few enough
 * that the document stays small on the wire.
 */
export const DEFAULT_ITEM_COUNT = 20;

/**
 * Hard ceiling on items in one feed, whatever the client asks for.
 *
 * RSS deliberately has NO pagination in this module — there is no cursor and no
 * `page` parameter — so this number is also the total depth of the syndication
 * surface. That is the point: a feed is "what is new", and a format with no
 * cursor should not become a bulk-extraction endpoint. Anyone who wants to walk
 * the corpus has `/feed/latest`, which is paginated, rate-limited and designed
 * for it.
 *
 * It is equally the cost bound. Every item may need a taxonomy row and, in the
 * worst case, a Tiptap document parsed for an excerpt (see `rss.content.ts`),
 * so an unbounded `limit` would be an unbounded amount of work per request.
 */
export const MAX_ITEM_COUNT = 50;

// ---------------------------------------------------------------------------
// Item content
// ---------------------------------------------------------------------------

/**
 * Longest `<description>` shipped per item, in characters.
 *
 * A syndication description is a teaser, not the article — the `<link>` is what
 * takes the reader to the full post. 500 characters is around three sentences:
 * enough to decide whether to click, short enough that a 50-item document stays
 * well under a hundred kilobytes even when every item needs one.
 */
export const MAX_DESCRIPTION_LENGTH = 500;

// ---------------------------------------------------------------------------
// Channel identity
// ---------------------------------------------------------------------------

export const PLATFORM_NAME = 'Narrative';

/** `<generator>`. Names the producer without disclosing a version to probe. */
export const FEED_GENERATOR = 'Narrative RSS';

/**
 * `<language>` for feeds that are not about one person.
 *
 * The global, category and tag feeds mix authors, so no single language claim is
 * truthful for them beyond the platform's own. An AUTHOR feed is different: it
 * has exactly one writer, whose `UserSettings.language` is a real answer, and
 * `rss.service` uses it when there is one. See RSS_MODULE.md § Channel fields.
 */
export const DEFAULT_LANGUAGE = 'en';

/** Channel `<description>` copy, per feed type. `%s` is the subject's name. */
export const CHANNEL_DESCRIPTIONS = {
  global: `The latest public posts published on ${PLATFORM_NAME}.`,
  author: (name: string) => `Public posts by ${name} on ${PLATFORM_NAME}.`,
  category: (name: string) => `Public posts in ${name} on ${PLATFORM_NAME}.`,
  tag: (name: string) => `Public posts tagged ${name} on ${PLATFORM_NAME}.`,
} as const;

/** Channel `<title>` copy, per feed type. */
export const CHANNEL_TITLES = {
  global: `${PLATFORM_NAME}`,
  author: (name: string) => `${name} — ${PLATFORM_NAME}`,
  category: (name: string) => `${name} — ${PLATFORM_NAME}`,
  tag: (name: string) => `#${name} — ${PLATFORM_NAME}`,
} as const;

// ---------------------------------------------------------------------------
// Public URL paths (on APP_URL, the reader-facing application)
// ---------------------------------------------------------------------------

/**
 * Paths the platform's own links already use, so an RSS `<link>` lands exactly
 * where a notification email would.
 *
 * `blog` and `author` are copied from `notification/templates/index.ts`, which
 * has been building `/blog/<slug>` and `/@<username>` since the Notification
 * module shipped — RSS must not invent a second answer to "where does this post
 * live". `category` and `tag` have no prior link on the platform; these are the
 * first, and RSS_MODULE.md records that they are a choice rather than an
 * inheritance.
 */
export const PUBLIC_PATHS = {
  blog: (slug: string) => `/blog/${slug}`,
  author: (username: string) => `/@${username}`,
  category: (slug: string) => `/categories/${slug}`,
  tag: (slug: string) => `/tags/${slug}`,
} as const;

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * How long a rendered feed may be served from Redis, in seconds.
 *
 * This is an upper bound on staleness only in the ABSENCE of events: publishing,
 * editing, hiding or withdrawing a post bumps the generations that key the
 * affected feeds and drops them immediately (see `subscribers/rss.subscriber`).
 * What the TTL bounds is the case where an event is lost — a queue outage, a
 * crash between commit and enqueue — and five minutes is comfortably shorter
 * than the interval any real reader polls at.
 */
export const CACHE_TTL_SECONDS = 300;

/**
 * How long a generation counter may be reused from process memory.
 *
 * Reading every counter from Redis on every request would put two round trips in
 * front of a response that is usually a 304. Memoizing cuts that to roughly one
 * read per counter per window, at the cost of up to this many extra seconds
 * before an invalidation raised on ANOTHER instance is visible here — well
 * inside what the TTL above already allows. Same mechanism, and same number, as
 * the Feed and Search caches.
 */
export const GENERATION_MEMO_MS = 5_000;

// ---------------------------------------------------------------------------
// HTTP caching
// ---------------------------------------------------------------------------

/**
 * `max-age` on the RSS response, in seconds.
 *
 * Matched to the Redis TTL deliberately: a shared cache that revalidates on
 * exactly the same cadence the origin refreshes on never serves anything the
 * origin would not have served itself, and the two staleness budgets stay one
 * number rather than two that drift.
 *
 * `public` rather than `private`: the document is identical for every caller by
 * construction — RSS never reads a token, never varies on a viewer, and carries
 * only PUBLIC content — so a CDN or a corporate proxy holding one copy for
 * everybody is correct. That is also the property that makes it safe, and it is
 * asserted in the route tests.
 */
export const HTTP_MAX_AGE_SECONDS = CACHE_TTL_SECONDS;

/**
 * `stale-while-revalidate` window, in seconds.
 *
 * Lets an intermediary keep answering from a just-expired copy while it
 * refreshes in the background. For a syndication document — where a reader
 * polling on a timer has no idea it received a copy five minutes old — this
 * costs nothing and removes the request spike that a synchronized expiry
 * otherwise sends at the origin.
 */
export const HTTP_STALE_WHILE_REVALIDATE_SECONDS = 600;

/**
 * The media type of an RSS document, with no parameters.
 *
 * Distinct from `RSS_CONTENT_TYPE` below because the two appear in different
 * places and mean slightly different things. This one goes in the `type`
 * attribute of `<atom:link rel="self">`, which is a media type and nothing else
 * — a `charset` parameter there describes a transfer, not the resource, and
 * strict feed validators say so.
 */
export const RSS_MEDIA_TYPE = 'application/rss+xml';

/**
 * The `Content-Type` header a feed response carries.
 *
 * The charset belongs HERE: the document declares UTF-8 in its XML prolog, and
 * stating it on the wire as well leaves a client nothing to guess.
 */
export const RSS_CONTENT_TYPE = `${RSS_MEDIA_TYPE}; charset=utf-8`;

/** Content type for the XML error documents the module's own handler renders. */
export const RSS_ERROR_CONTENT_TYPE = 'application/xml; charset=utf-8';
