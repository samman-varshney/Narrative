/**
 * The SEO module's vocabulary.
 *
 * Two shapes matter here, and keeping them apart is what keeps the module
 * honest:
 *
 *   SOURCES  (`BlogSeoSource`, `AuthorSeoSource`, …) — the projected rows the
 *            repository returns. They contain database columns, including
 *            author-supplied overrides that have not been validated for
 *            publication yet.
 *
 *   RESOLVED (`ResolvedMetadata`) — what the resolver produces and what the API
 *            returns. Every field is decided, every URL is absolute and
 *            scheme-checked, and nothing internal survives the mapping.
 *
 * The API never returns a source. That is the difference between "exposes
 * resolved metadata" and "exposes database records", and it is a security
 * property rather than a tidiness one: a source row carries `status`,
 * `visibility` and `isHidden`, which describe the platform's moderation and
 * gating state and are nobody's business on a public endpoint.
 */

import type { BlogStatus, BlogVisibility } from '@prisma/client';

/** The public resource kinds the module can describe. */
export type SeoResourceKind = 'site' | 'blog' | 'author' | 'category' | 'tag';

// ---------------------------------------------------------------------------
// Robots
// ---------------------------------------------------------------------------

/**
 * A page's crawler directive.
 *
 * Two independent axes, deliberately, because they answer different questions
 * and the interesting cases disagree. An UNLISTED post is `noindex, follow`:
 * it must not appear in a search index (it was never advertised), but a crawler
 * that reached it by link should still follow the links it contains rather than
 * treating the page as a dead end. Collapsing them into one boolean would force
 * that case to be wrong in one direction or the other.
 */
export interface RobotsDirective {
  index: boolean;
  follow: boolean;
  /** The rendered `robots` meta value, e.g. `index, follow`. */
  directive: string;
}

// ---------------------------------------------------------------------------
// Open Graph / Twitter
// ---------------------------------------------------------------------------

/** `og:type` values the platform's pages actually are. */
export type OpenGraphType = 'website' | 'article' | 'profile';

/** `article:*` properties. Present only when `type` is `article`. */
export interface OpenGraphArticle {
  /** ISO-8601. Null when the post has no publication instant. */
  publishedTime: string | null;
  modifiedTime: string | null;
  /** The author's public profile URL — what `article:author` is specified to be. */
  author: string | null;
  /** The primary category, when the post has one. */
  section: string | null;
  tags: string[];
}

/** `profile:*` properties. Present only when `type` is `profile`. */
export interface OpenGraphProfile {
  username: string;
}

export interface OpenGraphMetadata {
  title: string;
  description: string | null;
  url: string;
  type: OpenGraphType;
  siteName: string;
  /** Absolute, scheme-checked, or null. Never a relative or internal path. */
  image: string | null;
  article?: OpenGraphArticle;
  profile?: OpenGraphProfile;
}

export type TwitterCardType = 'summary' | 'summary_large_image';

