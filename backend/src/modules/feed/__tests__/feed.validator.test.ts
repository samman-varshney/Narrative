import { MAX_FEED_LIMIT, DEFAULT_FEED_LIMIT, DEFAULT_TRENDING_WINDOW } from '../feed.config';
import {
  exploreFeedQuerySchema,
  followingFeedQuerySchema,
  latestFeedQuerySchema,
  trendingFeedQuerySchema,
} from '../feed.validator';

/**
 * Query validation. Every bound asserted here is a cost control as much as a
 * correctness one — see the note at the top of `feed.validator.ts`.
 */

describe('pagination parameters', () => {
  it('applies the default page size', () => {
    expect(latestFeedQuerySchema.parse({})).toMatchObject({ limit: DEFAULT_FEED_LIMIT });
  });

  it('coerces limit from the query string', () => {
    expect(latestFeedQuerySchema.parse({ limit: '5' })).toMatchObject({ limit: 5 });
  });

  it.each([['0'], [String(MAX_FEED_LIMIT + 1)], ['-3'], ['abc'], ['2.5']])(
    'rejects limit=%s',
    (limit) => {
      expect(latestFeedQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  );

  it('accepts the maximum page size', () => {
    expect(latestFeedQuerySchema.parse({ limit: String(MAX_FEED_LIMIT) })).toMatchObject({
      limit: MAX_FEED_LIMIT,
    });
  });

  it('rejects an over-long cursor rather than decoding it', () => {
    expect(latestFeedQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });
});

describe('filters', () => {
  it('accepts a repeated parameter, a comma list, and a bare value alike', () => {
    expect(latestFeedQuerySchema.parse({ tag: ['react', 'node'] }).tag).toEqual(['react', 'node']);
    expect(latestFeedQuerySchema.parse({ tag: 'react,node' }).tag).toEqual(['react', 'node']);
    expect(latestFeedQuerySchema.parse({ tag: 'react' }).tag).toEqual(['react']);
  });

  it('lowercases and de-duplicates so equivalent requests share a cache key', () => {
    expect(latestFeedQuerySchema.parse({ tag: 'React,react,REACT' }).tag).toEqual(['react']);
  });

  it('caps how many tags may be requested, bounding the SQL IN list', () => {
    const many = Array.from({ length: 25 }, (_, i) => `tag-${i}`);
    expect(latestFeedQuerySchema.parse({ tag: many }).tag).toHaveLength(10);
  });

  it('rejects an absurdly long tag slug', () => {
    expect(latestFeedQuerySchema.safeParse({ tag: 'x'.repeat(81) }).success).toBe(false);
  });

  it('rejects reversed reading-time bounds', () => {
    const result = latestFeedQuerySchema.safeParse({ minReadingTime: '10', maxReadingTime: '5' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['minReadingTime']);
    }
  });

  it('accepts equal reading-time bounds', () => {
    expect(
      latestFeedQuerySchema.safeParse({ minReadingTime: '5', maxReadingTime: '5' }).success
    ).toBe(true);
  });

  it('rejects an out-of-range reading time', () => {
    expect(latestFeedQuerySchema.safeParse({ minReadingTime: '-1' }).success).toBe(false);
    expect(latestFeedQuerySchema.safeParse({ maxReadingTime: '601' }).success).toBe(false);
  });

  it('offers the same filters on the following feed', () => {
    const parsed = followingFeedQuerySchema.parse({ tag: 'react', minReadingTime: '2' });
    expect(parsed).toMatchObject({ tag: ['react'], minReadingTime: 2 });
  });

  it('does not accept a visibility filter — feeds resolve to one visibility set', () => {
    const parsed = latestFeedQuerySchema.parse({ visibility: 'PRIVATE' }) as Record<string, unknown>;
    expect(parsed.visibility).toBeUndefined();
  });
});

describe('explore options', () => {
  it('defaults excludeFollowing to off', () => {
    expect(exploreFeedQuerySchema.parse({}).excludeFollowing).toBe(false);
  });

  it('reads an explicit opt-out as false, not as a truthy string', () => {
    // `z.coerce.boolean()` would map "false" to true — every non-empty string is
    // truthy — and silently turn an opt-out into an opt-in.
    expect(exploreFeedQuerySchema.parse({ excludeFollowing: 'false' }).excludeFollowing).toBe(false);
    expect(exploreFeedQuerySchema.parse({ excludeFollowing: '0' }).excludeFollowing).toBe(false);
  });

  it('reads an opt-in as true', () => {
    expect(exploreFeedQuerySchema.parse({ excludeFollowing: 'true' }).excludeFollowing).toBe(true);
    expect(exploreFeedQuerySchema.parse({ excludeFollowing: '1' }).excludeFollowing).toBe(true);
  });

  it('rejects an unrecognised value instead of guessing', () => {
    expect(exploreFeedQuerySchema.safeParse({ excludeFollowing: 'yes' }).success).toBe(false);
  });
});

describe('trending options', () => {
  it('defaults the window', () => {
    expect(trendingFeedQuerySchema.parse({}).window).toBe(DEFAULT_TRENDING_WINDOW);
  });

  it.each([['24h'], ['7d'], ['30d']])('accepts the %s window', (window) => {
    expect(trendingFeedQuerySchema.parse({ window }).window).toBe(window);
  });

  it('rejects a window outside the fixed vocabulary', () => {
    // An open-ended window would let one caller mint unbounded distinct
    // rankings, each costing an aggregate scan and a Redis entry.
    expect(trendingFeedQuerySchema.safeParse({ window: '90d' }).success).toBe(false);
    expect(trendingFeedQuerySchema.safeParse({ window: '1' }).success).toBe(false);
  });
});
