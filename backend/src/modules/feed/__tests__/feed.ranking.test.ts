import {
  applyDiversity,
  engagementBoost,
  rank,
  recencyDecay,
  scoreExplore,
  scoreTrending,
} from '../feed.ranking';
import {
  ENGAGEMENT_SATURATION,
  EXPLORE_RECENCY_HALF_LIFE_DAYS,
  TRENDING_RECENCY_FLOOR,
} from '../feed.config';
import type { RankedCandidate, RankingSignals } from '../feed.types';

/**
 * Ranking is pure, so this suite needs no database, no Redis and no clock — it
 * asserts the properties the rest of the module depends on:
 *
 *   - recency and engagement each behave monotonically, and neither can blow up
 *     the score with an out-of-range input;
 *   - ranking is a TOTAL order, because ranked pagination walks a frozen list
 *     and a non-deterministic tie would make a rebuild reorder it;
 *   - diversity reorders and never drops, so paging still reaches everything.
 */

const NOW = new Date('2026-06-15T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const signal = (overrides: Partial<RankingSignals> = {}): RankingSignals => ({
  blogId: 'b1',
  authorId: 'a1',
  publishedAt: NOW,
  engagementScore: 0,
  primaryTopic: null,
  ...overrides,
});

const candidate = (overrides: Partial<RankedCandidate> = {}): RankedCandidate => ({
  blogId: 'b1',
  authorId: 'a1',
  primaryTopic: null,
  score: 1,
  ...overrides,
});

describe('recencyDecay', () => {
  it('is 1 for content published now', () => {
    expect(recencyDecay(NOW, NOW, 7)).toBeCloseTo(1, 10);
  });

  it('halves at the half-life', () => {
    expect(recencyDecay(daysAgo(7), NOW, 7)).toBeCloseTo(0.5, 10);
    expect(recencyDecay(daysAgo(14), NOW, 7)).toBeCloseTo(0.25, 10);
  });

  it('decreases monotonically with age', () => {
    const values = [0, 1, 3, 10, 60, 365].map((d) => recencyDecay(daysAgo(d), NOW, 7));
    const sorted = [...values].sort((a, b) => b - a);
    expect(values).toEqual(sorted);
  });

  it('clamps a future publication date to 1 rather than boosting above it', () => {
    const future = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(recencyDecay(future, NOW, 7)).toBe(1);
  });
});

describe('engagementBoost', () => {
  it('is 0 with no engagement and approaches but never reaches 1', () => {
    expect(engagementBoost(0)).toBe(0);
    expect(engagementBoost(1e9)).toBeLessThan(1);
    expect(engagementBoost(1e9)).toBeGreaterThan(0.99);
  });

  it('is 0.5 at the saturation constant', () => {
    expect(engagementBoost(ENGAGEMENT_SATURATION)).toBeCloseTo(0.5, 10);
  });

  it('floors a negative score at zero instead of producing a negative boost', () => {
    expect(engagementBoost(-100)).toBe(0);
  });

  it('does not depend on the rest of the candidate set', () => {
    // The property that keeps a ranked page walk stable: adding a viral post to
    // the set must not move every other post's score.
    expect(engagementBoost(10)).toBe(engagementBoost(10));
  });
});

