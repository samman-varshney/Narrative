/**
 * Shared vocabulary for the RSS & Distribution module.
 *
 * These types are the contract between the layers that must not know each
 * other's internals:
 *
 *   controller  ──▶ HTTP: conditional requests, headers, status codes
 *   service     ──▶ orchestration, caching, document assembly
 *   repository  ──▶ bounded retrieval + eligibility (the only SQL)
 *   renderer    ──▶ serialization of a document into bytes
 *
 * ── Why the document types say nothing about RSS ────────────────────────────
 * `SyndicationChannel` and `SyndicationItem` describe a FEED, not an RSS 2.0
 * feed. There is no `guid` element here, no `pubDate`, no namespace and no
 * escaping — those are facts about a serialization, and they live entirely in
 * `rss.renderer.ts`. Adding Atom or JSON Feed later is then a second
 * `IFeedRenderer` and a content-negotiation branch in the controller: the
 * querying, eligibility, caching and invalidation below it do not move.
 *
 * That separation is the reason `guid` is spelled `id` and `pubDate` is spelled
 * `publishedAt`. A type that used the RSS spellings would have quietly made the
 * abstraction a lie.
 */

// ---------------------------------------------------------------------------
// Feed identity
// ---------------------------------------------------------------------------

/**
 * The four feeds this module serves.
 *
 * Used as a route name, a cache namespace and an invalidation scope, so a
 * cached document built for one can never be served for another. `global` has
 * no subject; the other three are always about one row.
 */
export type RssFeedScope = 'global' | 'author' | 'category' | 'tag';

/**
 * A resolved feed subject: the thing a feed is ABOUT, after it has been looked
 * up and found eligible.
 *
 * `id` is the database id — never the slug or username the client supplied. It
 * is what keys the cache and what an invalidation targets, and unlike a slug it
 * cannot change under a feed that is already cached.
 */
export interface RssFeedSubject {
  scope: RssFeedScope;
  /** Database id of the subject row. `null` for the global feed. */
  id: string | null;
  /** Display name used in the channel title and description. */
  name: string;
  /** The subject's public URL on the reader-facing application. */
  link: string;
  /**
   * BCP-47 language tag for the channel, when one can be stated truthfully.
   * Only an author feed has one (their `UserSettings.language`); mixed-author
   * feeds fall back to the platform default. See `rss.config.DEFAULT_LANGUAGE`.
   */
  language: string | null;
}

/** A fully-specified feed request, after validation. */
export interface RssFeedRequest {
  scope: RssFeedScope;
  /** The slug or username from the path. Absent for the global feed. */
  key?: string;
  /** Item count, already bounded to [1, MAX_ITEM_COUNT]. */
  limit: number;
}

// ---------------------------------------------------------------------------
// Document shapes (format-agnostic)
// ---------------------------------------------------------------------------

/** A tag or category as it appears on an item. */
export interface SyndicationTerm {
  name: string;
  slug: string;
}

/**
 * The author of an item, as a feed may state it.
 *
 * Deliberately has no email field. RSS 2.0's `<author>` element is DEFINED as
 * an email address, which is why this module renders `<dc:creator>` instead:
 * a syndication document is the least controlled surface the platform has, and
 * publishing addresses into it would undo `UserSettings.hideEmail` for everyone
 * at once. See RSS_MODULE.md § Security.
 */
export interface SyndicationAuthor {
  name: string;
  username: string;
  profileUrl: string;
}

/**
 * A media attachment on an item — the blog's cover image.
 *
 * `url` is always an absolute, public URL produced by the Media module's stored
 * `secureUrl`. The storage `publicId` (an internal path) never appears here or
 * anywhere downstream.
 *
 * `lengthBytes` is present because RSS 2.0 requires a `length` attribute on an
 * enclosure. Where the platform genuinely does not know the size, the renderer
 * emits `0` rather than dropping the enclosure — a documented convention among
 * feed producers, and better than withholding the image.
 */
