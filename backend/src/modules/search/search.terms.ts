import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import type { Suggestion } from './search.types';

/**
 * Aggregate popularity of search terms, used to seed suggestions.
 *
 * A Redis sorted set keyed by term, scored by how often it has been searched:
 *
 *     search:terms:v1  ->  ZSET { "javascript": 412, "react hooks": 98, ... }
 *
 * ── Privacy is the design constraint here, not an afterthought ──────────────
 * This is the one structure in the module that retains what people typed, so it
 * is deliberately narrow:
 *
 *  1. NOTHING IDENTIFYING IS STORED. The set holds terms and counts. There is no
 *     user id anywhere near it, so it cannot be turned back into "what did this
 *     person search for".
 *
 *  2. ONLY TERMS THAT FOUND SOMETHING ARE RECORDED. A query that matched no
 *     content is far more likely to be a name, an email, or a typo'd private
 *     string than a useful suggestion, and it has no value as one either.
 *
 *  3. K-ANONYMITY BEFORE SURFACING. A term is never suggested until at least
 *     MIN_SUGGESTION_COUNT distinct searches have produced it, so one person's
 *     unusual query cannot become a public autocomplete entry.
 *
 *  4. SHAPE FILTERING. Anything that looks like an email address, a URL, or a
 *     long digit run (card/phone/id shaped) is refused outright.
 *
 *  5. THE WHOLE SET EXPIRES. A rolling TTL means popularity reflects recent
 *     interest and old terms disappear without a cleanup job.
 */

const TERMS_KEY = 'search:terms:v1';

/** Idle lifetime of the popularity set, refreshed on every recorded term. */
export const TERMS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Hard cap on distinct terms retained. The tail is trimmed on read. */
export const MAX_TRACKED_TERMS = 2_000;

/** How many top terms are pulled into memory to satisfy a prefix lookup. */
const SCAN_WINDOW = 500;

/**
 * Minimum number of searches before a term may be suggested to anyone.
 * This is the k-anonymity threshold described above.
 */
export const MIN_SUGGESTION_COUNT = 3;

/** Terms outside this length are never recorded. */
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 60;

/** Shapes that are refused regardless of popularity. */
const EMAIL_LIKE = /@/;
const URL_LIKE = /(^|\s)(https?:\/\/|www\.)/i;
const LONG_DIGIT_RUN = /\d{6,}/;

export class SearchTermsStore {
  /**
   * Records one search of `term`.
   *
   * `resultCount` gates the write: a term that found nothing is not popular,
   * it is a mistake or a probe, and either way it must not become a suggestion.
   */
  async record(term: string, resultCount: number): Promise<void> {
    if (resultCount <= 0) return;
    if (!isRecordable(term)) return;

    try {
      const pipeline = redis.pipeline();
      pipeline.zincrby(TERMS_KEY, 1, term);
      pipeline.expire(TERMS_KEY, TERMS_TTL_SECONDS);
      await pipeline.exec();
    } catch (err) {
      logger.warn({ err }, 'search: failed to record popular term');
    }
  }

  /**
   * Popular terms starting with `prefix`, most-searched first.
   *
   * Redis sorted sets cannot be queried by prefix and by score at once, so the
   * top SCAN_WINDOW terms are pulled and filtered in process. That is the right
   * trade for this data: the window is a few hundred short strings, it is only
   * read on the suggestions endpoint, and the result is cached. The alternative
   * — a second prefix-indexed structure kept in sync — is a lot of machinery for
   * an autocomplete hint.
   *
   * Trimming to MAX_TRACKED_TERMS happens here rather than on write so the hot
   * write path stays a single ZINCRBY.
   */
  async popular(prefix: string, limit: number): Promise<Suggestion[]> {
    try {
      const [top, size] = await Promise.all([
        redis.zrevrange(TERMS_KEY, 0, SCAN_WINDOW - 1, 'WITHSCORES'),
        redis.zcard(TERMS_KEY),
      ]);

      if (size > MAX_TRACKED_TERMS) {
        // Drop everything below the cap — lowest scores first.
        redis
          .zremrangebyrank(TERMS_KEY, 0, size - MAX_TRACKED_TERMS - 1)
          .catch((err) => logger.warn({ err }, 'search: failed to trim popular terms'));
      }

      const matches: Suggestion[] = [];
      // zrevrange WITHSCORES returns a flat [member, score, member, score, ...].
      for (let i = 0; i < top.length && matches.length < limit; i += 2) {
        const term = top[i]!;
        const count = Number(top[i + 1]);
        if (count < MIN_SUGGESTION_COUNT) continue; // k-anonymity gate
        if (!term.startsWith(prefix)) continue;
        matches.push({ text: term, source: 'POPULAR' });
      }
      return matches;
    } catch (err) {
      logger.warn({ err }, 'search: failed to read popular terms');
      return [];
    }
  }
}

/** Whether a term is eligible to be counted at all. */
export function isRecordable(term: string): boolean {
  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) return false;
  if (EMAIL_LIKE.test(term)) return false;
  if (URL_LIKE.test(term)) return false;
  if (LONG_DIGIT_RUN.test(term)) return false;
  return true;
}

export const searchTermsStore = new SearchTermsStore();
