import { truncateAtWord } from '../../core/utils/text';
import { homeUrl } from '../../core/utils/publicUrls';
import { siteName } from './seo.config';
import type { BreadcrumbItem, StructuredDataNode } from './seo.types';

/**
 * Schema.org structured data — JSON-LD nodes describing what a page actually
 * shows.
 *
 * ── The rule every builder here follows ─────────────────────────────────────
 * A node states only what the platform KNOWS and the page DISPLAYS. There is no
 * rating, no interaction count, no `wordCount` inflated from a draft, no
 * `publisher.logo` invented from the social preview image. Structured data that
 * describes something other than the visible page is exactly what search
 * engines penalise, and — more to the point — it is a claim the platform cannot
 * back up.
 *
 * That is also why absent values are OMITTED rather than emitted as null or an
 * empty string. `"datePublished": null` is not "unknown", it is a malformed
 * claim; leaving the property out is the correct way to say nothing.
 *
 * ── Only the types the pages really are ─────────────────────────────────────
 *   BlogPosting     a post. `BlogPosting` rather than the broader `Article`
 *                   because that is precisely what it is, and the narrower type
 *                   is the more useful statement. `BlogPosting` is a subtype of
 *                   `Article`, so nothing that understands `Article` is lost.
 *   ProfilePage     an author page, carrying a `Person` as its main entity.
 *   CollectionPage  a category or tag page — a list of items about a subject,
 *                   which is what `CollectionPage` means.
 *   WebSite         the platform itself, emitted on the home page.
 *   BreadcrumbList  the trail, on every page that has one.
 *
 * ── Escaping is not this file's job ─────────────────────────────────────────
 * These builders return plain objects. Making them safe to embed in an HTML
 * `<script>` element is `seo.serializer.renderJsonLd`'s responsibility, and it
 * is done in exactly one place — see the note there about `</script>`.
 */

const SCHEMA_CONTEXT = 'https://schema.org';

/**
 * Longest `headline` a node will carry.
 *
 * Google's structured-data documentation caps `headline` at 110 characters and
 * ignores nodes that exceed it, while `Blog.title` permits 200. Truncating at a
 * word boundary keeps the node valid; the untruncated title is still the page's
 * `<title>` and `og:title`, so nothing is lost to a human reader.
 */
const MAX_HEADLINE_LENGTH = 110;

/** Drops properties with no value, so a node never claims `null`. */
function compact(node: Record<string, unknown>): StructuredDataNode {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    result[key] = value;
  }
  return result;
}

/** ISO-8601, or undefined for an absent or unusable date. */
function isoDate(date: Date | null | undefined): string | undefined {
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * The platform as a publisher.
 *
 * `Organization` with a name and a URL, and nothing else. Google once required
 * a `logo` here and no longer does; inventing one from `SEO_DEFAULT_IMAGE`
 * would be stating that the social preview image is the platform's logo, which
 * is a different claim and probably a false one.
 */
export function buildPublisher(): StructuredDataNode {
  return compact({
    '@type': 'Organization',
    name: siteName(),
    url: homeUrl(),
  });
}

/** A person, as an author or as a profile page's subject. */
export function buildPerson(author: {
  name: string;
  profileUrl: string;
  description?: string | null;
  image?: string | null;
  sameAs?: (string | null)[];
}): StructuredDataNode {
  return compact({
    '@type': 'Person',
    name: author.name,
    url: author.profileUrl,
    description: author.description ?? undefined,
    image: author.image ?? undefined,
    // `sameAs` is the standard way to state "this is the same person as that
    // external profile". Only links the platform stores and has scheme-checked
    // reach it — see `seo.resolver`.
    sameAs: (author.sameAs ?? []).filter((value): value is string => Boolean(value)),
  });
}

/** A post. */
export function buildBlogPosting(post: {
  title: string;
  description: string | null;
  canonicalUrl: string;
  image: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  author: { name: string; profileUrl: string };
  keywords: string[];
  section: string | null;
}): StructuredDataNode {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'BlogPosting',
    headline: truncateAtWord(post.title, MAX_HEADLINE_LENGTH),
    description: post.description ?? undefined,
    // `mainEntityOfPage` states which page this node is ABOUT — the canonical
    // one. Without it a node syndicated onto another page describes that page
    // instead, which is how a cross-post ends up competing with its original.
    mainEntityOfPage: { '@type': 'WebPage', '@id': post.canonicalUrl },
    url: post.canonicalUrl,
    image: post.image ?? undefined,
    datePublished: isoDate(post.publishedAt),
    dateModified: isoDate(post.updatedAt),
    author: buildPerson({ name: post.author.name, profileUrl: post.author.profileUrl }),
    publisher: buildPublisher(),
    keywords: post.keywords,
    articleSection: post.section ?? undefined,
  });
}

/** An author page. */
export function buildProfilePage(profile: {
  canonicalUrl: string;
  person: StructuredDataNode;
  createdAt: Date | null;
}): StructuredDataNode {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'ProfilePage',
    url: profile.canonicalUrl,
    mainEntity: profile.person,
    // When the profile came into existence. Honest, and the one date a profile
    // page genuinely has — `dateModified` would need a definition of "the
    // profile changed" that the platform does not record.
    dateCreated: isoDate(profile.createdAt),
  });
}

/** A category or tag page: a collection of posts about one subject. */
export function buildCollectionPage(collection: {
  name: string;
  description: string | null;
  canonicalUrl: string;
  updatedAt: Date | null;
}): StructuredDataNode {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'CollectionPage',
    name: collection.name,
    description: collection.description ?? undefined,
    url: collection.canonicalUrl,
    dateModified: isoDate(collection.updatedAt),
    isPartOf: { '@type': 'WebSite', name: siteName(), url: homeUrl() },
  });
}

/**
 * The platform itself.
 *
 * No `potentialAction`/`SearchAction` node, even though the platform has a
 * search endpoint. That markup asks a search engine to render a sitelinks
 * search box pointing at a public search URL, and the platform's search lives
 * behind `/api/v1/search` with no public page to send a visitor to. Claiming
 * one would be the fabrication this file exists to avoid; it becomes correct
 * the day a public `/search` page exists.
 */
export function buildWebSite(): StructuredDataNode {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'WebSite',
    name: siteName(),
    url: homeUrl(),
    publisher: buildPublisher(),
  });
}

/**
 * The trail, as `BreadcrumbList`.
 *
 * `position` is 1-based, per the specification. An empty trail produces no node
 * at all — a breadcrumb list with one item describes no hierarchy and is noise
 * in the markup.
 */
export function buildBreadcrumbList(items: BreadcrumbItem[]): StructuredDataNode | null {
  if (items.length < 2) return null;

  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
