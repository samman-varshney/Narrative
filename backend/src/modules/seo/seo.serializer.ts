import { escapeXml } from '../../core/utils/xml';
import type {
  ResolvedMetadata,
  SitemapEntry,
  SitemapIndexEntry,
  StructuredDataNode,
} from './seo.types';

/**
 * Serialization: resolved metadata in, bytes out.
 *
 * Three output formats, and they are together in one file because they share
 * exactly one property that matters — every string that reaches them is
 * user-controlled, and none of them may let it become markup.
 *
 *   SITEMAP XML   `<urlset>` and `<sitemapindex>`, per the sitemaps.org 0.9
 *                 protocol.
 *   JSON-LD       the structured-data nodes, escaped for embedding in a
 *                 `<script>` element.
 *   HEAD TAGS     a ready-to-inject HTML `<head>` fragment.
 *
 * ── Why there is no XML or template library ─────────────────────────────────
 * Each document is a fixed shape a few dozen lines long, and every string
 * entering one goes through `escapeXml` — the platform's single XML injection
 * boundary, shared with the RSS renderer. A serializer dependency would add a
 * supply-chain surface and an upgrade treadmill in exchange for indentation.
 * What matters is that escaping is not optional, so it is applied by the
 * element helpers below rather than at each call site, and the tests assert on
 * hostile titles rather than on the helper.
 *
 * ── Determinism is a requirement, not a nicety ──────────────────────────────
 * Every function here is pure: given the same input it returns byte-identical
 * output, and no clock, locale or environment is read. ETags are hashes of this
 * output, so any non-determinism would mint a new validator on every
 * regeneration and turn HTTP caching off for everyone without anything failing.
 */

const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

/**
 * W3C Datetime, as the sitemap protocol requires for `<lastmod>`.
 *
 * `toISOString()` with the milliseconds removed. Fractional seconds are legal
 * ISO 8601 and every major crawler accepts them, but they say nothing a
 * `lastmod` needs and several validators flag them — so they are dropped rather
 * than defended.
 *
 * An invalid `Date` yields `null` and the caller omits the element, rather than
 * writing the literal string "Invalid Date" into a public document.
 */
