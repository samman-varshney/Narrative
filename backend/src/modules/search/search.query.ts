import { AppError } from '../../core/exceptions/AppError';
import type { NormalizedQuery } from './search.types';

/**
 * Query normalization — the single place a raw user string becomes something
 * the rest of the module is allowed to touch.
 *
 * Normalization is a security control as much as a relevance one:
 *
 *   - it bounds query length, so nobody can hand the trigram matcher a 1 MB
 *     string and make every candidate row pay for it;
 *   - it bounds token count, so `websearch_to_tsquery` cannot be handed a
 *     200-term disjunction;
 *   - it escapes LIKE metacharacters, so a user-supplied `%` becomes a literal
 *     percent sign instead of a leading wildcard that disables every index.
 *
 * SQL injection is NOT among the things normalization defends against — every
 * value reaches Postgres as a bind parameter. Escaping here is about keeping
 * `LIKE` patterns anchored, nothing more.
 */

/** Longest accepted query. Anything above this is rejected, not truncated. */
export const MAX_QUERY_LENGTH = 128;

/** Shortest accepted query. One character is a legitimate typeahead prefix. */
export const MIN_QUERY_LENGTH = 1;

/** Tokens beyond this are dropped — the tail of a very long query adds noise. */
export const MAX_QUERY_TOKENS = 12;

/**
 * Control characters (including NUL) and Unicode format characters. Stripped
 * because they are invisible, break cache-key equality for queries that look
 * identical to a human, and have no business in a search term.
 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;

/** Every character `LIKE` treats specially, plus the escape character itself. */
const LIKE_METACHARACTERS = /[\\%_]/g;

/**
 * Escapes a string for use inside a `LIKE` pattern with `ESCAPE '\'`.
 *
 * Order matters: the backslash must be handled in the same pass as `%` and `_`,
 * otherwise escaping `%` first would produce `\%` and a second pass over
 * backslashes would turn it into `\\%` — a literal backslash followed by a live
 * wildcard.
 */
export function escapeLike(value: string): string {
  return value.replace(LIKE_METACHARACTERS, (char) => `\\${char}`);
}

/**
 * Normalizes a raw query string, or throws a 400.
 *
 * NFKC is applied before anything else so visually identical inputs collapse to
 * one form — without it, a full-width "ｊａｖａ" and "java" would be different
 * cache keys, different history entries, and different popularity counters.
 */
export function normalizeQuery(input: string): NormalizedQuery {
  const cleaned = (input ?? '')
    .normalize('NFKC')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < MIN_QUERY_LENGTH) {
    throw new AppError('Search query is required', 400, 'INVALID_SEARCH_QUERY');
  }
  if (cleaned.length > MAX_QUERY_LENGTH) {
    throw new AppError(
      `Search query must be at most ${MAX_QUERY_LENGTH} characters`,
      400,
      'INVALID_SEARCH_QUERY'
    );
  }

  const tokens = cleaned.split(' ').slice(0, MAX_QUERY_TOKENS);
  const raw = tokens.join(' ');
  const normalized = raw.toLowerCase();

  return {
    raw,
    normalized,
    prefixPattern: `${escapeLike(normalized)}%`,
    tokens,
  };
}

/**
 * True when a query is long enough for a trigram index to be usable at all.
 *
 * pg_trgm builds three-character grams, so a one- or two-character query
 * produces only padded prefix grams and the index degrades badly. Callers use
 * this to skip fuzzy matching entirely for short queries, which the anchored
 * prefix B-tree already serves better.
 */
export function supportsTrigram(query: NormalizedQuery): boolean {
  return query.normalized.length >= 3;
}
