/**
 * URL-slug helpers, shared across the Blog module (blog slugs, tag slugs,
 * category slugs).
 *
 * Uniqueness is NOT handled here — the caller (repository) resolves collisions
 * against the database using incremental numbering (`base`, `base-2`, `base-3`,
 * …). See `nextIncrementalSlug` for the pure numbering logic and
 * `BlogRepository.generateUniqueSlug` for the DB-backed wrapper.
 */

/** Maximum slug length (characters) before the trailing numeric suffix. */
export const MAX_SLUG_LENGTH = 80;

// Unicode combining diacritical marks (left over after NFKD normalization).
// `\p{Diacritic}` (u-flag) avoids embedding literal combining chars in source.
const COMBINING_MARKS = /\p{Diacritic}/gu;

/**
 * Converts arbitrary text into a URL-safe slug:
 * lowercase, accents stripped, non-alphanumerics collapsed to single dashes,
 * leading/trailing dashes trimmed, capped at MAX_SLUG_LENGTH.
 *
 * Falls back to `'untitled'` when the input reduces to an empty string (e.g.
 * a title made entirely of emoji or punctuation), so a valid slug is always
 * produced.
 */
export function slugify(text: string): string {
  const slug = (text ?? '')
    .normalize('NFKD') // split accented chars into base + combining mark
    .replace(COMBINING_MARKS, '') // strip the combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumerics → dash
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // re-trim if the slice landed on a dash

  return slug || 'untitled';
}

/**
 * Given the base slug and the set of slugs already taken (that share the base),
 * returns the lowest-numbered free slug: the bare `base` if available, else
 * `base-2`, `base-3`, … No random suffixes.
 *
 * @param base   the slugified base (output of `slugify`)
 * @param taken  slugs already in use that equal `base` or start with `base-`
 */
export function nextIncrementalSlug(base: string, taken: Iterable<string>): string {
  const takenSet = taken instanceof Set ? taken : new Set(taken);
  if (!takenSet.has(base)) return base;

  let n = 2;
  while (takenSet.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