export function toW3CDate(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

/**
 * A `<urlset>` document.
 *
 * `<loc>` is the only required child. `<lastmod>`, `<changefreq>` and
 * `<priority>` are omitted when absent rather than emitted empty — an empty
 * `<lastmod/>` is a malformed claim, while a missing one correctly says
 * "unknown".
 */
export function renderUrlSet(entries: SitemapEntry[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${SITEMAP_NAMESPACE}">`,
  ];

  for (const entry of entries) {
    lines.push('  <url>');
    lines.push(el(2, 'loc', entry.loc));

    const lastmod = toW3CDate(entry.lastmod);
    if (lastmod) lines.push(el(2, 'lastmod', lastmod));
    if (entry.changefreq) lines.push(el(2, 'changefreq', entry.changefreq));
    if (entry.priority !== null) {
      // One decimal place, which is the protocol's whole resolution: priority
      // is a number between 0.0 and 1.0 and `0.8000000000000001` is what
      // floating point does to a config value.
      lines.push(el(2, 'priority', entry.priority.toFixed(1)));
    }

    lines.push('  </url>');
  }

  lines.push('</urlset>', '');
  return lines.join('\n');
}

/** A `<sitemapindex>` document — the list of child sitemaps. */
export function renderSitemapIndex(entries: SitemapIndexEntry[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sitemapindex xmlns="${SITEMAP_NAMESPACE}">`,
  ];

  for (const entry of entries) {
    lines.push('  <sitemap>');
    lines.push(el(2, 'loc', entry.loc));

    const lastmod = toW3CDate(entry.lastmod);
    if (lastmod) lines.push(el(2, 'lastmod', lastmod));

    lines.push('  </sitemap>');
  }

  lines.push('</sitemapindex>', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/**
 * Structured data, serialized for embedding inside a `<script>` element.
 *
 * ── The escaping is the entire point of this function ───────────────────────
 * `JSON.stringify` produces a valid JSON document and an UNSAFE script body. An
 * HTML parser does not parse the contents of a `<script>` element as JSON — it
 * scans for the literal string `</script`, and ends the element there. So a
 * blog title of `</script><img src=x onerror=alert(1)>` survives
 * `JSON.stringify` intact, closes the element early, and executes on every page
 * that renders the post. It is stored XSS delivered through metadata.
 *
 * Escaping `<` and `>` as `\u003c` and `\u003e` makes that closing sequence
 * unrepresentable. `&` is escaped alongside them so the payload cannot be
 * reconstituted by HTML entity decoding in a context that applies it, and
 * U+2028/U+2029 — legal in JSON, illegal unescaped in JavaScript source before
 * ES2019 — are escaped so an older parser cannot choke on a document a newer
 * one accepts.
 *
 * All four remain valid JSON: `\uXXXX` is how JSON spells a character.
 */
export function renderJsonLd(nodes: StructuredDataNode[]): string {
  return JSON.stringify(nodes.length === 1 ? nodes[0] : nodes)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------------------------------------------------------------------------
// HTML head
// ---------------------------------------------------------------------------

/**
 * The complete `<head>` metadata for a page, as an HTML fragment.
 *
 * ── Why the backend renders HTML at all ─────────────────────────────────────
 * The API's primary form is JSON — `ResolvedMetadata`, which a frontend maps to
 * whatever its own head-management library expects. This exists beside it so
 * that a consumer which just needs correct tags does not have to re-implement
 * the one part of the job that is genuinely dangerous: escaping. A template
 * that interpolates a title into `<meta content="...">` without escaping the
 * quote is a two-line mistake, and it is a mistake that ships stored XSS to
 * every visitor.
 *
 * One implementation, tested against hostile input, is better than each
 * consumer's own. See SEO_MODULE.md § Frontend integration.
 *
 * Every value passes through `escapeXml`, which escapes all five predefined
 * entities — including `"` and `'`, the attribute delimiters. The tags are
 * emitted as self-closing XHTML-style elements, which HTML5 parses correctly
 * and which JSX-based renderers accept verbatim.
 */
export function renderHeadTags(metadata: ResolvedMetadata): string {
  const lines: string[] = [
    `<title>${escapeXml(metadata.title)}</title>`,
    meta('name', 'robots', metadata.robots.directive),
    `<link rel="canonical" href="${escapeXml(metadata.canonicalUrl)}" />`,
  ];

  if (metadata.description) lines.push(meta('name', 'description', metadata.description));

  const og = metadata.openGraph;
  lines.push(
    meta('property', 'og:type', og.type),
    meta('property', 'og:site_name', og.siteName),
    meta('property', 'og:title', og.title),
    meta('property', 'og:url', og.url)
  );
  if (og.description) lines.push(meta('property', 'og:description', og.description));
  if (og.image) lines.push(meta('property', 'og:image', og.image));

  if (og.article) {
    const { publishedTime, modifiedTime, author, section, tags } = og.article;
    if (publishedTime) lines.push(meta('property', 'article:published_time', publishedTime));
    if (modifiedTime) lines.push(meta('property', 'article:modified_time', modifiedTime));
    if (author) lines.push(meta('property', 'article:author', author));
    if (section) lines.push(meta('property', 'article:section', section));
    // One element per tag, which is how Open Graph spells an array.
    for (const tag of tags) lines.push(meta('property', 'article:tag', tag));
  }

  if (og.profile) lines.push(meta('property', 'profile:username', og.profile.username));

  const twitter = metadata.twitter;
  lines.push(
    meta('name', 'twitter:card', twitter.card),
    meta('name', 'twitter:title', twitter.title)
  );
  if (twitter.description) lines.push(meta('name', 'twitter:description', twitter.description));
  if (twitter.image) lines.push(meta('name', 'twitter:image', twitter.image));
  if (twitter.site) lines.push(meta('name', 'twitter:site', twitter.site));
  if (twitter.creator) lines.push(meta('name', 'twitter:creator', twitter.creator));

  if (metadata.structuredData.length > 0) {
    lines.push(
      `<script type="application/ld+json">${renderJsonLd(metadata.structuredData)}</script>`
    );
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** One escaped element on its own line, at `depth` levels of two-space indent. */
function el(depth: number, name: string, value: string): string {
  return `${'  '.repeat(depth)}<${name}>${escapeXml(value)}</${name}>`;
}

/** One `<meta>` tag. `key` is `name` or `property`, per the tag's own spec. */
function meta(key: 'name' | 'property', value: string, content: string): string {
  return `<meta ${key}="${escapeXml(value)}" content="${escapeXml(content)}" />`;
}
