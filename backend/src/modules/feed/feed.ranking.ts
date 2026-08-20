import {
  DIVERSITY,
  ENGAGEMENT_SATURATION,
  EXPLORE_RECENCY_HALF_LIFE_DAYS,
  EXPLORE_WEIGHTS,
  TRENDING_RECENCY_FLOOR,
  TRENDING_RECENCY_HALF_LIFE_DAYS,
} from './feed.config';
import type { RankedCandidate, RankingSignals } from './feed.types';

/**
 * Ranking and diversity — pure functions over signals.
 *
 * Nothing in this file touches Postgres, Redis, Express or the clock: `now` is
 * always a parameter. That is what makes the ranking assertable in a unit test
 * with no fixtures, and what makes it replaceable — a future personalized or
 * learned ranker implements the same two signatures and the rest of the module
 * does not change.
 *
 * ── The pipeline these functions sit in ─────────────────────────────────────
 *
 *   retrieve candidates ▶ apply eligibility ▶ RANK ▶ DIVERSIFY ▶ build DTOs
 *                         (repository/SQL)     (here)            (service)
 *
 * Ranking never filters. A candidate that reaches these functions has already
 * been proven eligible by the SQL that fetched it, and every candidate that goes
 * in comes out — reordered, never dropped. Keeping "what may be seen" and "what
 * should be seen first" in separate layers is what stops a ranking tweak from
 * becoming a privacy bug.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Exponential decay in [0, 1] with a half-life in days.
 *
 * `max(0, ...)` guards a future-dated `publishedAt`, which would otherwise
 * produce a boost above 1 and let a mis-stamped post outrank everything.
 */
export function recencyDecay(publishedAt: Date, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / MS_PER_DAY);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

/**
 * Maps an unbounded engagement score into [0, 1) as `e / (e + K)`.
 *
 * Order-preserving and, crucially, INDEPENDENT of the rest of the candidate set.
 * Normalizing against the set's maximum — the obvious alternative — would make
 * every score in the feed move when a single viral post arrived or aged out,
 * which is exactly the instability that makes a ranked page walk repeat items.
 *
 * Saturating rather than logarithmic so the difference between 10 000 and
 * 100 000 engagement points, which no reader can perceive, does not dominate a
 * recency signal that they can.
 */
export function engagementBoost(engagementScore: number, saturation = ENGAGEMENT_SATURATION): number {
  const value = Math.max(0, engagementScore);
  return value / (value + saturation);
}

/**
 * Explore's score: recency and engagement, weighted and summed.
 *
 * A weighted SUM rather than a product, because either signal alone is a valid
 * reason to surface a post — a well-received older piece and a brand-new one
 * both belong on a discovery page, and a product would zero out the new post for
 * having no engagement yet.
 */
export function scoreExplore(signal: RankingSignals, now: Date): number {
  const recency = recencyDecay(signal.publishedAt, now, EXPLORE_RECENCY_HALF_LIFE_DAYS);
  const engagement = engagementBoost(signal.engagementScore);
  return EXPLORE_WEIGHTS.RECENCY * recency + EXPLORE_WEIGHTS.ENGAGEMENT * engagement;
}

/**
 * Trending's score: windowed engagement, multiplied by a publication-recency
 * boost that never falls below a floor.
 *
 * A PRODUCT here, unlike Explore, because trending means "engagement, now" —
 * a post with no engagement in the window is not trending at any age, and a sum
 * would let pure freshness put it on the list.
 *
 * The engagement term is left un-normalized: it is only ever compared against
 * other candidates in the same run, and saturating it would flatten precisely
 * the differences trending exists to expose.
 */
export function scoreTrending(signal: RankingSignals, now: Date): number {
  const decay = recencyDecay(signal.publishedAt, now, TRENDING_RECENCY_HALF_LIFE_DAYS);
  const boost = TRENDING_RECENCY_FLOOR + (1 - TRENDING_RECENCY_FLOOR) * decay;
  return Math.max(0, signal.engagementScore) * boost;
}

/**
 * Ranks candidates with a scoring function, highest first.
 *
 * The tiebreak on `blogId` is not cosmetic: without a total order, two
 * equally-scored posts have no defined relative position, and the ranked
 * snapshot could be built in a different order on a rebuild — which is how a
 * paginated walk starts repeating and skipping items. Zero-engagement ties are
 * the common case on a young platform, not an edge case.
 */
export function rank(
  signals: RankingSignals[],
  score: (signal: RankingSignals, now: Date) => number,
  now: Date
): RankedCandidate[] {
  return signals
    .map((signal) => ({
      blogId: signal.blogId,
      authorId: signal.authorId,
      primaryTopic: signal.primaryTopic,
      score: score(signal, now),
    }))
    .sort((a, b) => b.score - a.score || (a.blogId < b.blogId ? 1 : a.blogId > b.blogId ? -1 : 0));
}

/**
 * Spreads authors and topics across the head of a ranked list.
 *
 * Greedy single pass: an item whose author or topic has already filled its quota
 * is DEFERRED to the tail instead of being placed. Nothing is removed, so the
 * feed stays complete and a prolific author's later posts remain reachable by
 * paging — they simply do not take three of the first five slots.
 *
 * Deterministic and stable: deferral preserves the incoming (score) order within
 * both the placed and deferred groups, so the same input always produces the
 * same output. That is a requirement, not a nicety — the ranked snapshot must be
 * reproducible for pagination to be exact.
 *
 * Applied to the WHOLE candidate list rather than per page, so the caps mean
 * "across the ranked feed" rather than "per screen", and a caller changing page
 * size cannot change the ordering.
 */
export function applyDiversity(
  candidates: RankedCandidate[],
  limits: { maxPerAuthor: number; maxPerTopic: number } = {
    maxPerAuthor: DIVERSITY.MAX_PER_AUTHOR,
    maxPerTopic: DIVERSITY.MAX_PER_TOPIC,
  }
): RankedCandidate[] {
  const placed: RankedCandidate[] = [];
  const deferred: RankedCandidate[] = [];
  const perAuthor = new Map<string, number>();
  const perTopic = new Map<string, number>();

  for (const candidate of candidates) {
    const authorCount = perAuthor.get(candidate.authorId) ?? 0;
    const topicCount = candidate.primaryTopic
      ? (perTopic.get(candidate.primaryTopic) ?? 0)
      : 0;

    if (authorCount >= limits.maxPerAuthor || topicCount >= limits.maxPerTopic) {
      deferred.push(candidate);
      continue;
    }

    perAuthor.set(candidate.authorId, authorCount + 1);
    if (candidate.primaryTopic) perTopic.set(candidate.primaryTopic, topicCount + 1);
    placed.push(candidate);
  }

  return [...placed, ...deferred];
}
