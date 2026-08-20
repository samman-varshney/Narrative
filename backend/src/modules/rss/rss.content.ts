import { editorParser } from '../../core/providers/editor/TiptapParser';
import { sanitizePlainText } from '../../core/utils/sanitizeText';
import { MAX_DESCRIPTION_LENGTH } from './rss.config';

/**
 * Turning a stored blog into a safe, human-readable `<description>`.
 *
 * ── This module owns no rich-text knowledge ─────────────────────────────────
 * Not one line here understands Tiptap. The document is handed to
 * `editorParser` — the platform's single editor abstraction, the same one the
 * Blog module uses to derive reading time, word counts and its own SEO
 * description — and what comes back is plain text. A second parser living here
 * would be a second thing to keep in step with the editor's schema, and the
 * first place a node type nobody remembered would leak raw JSON into a public
 * document.
 *
 * The same reasoning applies to sanitization: `sanitizePlainText` is the
 * platform's existing "reduce untrusted input to text" utility, and it is used
 * on EVERY source below rather than only on the ones that look risky. Subtitles
 * and SEO descriptions are stored raw — `blog.validator.ts` bounds their length
 * and nothing more — so an author can put markup in either, and only one of the
 * three sources has been through the editor's own escaping.
 *
 * ── Why the output is plain text and not HTML ───────────────────────────────
 * RSS allows escaped HTML in a description, and richer feeds use it. Narrative
 * does not have a Tiptap-to-HTML renderer, and writing one HERE would be
 * exactly the "second rich-text system" this module must not contain — it would
 * also mean the platform had two answers to how a post renders, one of which
 * nobody looks at. Plain text is honest, cannot carry an injection, and is what
 * every reader can display. If HTML bodies are ever wanted, the right change is
 * an HTML serializer on `IEditorParser`, used by both the web client and this
 * module. See RSS_MODULE.md § Extension points.
 */

/** The sources a description may be derived from, in preference order. */
export interface DescriptionSources {
  /** `BlogSEO.metaDescription` — the author's own summary of the post. */
  metaDescription: string | null;
  /** The post's subtitle. */
  subtitle: string | null;
  /** The Tiptap document, when one was loaded. */
  content?: unknown;
}

/**
 * Whether a description can be produced without loading the (heavy) body.
 *
 * The service uses this to decide which rows need a second query at all — the
 * difference between parsing twenty Tiptap documents and parsing none. Cheap,
 * total, and deliberately the same precedence test the derivation below applies.
 */
export function hasCheapDescription(sources: {
  metaDescription: string | null;
  subtitle: string | null;
}): boolean {
  return Boolean(clean(sources.metaDescription) || clean(sources.subtitle));
}

/**
 * Derives an item description.
 *
 * Precedence — SEO summary, then subtitle, then the body — mirrors
 * `blogService.effectiveSeo` exactly, so what a feed says about a post and what
 * an Open Graph card says about it cannot disagree. The author's explicit
 * summary wins wherever they wrote one; the body is the fallback for the many
 * posts where they did not.
 *
 * Returns `null` rather than an empty string when there is genuinely nothing to
 * say, so the renderer can omit the element instead of emitting a blank one.
 */
export function deriveDescription(sources: DescriptionSources): string | null {
  const seo = clean(sources.metaDescription);
  if (seo) return truncate(seo, MAX_DESCRIPTION_LENGTH);

  const subtitle = clean(sources.subtitle);
  if (subtitle) return truncate(subtitle, MAX_DESCRIPTION_LENGTH);

  const body = clean(extractPlainText(sources.content));
  return body ? truncate(body, MAX_DESCRIPTION_LENGTH) : null;
}

/**
 * Plain text from a stored editor document.
 *
 * Defensive around the parser rather than trusting it: `content` is a `Json?`
 * column, so a row written by an older revision — or by hand — can hold
 * anything at all. A throw here would take down a whole feed over one bad post,
 * which is the failure mode `rss.service` is built to avoid; returning empty
 * text degrades that one item to "no description" instead.
 */
function extractPlainText(content: unknown): string {
  if (content === null || content === undefined) return '';
  try {
    return editorParser.extractMetadata(content).plainText;
  } catch {
    return '';
  }
}

/**
 * Reduces one untrusted string to safe, single-line plain text.
 *
 * Three steps, each closing a different hole: strip markup and the contents of
 * script/style elements (`sanitizePlainText`), collapse every run of whitespace
 * — including the newlines and tabs that would otherwise reproduce a post's
 * layout inside an XML element — and trim.
 */
function clean(value: string | null | undefined): string {
  if (!value) return '';
  return sanitizePlainText(value).replace(/\s+/g, ' ').trim();
}

/**
 * Shortens to `max` characters at a word boundary, with an ellipsis.
 *
 * Cutting mid-word looks like corruption in a feed reader, so the last space
 * inside the budget wins — unless there is no space anywhere near the end (a
 * long URL, a language that does not space-separate), in which case a hard cut
 * is better than returning the whole thing.
 *
 * The ellipsis is a single character, so the result never exceeds `max`.
 */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;

  const window = value.slice(0, max - 1);
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? window.slice(0, lastSpace) : window;
  return `${cut.trimEnd()}…`;
}
