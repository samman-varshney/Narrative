import { HTTP_MAX_AGE_SECONDS, RSS_CONTENT_TYPE, RSS_MEDIA_TYPE } from './rss.config';
import type { SyndicationDocument, SyndicationItem } from './rss.types';

/**
 * Serialization: a `SyndicationDocument` in, bytes out.
 *
 * ── The abstraction, and why it is this thin ────────────────────────────────
 * `IFeedRenderer` exists so the module can grow a second distribution format
 * without any of the querying, eligibility, caching or invalidation beneath it
 * moving. It has exactly three members — the format's name, its content type,
 * and `render` — because that is genuinely all a format differs by once the
 * document above it is format-agnostic. An interface with more would be
 * speculating about a format nobody has written yet.
 *
 * Only RSS 2.0 is implemented, and only RSS 2.0 is wired up. Atom and JSON Feed
 * are deliberately NOT built (see RSS_MODULE.md § Extension points): what is
 * built is the seam they would drop into.
 *
 * ── No XML library ──────────────────────────────────────────────────────────
 * The document is a fixed shape roughly forty lines long, and every string
 * entering it goes through `escapeXml`. A serializer dependency would add a
 * supply-chain surface and an upgrade treadmill in exchange for indentation.
 * What matters is that escaping is not optional — so it is applied by the
 * `el` helper and the attribute writers rather than at each call site, and the
 * tests assert on hostile titles rather than on the helper.
 *
 * ── Determinism is a requirement, not a nicety ──────────────────────────────
 * `render` is a pure function: given the same document it returns byte-identical
 * output, and no clock, locale or environment is read. The ETag is a hash of
 * this output, so any non-determinism here would make every regeneration mint a
 * new validator and turn HTTP caching off for everyone without anything
 * failing. That is why `lastBuildDate` is a field on the channel — derived from
 * the data in `rss.service` — rather than `new Date()` taken here.
 */

/** The distribution formats this module could serve. Only `rss2.0` exists. */
export type FeedFormat = 'rss2.0';

