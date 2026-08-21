/**
 * XML escaping — the platform's single injection boundary for XML documents.
 *
 * Written for the RSS renderer and moved here when the SEO module began
 * emitting sitemaps: two modules serializing user-controlled strings into XML
 * is exactly the situation in which a second, subtly weaker escaper gets
 * written. There is one, it handles the cases that are easy to miss, and both
 * modules apply it through helpers rather than at each call site.
 */

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
