import {
  plainTextFromEditorDocument,
  toPlainText,
  truncateAtWord,
} from '../../core/utils/text';
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
  return Boolean(toPlainText(sources.metaDescription) || toPlainText(sources.subtitle));
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
  const seo = toPlainText(sources.metaDescription);
  if (seo) return truncateAtWord(seo, MAX_DESCRIPTION_LENGTH);

  const subtitle = toPlainText(sources.subtitle);
  if (subtitle) return truncateAtWord(subtitle, MAX_DESCRIPTION_LENGTH);

  const body = toPlainText(plainTextFromEditorDocument(sources.content));
  return body ? truncateAtWord(body, MAX_DESCRIPTION_LENGTH) : null;
}

/**
 * `toPlainText`, `truncateAtWord` and `plainTextFromEditorDocument` live in
 * `core/utils/text.ts`.
 *
 * They were private to this file until the SEO module needed the identical two
 * steps to build a meta description — the same problem, an author's raw string
 * on its way into a document a stranger's software will parse. See that file.
 */