export interface IFeedRenderer {
  readonly format: FeedFormat;
  /** The exact `Content-Type` a response carrying this format must declare. */
  readonly contentType: string;
  render(document: SyndicationDocument): string;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * Characters XML 1.0 forbids outright — not "should be escaped", but cannot
 * appear in a conforming document in any form, escaped or not: the C0 controls
 * other than tab, newline and carriage return, plus the two non-characters at
 * the end of the BMP.
 *
 * They matter because blog titles, tag names and display names are
 * user-controlled and are NOT stripped of control characters anywhere upstream:
 * `blog.validator.ts` bounds length, and that is all. A single U+0000 in a title
 * would make the entire feed unparseable for every subscriber — one post's
 * content breaking the whole channel, which is precisely the failure mode this
 * module is required to prevent.
 */
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * Surrogate code units with no partner.
 *
 * A lone surrogate is not a character at all, and a UTF-8 encoder cannot
 * represent it — Node emits U+FFFD, but an XML parser at the other end may
 * simply reject the document. They reach a string here through truncation of an
 * emoji or an astral-plane script, which `rss.content` can do because
 * JavaScript string indexes are code UNITS rather than code points. Removed
 * rather than replaced.
 */
const LONE_SURROGATES =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escapes one untrusted string for use as XML text or as an attribute value.
 *
 * All five predefined entities, including `"` and `'`, because the same
 * function serves both positions and an attribute delimiter left unescaped is
 * how a `url="..."` becomes two attributes. `&` is replaced FIRST — reversing
 * the order would re-escape the ampersands introduced by the later
 * replacements and turn `<` into `&amp;lt;`.
 *
 * This is the module's single injection boundary. Every title, description,
 * name, tag, URL and identifier passes through it on its way into the document;
 * the tests assert that with hostile input rather than by inspection.
 */
export function escapeXml(value: string): string {
  return value
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(LONE_SURROGATES, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * RFC 822 date-time, as RSS 2.0 requires for `pubDate` and `lastBuildDate`.
 *
 * `toUTCString()` produces `Wed, 02 Oct 2002 13:00:00 GMT` — RFC 1123's
 * four-digit-year form of RFC 822, which the RSS specification explicitly
 * permits and every reader accepts. It is also byte-identical to the HTTP-date
 * format, so the `Last-Modified` header and the `lastBuildDate` element cannot
 * disagree about an instant.
 *
 * An invalid `Date` yields `null` and the caller omits the element, rather than
 * writing the literal string "Invalid Date" into a public document.
 */
export function toRfc822(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toUTCString();
}

/** ISO-8601, for the Atom-namespaced `updated` element. */
function toIso(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// RSS 2.0
// ---------------------------------------------------------------------------

const RSS_NAMESPACES = [
  'xmlns:atom="http://www.w3.org/2005/Atom"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
].join(' ');

/** Where a curious consumer finds the format this document claims to be. */
const SPEC_URL = 'https://www.rssboard.org/rss-specification';

export class Rss20Renderer implements IFeedRenderer {
  readonly format: FeedFormat = 'rss2.0';
  readonly contentType = RSS_CONTENT_TYPE;

  render(document: SyndicationDocument): string {
    const { channel, items } = document;

    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<rss version="2.0" ${RSS_NAMESPACES}>`,
      '  <channel>',
      el(2, 'title', channel.title),
      el(2, 'link', channel.link),
      el(2, 'description', channel.description),
      // `rel="self"` is what tells a reader the feed's own canonical address —
      // required by the feed-validation suites and used by aggregators to
      // deduplicate a feed reached through two different URLs.
      `    <atom:link href="${escapeXml(
        channel.selfUrl
      )}" rel="self" type="${escapeXml(RSS_MEDIA_TYPE)}" />`,
      // The channel's permanent identity, independent of the URL it is served
      // at. RSS 2.0 has no element for this; Atom's `id` is the interoperable
      // spelling and is legal here as a namespaced extension.
      el(2, 'atom:id', channel.id),
      el(2, 'generator', channel.generator),
      el(2, 'docs', SPEC_URL),
      // A polling hint, in minutes, matched to how long the origin will serve
      // the same bytes anyway. Advertising it is the cheapest abuse control the
      // module has: a well-behaved reader stops asking more often than there is
      // anything new to receive.
      el(2, 'ttl', String(Math.max(1, Math.round(HTTP_MAX_AGE_SECONDS / 60)))),
    ];

    if (channel.language) lines.push(el(2, 'language', channel.language));

    const lastBuild = toRfc822(channel.lastBuildDate);
    if (lastBuild) lines.push(el(2, 'lastBuildDate', lastBuild));

    for (const item of items) lines.push(...this.renderItem(item));

    lines.push('  </channel>', '</rss>', '');
    return lines.join('\n');
  }

  private renderItem(item: SyndicationItem): string[] {
    const lines: string[] = [
      '    <item>',
      el(3, 'title', item.title),
      el(3, 'link', item.link),
      // `isPermaLink="false"` because the value is a URN, not something a client
      // may fetch. Omitting the attribute would make readers treat it as a URL —
      // RSS 2.0 defaults it to true — and some would try to resolve it.
      `      <guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
    ];

    if (item.description) lines.push(el(3, 'description', item.description));

    // `dc:creator`, never RSS 2.0's `<author>`: that element is DEFINED as an
    // email address, and the platform does not publish addresses. See
    // RSS_MODULE.md § Security.
    lines.push(el(3, 'dc:creator', item.author.name));

    const published = toRfc822(item.publishedAt);
    if (published) lines.push(el(3, 'pubDate', published));

    // Last modification. RSS 2.0 has no element for it, so this is Atom's —
    // which is what a reader looking for "has this changed since I stored it"
    // already understands.
    const updated = toIso(item.updatedAt);
    if (updated) lines.push(el(3, 'atom:updated', updated));

    for (const category of item.categories) {
      lines.push(el(3, 'category', category.name));
    }

    if (item.enclosure) {
      const { url, mimeType, lengthBytes } = item.enclosure;
      lines.push(
        `      <enclosure url="${escapeXml(url)}" type="${escapeXml(
          mimeType
        )}" length="${escapeXml(String(lengthBytes))}" />`
      );
    }

    lines.push('    </item>');
    return lines;
  }
}

/** One escaped element on its own line, at `depth` levels of two-space indent. */
function el(depth: number, name: string, value: string): string {
  const pad = '  '.repeat(depth);
  return `${pad}<${name}>${escapeXml(value)}</${name}>`;
}

/**
 * The renderer the module serves today.
 *
 * Selected by a constant rather than by configuration, deliberately: there is
 * one format, and a setting whose only legal value is its default is a knob that
 * cannot be turned. Content negotiation is what a second format would arrive
 * with — see RSS_MODULE.md § Extension points.
 */
export const activeFeedRenderer: IFeedRenderer = new Rss20Renderer();