export interface TwitterMetadata {
  card: TwitterCardType;
  title: string;
  description: string | null;
  image: string | null;
  /** The platform's own handle, from configuration. */
  site: string | null;
  /** The author's handle, when one can be derived safely. See `seo.resolver`. */
  creator: string | null;
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

/**
 * One JSON-LD node.
 *
 * Deliberately a loose record rather than a modelled Schema.org type. The
 * vocabulary is enormous, the subset that matters is small and stated in
 * `seo.structuredData.ts`, and a hand-written type hierarchy for it would be a
 * large surface that adds no safety the builders do not already provide — they
 * are the only code that constructs these, and every value they emit comes from
 * a typed source.
 */
export type StructuredDataNode = Record<string, unknown>;

/** One step in the breadcrumb trail, in document order. */
export interface BreadcrumbItem {
  name: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Resolved metadata — the module's output
// ---------------------------------------------------------------------------

export interface ResolvedMetadata {
  resource: SeoResourceKind;
  title: string;
  description: string | null;
  /** Absolute, and the single canonical spelling of this page's address. */
  canonicalUrl: string;
  robots: RobotsDirective;
  openGraph: OpenGraphMetadata;
  twitter: TwitterMetadata;
  /** JSON-LD nodes describing exactly what the page shows. */
  structuredData: StructuredDataNode[];
  breadcrumbs: BreadcrumbItem[];
}

// ---------------------------------------------------------------------------
// Repository sources
// ---------------------------------------------------------------------------

/**
 * The projected blog row metadata resolution needs.
 *
 * `status`, `visibility` and `isHidden` are present because the module has to
 * DECIDE with them — whether the page exists for an anonymous visitor, and
 * whether it may be indexed. They never reach the response.
 */
export interface BlogSeoSource {
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  coverImage: string | null;
  status: BlogStatus;
  visibility: BlogVisibility;
  isHidden: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
  authorId: string;
  /** The stored overrides, or null when the author set none. */
  seo: {
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalUrl: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    twitterCard: string | null;
  } | null;
  author: {
    id: string;
    username: string;
    name: string;
    avatar: string | null;
    bio: string | null;
    status: string;
    /** From `DeveloperProfile.x`, used to derive `twitter:creator`. */
    x: string | null;
  };
  categories: { name: string; slug: string }[];
  tags: { name: string; slug: string }[];
  /** The linked Media row's public URL, preferred over the denormalized column. */
  coverSecureUrl: string | null;
}

export interface AuthorSeoSource {
  id: string;
  username: string;
  name: string;
  bio: string | null;
  avatar: string | null;
  status: string;
  /** `UserSettings.isPrivate` — the profile page's own indexability gate. */
  isPrivate: boolean;
  x: string | null;
  /**
   * The external profiles the author put on their own developer profile, raw.
   * Scheme-checked at resolution before any of them reaches `sameAs`.
   */
  socialLinks: (string | null)[];
  createdAt: Date;
  /** Count of the author's syndicatable posts. Drives thin-page handling. */
  publicPostCount: number;
  /** Newest publication instant across those posts, for `lastmod`. */
  lastPublishedAt: Date | null;
}

export interface TermSeoSource {
  id: string;
  name: string;
  slug: string;
  /** Eligible posts carrying this term. Zero means the page has nothing on it. */
  publicPostCount: number;
  lastPublishedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

/**
 * The sitemap sections, each served by its own chunked child sitemap.
 *
 * Split by where their contents come from, because the two kinds behave
 * differently everywhere downstream:
 *
 *   STATIC   `pages` — the platform's own fixed public pages. Today that is the
 *            home page alone. It exists as a section rather than being tacked
 *            onto another one because a sitemap INDEX may contain only
 *            sitemaps, never URLs, so the home page needs a `<urlset>` of its
 *            own to live in. Never queried, never chunked past page 1.
 *
 *   DYNAMIC  everything backed by rows, chunked and counted by the repository.
 */
export const STATIC_SITEMAP_SECTIONS = ['pages'] as const;
export const DYNAMIC_SITEMAP_SECTIONS = ['blogs', 'authors', 'categories', 'tags'] as const;

export const SITEMAP_SECTIONS = [
  ...STATIC_SITEMAP_SECTIONS,
  ...DYNAMIC_SITEMAP_SECTIONS,
] as const;

export type StaticSitemapSection = (typeof STATIC_SITEMAP_SECTIONS)[number];
export type DynamicSitemapSection = (typeof DYNAMIC_SITEMAP_SECTIONS)[number];
export type SitemapSection = (typeof SITEMAP_SECTIONS)[number];

/** One `<url>` entry. `lastmod` is omitted when nothing truthful is known. */
export interface SitemapEntry {
  loc: string;
  lastmod: Date | null;
  changefreq: string | null;
  priority: number | null;
}

/** One `<sitemap>` entry in the index document. */
export interface SitemapIndexEntry {
  loc: string;
  lastmod: Date | null;
}

/** A rendered sitemap or robots document, with what HTTP caching needs. */
export interface RenderedDocument {
  body: string;
  contentType: string;
  etag: string;
  lastModified: Date | null;
}