describe('scoreExplore', () => {
  it('ranks a fresh post with no engagement above a stale one with none', () => {
    const fresh = scoreExplore(signal({ publishedAt: NOW }), NOW);
    const stale = scoreExplore(signal({ publishedAt: daysAgo(30) }), NOW);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('lets engagement lift an older post above a brand-new one with none', () => {
    const engagedOlder = scoreExplore(
      signal({ publishedAt: daysAgo(EXPLORE_RECENCY_HALF_LIFE_DAYS), engagementScore: 500 }),
      NOW
    );
    const freshEmpty = scoreExplore(signal({ publishedAt: NOW }), NOW);
    expect(engagedOlder).toBeGreaterThan(freshEmpty);
  });

  it('does not let engagement alone resurrect very old content indefinitely', () => {
    const ancient = scoreExplore(signal({ publishedAt: daysAgo(365), engagementScore: 1e6 }), NOW);
    // Saturated engagement is bounded, so the ceiling is the engagement weight —
    // a fresh, moderately engaged post can still beat an ancient viral one.
    const freshDecent = scoreExplore(signal({ publishedAt: NOW, engagementScore: 60 }), NOW);
    expect(freshDecent).toBeGreaterThan(ancient);
  });
});

describe('scoreTrending', () => {
  it('scores zero when nothing happened in the window, however new the post', () => {
    expect(scoreTrending(signal({ publishedAt: NOW, engagementScore: 0 }), NOW)).toBe(0);
  });

  it('prefers the newer of two posts with identical windowed engagement', () => {
    const newer = scoreTrending(signal({ publishedAt: NOW, engagementScore: 100 }), NOW);
    const older = scoreTrending(signal({ publishedAt: daysAgo(30), engagementScore: 100 }), NOW);
    expect(newer).toBeGreaterThan(older);
  });

  it('never decays an older post below the configured floor', () => {
    const ancient = scoreTrending(signal({ publishedAt: daysAgo(3650), engagementScore: 100 }), NOW);
    expect(ancient).toBeCloseTo(100 * TRENDING_RECENCY_FLOOR, 6);
  });

  it('lets a genuine surge on older content outrank a mild new post', () => {
    // The floor is what makes this possible: history is invisible (the score is
    // windowed), so a spike today on a year-old post is a real trend.
    const surgingOld = scoreTrending(signal({ publishedAt: daysAgo(365), engagementScore: 1000 }), NOW);
    const mildNew = scoreTrending(signal({ publishedAt: NOW, engagementScore: 100 }), NOW);
    expect(surgingOld).toBeGreaterThan(mildNew);
  });
});

describe('rank', () => {
  it('orders by descending score', () => {
    const ranked = rank(
      [
        signal({ blogId: 'low', engagementScore: 1 }),
        signal({ blogId: 'high', engagementScore: 1000 }),
        signal({ blogId: 'mid', engagementScore: 50 }),
      ],
      scoreTrending,
      NOW
    );
    expect(ranked.map((r) => r.blogId)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks ties on blog id, so the order is total and reproducible', () => {
    // Zero-engagement ties are the common case on a young platform. Without the
    // tiebreak a snapshot rebuild could order them differently and the walk
    // would repeat and skip items.
    const input = [
      signal({ blogId: 'aaa' }),
      signal({ blogId: 'ccc' }),
      signal({ blogId: 'bbb' }),
    ];
    const first = rank(input, scoreExplore, NOW).map((r) => r.blogId);
    const second = rank([...input].reverse(), scoreExplore, NOW).map((r) => r.blogId);

    expect(first).toEqual(['ccc', 'bbb', 'aaa']);
    expect(second).toEqual(first);
  });

  it('carries author and topic through for the diversity pass', () => {
    const [only] = rank([signal({ authorId: 'a9', primaryTopic: 'react' })], scoreExplore, NOW);
    expect(only).toMatchObject({ authorId: 'a9', primaryTopic: 'react' });
  });
});

describe('applyDiversity', () => {
  const limits = { maxPerAuthor: 2, maxPerTopic: 3 };

  it('caps how many of the head slots one author may take', () => {
    const input = [
      candidate({ blogId: 'a-1', authorId: 'prolific', score: 10 }),
      candidate({ blogId: 'a-2', authorId: 'prolific', score: 9 }),
      candidate({ blogId: 'a-3', authorId: 'prolific', score: 8 }),
      candidate({ blogId: 'b-1', authorId: 'other', score: 1 }),
    ];

    const out = applyDiversity(input, limits).map((c) => c.blogId);

    expect(out.slice(0, 3)).toEqual(['a-1', 'a-2', 'b-1']);
    expect(out[3]).toBe('a-3');
  });

  it('caps one topic the same way', () => {
    const input = Array.from({ length: 5 }, (_, i) =>
      candidate({ blogId: `t-${i}`, authorId: `author-${i}`, primaryTopic: 'react', score: 10 - i })
    );
    input.push(candidate({ blogId: 'other', authorId: 'z', primaryTopic: 'rust', score: 0.1 }));

    const out = applyDiversity(input, limits).map((c) => c.blogId);

    expect(out.slice(0, 4)).toEqual(['t-0', 't-1', 't-2', 'other']);
  });

  it('never drops a candidate — deferral is reordering, not filtering', () => {
    const input = Array.from({ length: 10 }, (_, i) =>
      candidate({ blogId: `x-${i}`, authorId: 'same', primaryTopic: 'same', score: 10 - i })
    );

    const out = applyDiversity(input, limits);

    expect(out).toHaveLength(input.length);
    expect(new Set(out.map((c) => c.blogId))).toEqual(new Set(input.map((c) => c.blogId)));
  });

  it('preserves incoming order within both the placed and deferred groups', () => {
    const input = [
      candidate({ blogId: '1', authorId: 'a', score: 5 }),
      candidate({ blogId: '2', authorId: 'a', score: 4 }),
      candidate({ blogId: '3', authorId: 'a', score: 3 }),
      candidate({ blogId: '4', authorId: 'a', score: 2 }),
    ];

    expect(applyDiversity(input, limits).map((c) => c.blogId)).toEqual(['1', '2', '3', '4']);
  });

  it('is deterministic — the same input always produces the same output', () => {
    const input = [
      candidate({ blogId: 'p', authorId: 'a', primaryTopic: 'x', score: 3 }),
      candidate({ blogId: 'q', authorId: 'a', primaryTopic: 'x', score: 2 }),
      candidate({ blogId: 'r', authorId: 'a', primaryTopic: 'y', score: 1 }),
    ];
    expect(applyDiversity(input, limits)).toEqual(applyDiversity(input, limits));
  });

  it('treats an untagged post as having no topic rather than sharing one', () => {
    const input = Array.from({ length: 4 }, (_, i) =>
      candidate({ blogId: `u-${i}`, authorId: `a-${i}`, primaryTopic: null, score: 10 - i })
    );
    expect(applyDiversity(input, limits).map((c) => c.blogId)).toEqual([
      'u-0',
      'u-1',
      'u-2',
      'u-3',
    ]);
  });
});
