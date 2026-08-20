import { Prisma } from '@prisma/client';
import { FEED_ELIGIBILITY, FEED_VISIBILITY, isFeedEligible } from '../feed.eligibility';

/**
 * The eligibility rules, asserted away from the database.
 *
 * `feed.db.test.ts` proves the SQL enforces them; this proves the definition
 * itself is what the brief asks for, and that the predicate keeps the two
 * properties the query planner depends on.
 */

const blog = (overrides: Partial<Parameters<typeof isFeedEligible>[0]> = {}) => ({
  status: 'PUBLISHED' as const,
  visibility: 'PUBLIC' as const,
  isHidden: false,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  author: { status: 'ACTIVE' },
  ...overrides,
});

describe('the discoverable visibility set', () => {
  it('is PUBLIC alone, for every feed', () => {
    // One set, no per-feed variation: a discovery rule that depends on which
    // feed you are reading is a rule nobody can hold in their head.
    expect(FEED_VISIBILITY).toEqual(['PUBLIC']);
  });

  it('never includes UNLISTED — reachable by link is not discoverable', () => {
    expect(FEED_VISIBILITY).not.toContain('UNLISTED');
  });

  it('never includes PRIVATE', () => {
    expect(FEED_VISIBILITY).not.toContain('PRIVATE');
  });

  it('never includes MEMBERS_ONLY', () => {
    // `canView` grants it to any authenticated viewer today, but that is a
    // documented placeholder for a real membership check. Discovery does not
    // lean on a placeholder — and Search keeps to PUBLIC for the same reason.
    expect(FEED_VISIBILITY).not.toContain('MEMBERS_ONLY');
  });
});

describe('isFeedEligible', () => {
  it('accepts a published, public post by an active author', () => {
    expect(isFeedEligible(blog())).toBe(true);
  });

  it.each([['DRAFT'], ['ARCHIVED'], ['DELETED']] as const)('rejects a %s blog', (status) => {
    expect(isFeedEligible(blog({ status }))).toBe(false);
  });

  it.each([['PRIVATE'], ['UNLISTED'], ['MEMBERS_ONLY']] as const)(
    'rejects %s from every feed',
    (visibility) => {
      expect(isFeedEligible(blog({ visibility }))).toBe(false);
    }
  );

  it.each([['SUSPENDED'], ['DELETED']])('rejects a post by a %s author', (status) => {
    expect(isFeedEligible(blog({ author: { status } }))).toBe(false);
  });

  it('rejects a moderation-hidden post', () => {
    // Hidden is an axis of its own, not a status: an author republishing a
    // hidden post must not bring it back into discovery.
    expect(isFeedEligible(blog({ isHidden: true }))).toBe(false);
  });

  it('rejects a published row with no publication instant', () => {
    // It cannot be ordered deterministically, so it cannot be paged without
    // risking duplicates — excluded rather than sorted arbitrarily.
    expect(isFeedEligible(blog({ publishedAt: null }))).toBe(false);
  });
});

describe('FEED_ELIGIBILITY', () => {
  const sql: string = (FEED_ELIGIBILITY as Prisma.Sql).sql;

  it('emits status and visibility as LITERALS so partial indexes stay provable', () => {
    expect(sql).toContain(`b."status" = 'PUBLISHED'`);
    expect(sql).toContain(`b."visibility" IN ('PUBLIC')`);
    // A bind parameter here would silently disqualify every feed index.
    expect(sql).not.toContain('$1');
    expect((FEED_ELIGIBILITY as Prisma.Sql).values).toEqual([]);
  });

  it('gates on the author account as well as the post', () => {
    expect(sql).toContain(`u."status" = 'ACTIVE'`);
  });

  it('excludes moderation-hidden posts', () => {
    expect(sql).toContain(`b."isHidden" = false`);
  });

  it('requires a publication instant', () => {
    expect(sql).toContain(`b."publishedAt" IS NOT NULL`);
  });

  it('matches the partial-index predicate in feed_indexes.sql', () => {
    // The index predicate and this one must agree, or the planner stops matching
    // and every feed quietly becomes a sequential scan.
    expect(sql).toContain(`b."status" = 'PUBLISHED'`);
    expect(sql).toContain(`b."visibility" IN ('PUBLIC')`);
  });
});