export interface SyndicationEnclosure {
  url: string;
  mimeType: string;
  lengthBytes: number;
}

/** One entry in a feed. */
export interface SyndicationItem {
  /**
   * The item's PERMANENT identity, stable across every edit to the post.
   * See `rss.urls.blogGuid` for the scheme and why it is not the URL.
   */
  id: string;
  title: string;
  /** Canonical public URL of the post. May change if the slug does; `id` does not. */
  link: string;
  /** Plain-text teaser. `null` when the post genuinely has no summarizable text. */
  description: string | null;
  author: SyndicationAuthor;
  /** Publication instant. Never null in practice — eligibility requires one. */
  publishedAt: Date | null;
  /** Last modification instant. Drives `lastBuildDate` and the ETag. */
  updatedAt: Date;
  categories: SyndicationTerm[];
  enclosure: SyndicationEnclosure | null;
}

/** The channel-level metadata of a feed. */
export interface SyndicationChannel {
  /** The channel's permanent identity, independent of its URL. */
  id: string;
  title: string;
  description: string;
  /** Where a human reads this feed's content on the application. */
  link: string;
  /** The feed document's own absolute URL. */
  selfUrl: string;
  language: string | null;
  /**
   * When the channel's content last changed.
   *
   * Derived from the newest item's `updatedAt`, NEVER from the clock. That is
   * what makes the rendered document a pure function of the data — which in
   * turn is what lets the ETag stay stable across regenerations and lets a
   * reader's `If-Modified-Since` mean something. `null` for an empty feed.
   */
  lastBuildDate: Date | null;
  generator: string;
}

/** A complete feed, ready to be handed to a renderer. */
export interface SyndicationDocument {
  channel: SyndicationChannel;
  items: SyndicationItem[];
}

// ---------------------------------------------------------------------------
// Rendered output
// ---------------------------------------------------------------------------

/**
 * A serialized feed plus everything the HTTP layer needs to answer a
 * conditional request without looking at the body.
 *
 * This — not `SyndicationDocument` — is what the cache stores and what the
 * service returns, because a cache hit must be able to produce a 304 without
 * re-rendering anything.
 */
export interface RenderedFeed {
  body: string;
  contentType: string;
  /** Strong entity tag, including the surrounding quotes. */
  etag: string;
  /** `null` for an empty feed, in which case no `Last-Modified` is sent. */
  lastModified: Date | null;
  itemCount: number;
}

// ---------------------------------------------------------------------------
// Internal (never serialized to a client)
// ---------------------------------------------------------------------------

/**
 * A blog row as the repository returns it.
 *
 * Columns are aliased to camelCase in SQL so the mapping in the service is a
 * shape change rather than a rename table — the same convention
 * `feed.repository.ts` follows.
 *
 * `content` is absent BY CONSTRUCTION. The Tiptap document is loaded only for
 * the subset of rows that need an excerpt and cannot get one more cheaply, in a
 * second batched query. See `rss.service.buildItems`.
 */
export interface RssBlogRow {
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  /** Denormalized cover URL on the blog row; may be relative under local storage. */
  coverImage: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
  authorId: string;
  authorUsername: string;
  authorName: string;
  /** Author-authored SEO summary, when the SEO row carries one. */
  metaDescription: string | null;
  /** Author-declared canonical URL, when the SEO row carries one. */
  canonicalUrl: string | null;
  /** Cover fields from the linked Media row; all null when there is no cover. */
  coverSecureUrl: string | null;
  coverMimeType: string | null;
  coverFileSize: number | null;
}

/** Tags and categories for a page of blogs, keyed by blog id. */
export interface RssTaxonomy {
  tags: Map<string, SyndicationTerm[]>;
  categories: Map<string, SyndicationTerm[]>;
}

/** The taxonomy ids a single blog belongs to — the invalidation fan-out set. */
export interface RssBlogTermIds {
  authorId: string;
  tagIds: string[];
  categoryIds: string[];
}
