import sanitizeHtml from 'sanitize-html';

/**
 * Reduces an untrusted string to safe plain text: strips ALL HTML tags and
 * attributes (no markup is preserved), decodes nothing back into markup, and
 * trims surrounding whitespace. Used for user-authored plain-text content such
 * as comments to neutralize XSS / HTML-injection vectors before persistence.
 */
export function sanitizePlainText(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    // Drop the *contents* of tags like <script>/<style> too, not just the tags.
    disallowedTagsMode: 'discard',
  }).trim();
}
