import { editorParser } from '../providers/editor/TiptapParser';
import { sanitizePlainText } from './sanitizeText';

/**
 * Turning untrusted, possibly-marked-up input into short, safe display text.
 *
 * Both functions started as private helpers in `rss.content.ts` and moved here
 * when the SEO module needed exactly the same two steps to build a meta
 * description. They are the same problem — an author's raw string on its way
 * into a document a stranger's software will parse — and two copies of a
 * truncation rule is two places for an off-by-one to hide.
 */

/**
 * Reduces one untrusted string to safe, single-line plain text.
 *
 * Three steps, each closing a different hole: strip markup and the contents of
 * script/style elements (`sanitizePlainText`), collapse every run of whitespace
 * — including the newlines and tabs that would otherwise reproduce a document's
 * layout inside an XML element or a meta tag — and trim.
 *
 * Returns an empty string for null/undefined, so callers can treat "nothing
 * usable" and "absent" identically.
 */
export function toPlainText(value: string | null | undefined): string {
  if (!value) return '';
  return sanitizePlainText(value).replace(/\s+/g, ' ').trim();
}

/**
 * Shortens to `max` characters at a word boundary, with an ellipsis.
 *
 * Cutting mid-word looks like corruption in a feed reader or a search snippet,
 * so the last space inside the budget wins — unless there is no space anywhere
 * near the end (a long URL, a language that does not space-separate), in which
 * case a hard cut is better than returning the whole thing.
 *
 * The ellipsis is a single character, so the result never exceeds `max`.
 */
export function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;

  const window = value.slice(0, max - 1);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? window.slice(0, lastSpace) : window;
  return `${cut.trimEnd()}…`;
}

/**
 * Plain text from a stored editor document, defensively.
 *
 * `Blog.content` is a `Json?` column, so a row written by an older revision —
 * or by hand — can hold anything at all. A throw here would take down a whole
 * feed over one bad post, or a whole page render over one bad body, which is
 * the failure mode both the RSS and SEO modules are built to avoid; returning
 * empty text degrades that one description to "absent" instead.
 *
 * Delegates to `editorParser`, the platform's single editor abstraction. No
 * caller of this function knows what Tiptap is, which is the point: a second
 * parser would be a second thing to keep in step with the editor's schema.
 */
export function plainTextFromEditorDocument(content: unknown): string {
  if (content === null || content === undefined) return '';
  try {
    return editorParser.extractMetadata(content).plainText;
  } catch {
    return '';
  }
}
