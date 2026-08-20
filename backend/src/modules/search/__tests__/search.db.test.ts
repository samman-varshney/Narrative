import { AppError } from '../../../core/exceptions/AppError';
import {
  categorizeBlog,
  disconnectDb,
  makeBlog,
  makeCategory,
  makeTag,
  makeUser,
  makeUserSettings,
  resetDb,
  tagBlog,
} from '../../../test/db';
import { postgresSearchEngine } from '../engines/PostgresSearchEngine';
import { normalizeQuery } from '../search.query';
import type { SearchPageRequest, SearchSort } from '../search.types';

/**
 * Real-SQL tests for the PostgreSQL search engine.
 *
 * Nothing here can be established with a mocked Prisma delegate: ranking order
 * comes out of `ts_rank_cd` and `similarity()`, the visibility rules are
 * enforced by partial-index predicates in the query text, and keyset pagination
 * over a computed score is exactly the kind of thing that looks right and walks
 * wrong. These run against the local test database.
 */

const page = (overrides: Partial<SearchPageRequest> = {}): SearchPageRequest => ({
  limit: 20,
  sort: 'relevance',
  ...overrides,
});

async function searchBlogs(q: string, overrides: Partial<SearchPageRequest> = {}, filters = {}) {
  return postgresSearchEngine.searchBlogs(normalizeQuery(q), page(overrides), filters);
}

async function titles(q: string, overrides: Partial<SearchPageRequest> = {}, filters = {}) {
  const result = await searchBlogs(q, overrides, filters);
  return result.items.map((item) => item.title);
}

describe('PostgresSearchEngine (real database)', () => {
  let grace: Awaited<ReturnType<typeof makeUser>>;
  let alan: Awaited<ReturnType<typeof makeUser>>;
  let suspended: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();

    grace = await makeUser({ username: 'gracehopper', name: 'Grace Hopper' });
    alan = await makeUser({ username: 'alanturing', name: 'Alan Turing' });
    suspended = await makeUser({ username: 'ghost', name: 'Ghost Writer', status: 'SUSPENDED' });

    const javascriptTag = await makeTag('javascript');
    const frontendCategory = await makeCategory('Frontend');

    // --- Publicly searchable ---
    const exact = await makeBlog(grace.id, {
      title: 'JavaScript',
      slug: 'javascript',
      publishedAt: new Date('2026-01-05T00:00:00Z'),
      readingTimeMinutes: 4,
    });
    await makeBlog(grace.id, {
      title: 'JavaScript Promises Explained',
      slug: 'javascript-promises-explained',
      subtitle: 'A tour of the microtask queue',
      publishedAt: new Date('2026-01-04T00:00:00Z'),
      readingTimeMinutes: 12,
    });
    await makeBlog(grace.id, {
      title: 'Understanding Promise Chains',
      slug: 'understanding-promise-chains',
      publishedAt: new Date('2026-01-03T00:00:00Z'),
      readingTimeMinutes: 8,
    });

    // Title mentions nothing about javascript — reachable only via its tag.
    const tagged = await makeBlog(grace.id, {
      title: 'Cooking With Cast Iron',
      slug: 'cooking-with-cast-iron',
      publishedAt: new Date('2026-01-02T00:00:00Z'),
      readingTimeMinutes: 3,
    });
    await tagBlog(tagged.id, javascriptTag.id);

    // Reachable only via its category.
    const categorized = await makeBlog(alan.id, {
      title: 'Turing Machines Explained',
      slug: 'turing-machines-explained',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      readingTimeMinutes: 20,
    });
    await categorizeBlog(categorized.id, frontendCategory.id);

    // A literal percent sign in the title — the LIKE-escaping fixture.
    await makeBlog(grace.id, {
      title: '100% JavaScript',
      slug: 'one-hundred-percent-javascript',
      publishedAt: new Date('2026-01-06T00:00:00Z'),
    });

    // --- Must never surface publicly ---
    await makeBlog(grace.id, { title: 'JavaScript Draft', slug: 'js-draft', status: 'DRAFT' });
    await makeBlog(grace.id, {
      title: 'JavaScript Archived',
      slug: 'js-archived',
      status: 'ARCHIVED',
    });
    await makeBlog(grace.id, {
      title: 'JavaScript Deleted',
      slug: 'js-deleted',
      status: 'DELETED',
    });
    await makeBlog(grace.id, {
      title: 'JavaScript Private',
      slug: 'js-private',
      visibility: 'PRIVATE',
    });
    await makeBlog(grace.id, {
      title: 'JavaScript Unlisted',
      slug: 'js-unlisted',
      visibility: 'UNLISTED',
    });
    await makeBlog(grace.id, {
      title: 'JavaScript Members Only',
      slug: 'js-members',
      visibility: 'MEMBERS_ONLY',
    });
    await makeBlog(suspended.id, {
      title: 'JavaScript By A Suspended Author',
      slug: 'js-suspended',
    });

    void exact;
  });

  afterAll(disconnectDb);

  // -------------------------------------------------------------------------

  describe('ranking', () => {
    it('puts an exact title match first', async () => {
      expect((await titles('javascript'))[0]).toBe('JavaScript');
    });

    it('is case-insensitive on the exact match', async () => {
      expect((await titles('JAVASCRIPT'))[0]).toBe('JavaScript');
    });

    it('ranks a title prefix above a tag-only match', async () => {
      const found = await titles('javascript');

      expect(found.indexOf('JavaScript Promises Explained')).toBeLessThan(
        found.indexOf('Cooking With Cast Iron')
      );
    });

    it('scores every hit and returns them in descending score order', async () => {
      const { items } = await searchBlogs('javascript');
      const scores = items.map((item) => item.score);

      expect(scores.length).toBeGreaterThan(1);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it('does not fall back to reverse-chronological order', async () => {
      // "100% JavaScript" is the NEWEST public post. Under `createdAt DESC` it
      // would lead; under relevance the exact title match does.
      const found = await titles('javascript');

      expect(found[0]).toBe('JavaScript');
      expect(found.indexOf('100% JavaScript')).toBeGreaterThan(0);
    });

    it('applies full-text stemming, so a singular query matches a plural title', async () => {
      // "promise" -> "Promises Explained" and "Promise Chains" via the English
      // stemmer; a LIKE-based search would find neither.
      expect(await titles('promise')).toEqual(
        expect.arrayContaining(['JavaScript Promises Explained', 'Understanding Promise Chains'])
      );
    });

    it('matches the subtitle as well as the title', async () => {
      expect(await titles('microtask queue')).toContain('JavaScript Promises Explained');
    });
  });

  describe('candidate sources', () => {
    it('finds a blog by its tag when the title matches nothing', async () => {
      expect(await titles('javascript')).toContain('Cooking With Cast Iron');
    });

    it('finds a blog by its category', async () => {
      expect(await titles('frontend')).toContain('Turing Machines Explained');
    });

    it('finds a blog by its author username', async () => {
      expect(await titles('alanturing')).toContain('Turing Machines Explained');
    });

    it('finds a blog by its author display name', async () => {
      expect(await titles('grace hopper')).toContain('JavaScript');
    });

    it('tolerates a typo in the title', async () => {
      // No cheap source matches "javascrpt", so the gated trigram pass runs.
      expect(await titles('javascrpt')).toContain('JavaScript');
    });

    it('matches a short prefix that is too short for trigrams', async () => {
      expect(await titles('ja')).toContain('JavaScript');
    });

    it('returns nothing for a query that matches nothing', async () => {
      const result = await searchBlogs('zzzzznothingmatchesthis');

      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('visibility and privacy', () => {
    it.each([
      ['drafts', 'JavaScript Draft'],
      ['archived posts', 'JavaScript Archived'],
      ['soft-deleted posts', 'JavaScript Deleted'],
      ['private posts', 'JavaScript Private'],
      ['unlisted posts', 'JavaScript Unlisted'],
      ['members-only posts', 'JavaScript Members Only'],
      ['posts by a suspended author', 'JavaScript By A Suspended Author'],
    ])('never returns %s', async (_label, title) => {
      expect(await titles('javascript')).not.toContain(title);
    });

    it('excludes a suspended author from user search', async () => {
      const result = await postgresSearchEngine.searchUsers(normalizeQuery('ghost'), page());

      expect(result.items).toEqual([]);
    });

    it('excludes a user who has opted into a private profile', async () => {
      const pat = await makeUser({ username: 'patprivate', name: 'Pat Private' });
      await makeUserSettings(pat.id, { isPrivate: true });

      const result = await postgresSearchEngine.searchUsers(normalizeQuery('patprivate'), page());

      // Ranked, enumerable listings are exactly what the private flag exists to
      // prevent — the profile endpoint remains reachable by exact username.
      expect(result.items).toEqual([]);
    });

    it('includes a user with a settings row that leaves isPrivate false', async () => {
      const open = await makeUser({ username: 'openbook', name: 'Open Book' });
      await makeUserSettings(open.id, { hideEmail: true });

      const result = await postgresSearchEngine.searchUsers(normalizeQuery('openbook'), page());

      expect(result.items.map((u) => u.username)).toContain('openbook');
    });

    it('includes a user who has never saved settings at all', async () => {
      // The settings row is created lazily; a missing row must read as
      // "defaults", not as "private".
      const result = await postgresSearchEngine.searchUsers(normalizeQuery('gracehopper'), page());

      expect(result.items.map((u) => u.username)).toContain('gracehopper');
    });

    it('keeps a private user out of suggestions too', async () => {
      const pat = await makeUser({ username: 'patprivate', name: 'Pat Private' });
      await makeUserSettings(pat.id, { isPrivate: true });

      const suggestions = await postgresSearchEngine.suggest(normalizeQuery('patpriv'), 10);

      expect(suggestions.map((s) => s.text)).not.toContain('patprivate');
    });
  });

  describe('user search ranking', () => {
    it('ranks an exact username above a partial name match', async () => {
      const result = await postgresSearchEngine.searchUsers(normalizeQuery('gracehopper'), page());

      expect(result.items[0]?.username).toBe('gracehopper');
    });

    it('finds a user by display name', async () => {
      const result = await postgresSearchEngine.searchUsers(normalizeQuery('turing'), page());

      expect(result.items.map((u) => u.username)).toContain('alanturing');
    });

    it('returns only public profile fields', async () => {
      const result = await postgresSearchEngine.searchUsers(normalizeQuery('gracehopper'), page());

      expect(Object.keys(result.items[0]!).sort()).toEqual([
        'avatar',
        'bio',
        'id',
        'isVerified',
        'name',
        'score',
        'username',
      ]);
    });
  });

  describe('filters', () => {
    it('filters by author username', async () => {
      const found = await titles('explained', {}, { author: 'alanturing' });

      expect(found).toEqual(['Turing Machines Explained']);
    });

    it('matches the author filter case-insensitively', async () => {
      const found = await titles('explained', {}, { author: 'AlanTuring' });

      expect(found).toEqual(['Turing Machines Explained']);
    });

    it('filters by tag slug', async () => {
      const found = await titles('javascript', {}, { tags: ['javascript'] });

      expect(found).toEqual(['Cooking With Cast Iron']);
    });

    it('filters by category slug', async () => {
      const found = await titles('explained', {}, { categories: ['frontend'] });

      expect(found).toEqual(['Turing Machines Explained']);
    });

    it('filters by published date range', async () => {
      const found = await titles(
        'javascript',
        {},
        { from: new Date('2026-01-04T00:00:00Z'), to: new Date('2026-01-05T00:00:00Z') }
      );

      expect(found.sort()).toEqual(['JavaScript', 'JavaScript Promises Explained']);
    });

    it('filters by reading time', async () => {
      const found = await titles('javascript', {}, { minReadingTime: 10, maxReadingTime: 15 });

      expect(found).toEqual(['JavaScript Promises Explained']);
    });

    it('returns an empty page when filters exclude every match', async () => {
      const result = await searchBlogs('javascript', {}, { author: 'nobody' });

      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it('applies filters during candidate selection, not only after it', async () => {
      // The engine caps each candidate source. If filters were applied only to
      // the already-capped union, a narrow filter over a broad query could come
      // back empty while matches existed.
      const found = await titles('javascript', {}, { author: 'gracehopper' });

      expect(found.length).toBeGreaterThan(0);
      expect(found).toContain('JavaScript');
    });
  });

  describe('cursor pagination', () => {
    /** Walks every page and returns the ids seen, in order. */
    async function walkAll(sort: SearchSort, pageSize: number) {
      const seen: string[] = [];
      let cursor: string | undefined;

      for (let guard = 0; guard < 50; guard++) {
        const result = await searchBlogs('javascript', {
          limit: pageSize,
          sort,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...result.items.map((item) => item.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return seen;
    }

    it.each([
      ['relevance' as const, 1],
      ['relevance' as const, 2],
      ['newest' as const, 2],
      ['oldest' as const, 2],
    ])('walks every row exactly once (sort=%s, pageSize=%i)', async (sort, pageSize) => {
      const single = await searchBlogs('javascript', { limit: 50, sort });
      const walked = await walkAll(sort, pageSize);

      expect(walked).toHaveLength(single.items.length);
      expect(new Set(walked).size).toBe(walked.length); // no repeats
      expect(walked).toEqual(single.items.map((item) => item.id)); // same order
    });

    it('reverses exactly between newest and oldest', async () => {
      const newest = await walkAll('newest', 2);
      const oldest = await walkAll('oldest', 2);

      expect(oldest).toEqual([...newest].reverse());
    });

    it('reports hasMore from a sentinel row, not a count query', async () => {
      const all = await searchBlogs('javascript', { limit: 50 });
      const exact = await searchBlogs('javascript', { limit: all.items.length });

      expect(exact.hasMore).toBe(false);
      expect(exact.nextCursor).toBeNull();
    });

    it('produces a stable cursor across repeated requests', async () => {
      const first = await searchBlogs('javascript', { limit: 2 });
      const again = await searchBlogs('javascript', { limit: 2 });

      expect(again.nextCursor).toBe(first.nextCursor);
    });

    it('rejects a cursor replayed against a different query', async () => {
      const first = await searchBlogs('javascript', { limit: 2 });

      await expect(
        searchBlogs('promise', { limit: 2, cursor: first.nextCursor! })
      ).rejects.toThrow(AppError);
    });

    it('rejects a cursor replayed against different filters', async () => {
      const first = await searchBlogs('javascript', { limit: 2 });

      await expect(
        searchBlogs('javascript', { limit: 2, cursor: first.nextCursor! }, { author: 'gracehopper' })
      ).rejects.toThrow(/cursor/i);
    });

    it('rejects a relevance cursor replayed against a recency sort', async () => {
      const first = await searchBlogs('javascript', { limit: 2, sort: 'relevance' });

      await expect(
        searchBlogs('javascript', { limit: 2, sort: 'newest', cursor: first.nextCursor! })
      ).rejects.toThrow(/cursor/i);
    });

    it('tolerates a changed page size mid-walk', async () => {
      // `limit` is deliberately not part of the cursor fingerprint: keyset
      // pagination is correct regardless of how the page size varies.
      const first = await searchBlogs('javascript', { limit: 2 });
      const second = await searchBlogs('javascript', { limit: 5, cursor: first.nextCursor! });

      const overlap = second.items.filter((item) =>
        first.items.some((prev) => prev.id === item.id)
      );
      expect(overlap).toEqual([]);
    });
  });

  describe('result shape', () => {
    it('returns a lightweight hit with author and taxonomy, and no content body', async () => {
      const result = await searchBlogs('cooking');
      const hit = result.items[0]!;

      expect(hit).toMatchObject({
        title: 'Cooking With Cast Iron',
        slug: 'cooking-with-cast-iron',
        author: { username: 'gracehopper', name: 'Grace Hopper', isVerified: false },
        tags: [{ name: 'javascript', slug: 'javascript' }],
        categories: [],
      });
      expect(hit).not.toHaveProperty('content');
    });

    it('serializes publishedAt as an ISO string so cached and live responses match', async () => {
      const result = await searchBlogs('javascript');

      // A Date survives the first response but comes back from Redis as a
      // string; emitting the string always keeps the wire format identical.
      expect(typeof result.items[0]!.publishedAt).toBe('string');
      expect(result.items[0]!.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('derives the excerpt from the subtitle, never the body', async () => {
      const result = await searchBlogs('microtask');

      expect(result.items[0]!.excerpt).toBe('A tour of the microtask queue');
    });

    it('loads taxonomy for the page in a batch, not per row', async () => {
      // Every hit is hydrated, including ones with no tags at all.
      const result = await searchBlogs('javascript', { limit: 50 });

      for (const hit of result.items) {
        expect(Array.isArray(hit.tags)).toBe(true);
        expect(Array.isArray(hit.categories)).toBe(true);
      }
    });
  });

  describe('tag and category search', () => {
    it('finds a tag and counts only publicly visible published blogs', async () => {
      // The tag is on one public post; add a draft to prove drafts do not count.
      const draft = await makeBlog(grace.id, { title: 'Hidden', slug: 'hidden', status: 'DRAFT' });
      const tag = await makeTag('typescript');
      await tagBlog(draft.id, tag.id);

      const result = await postgresSearchEngine.searchTags(normalizeQuery('javascript'), page());

      expect(result.items).toEqual([
        expect.objectContaining({ name: 'javascript', slug: 'javascript', blogCount: 1 }),
      ]);

      const tsResult = await postgresSearchEngine.searchTags(normalizeQuery('typescript'), page());
      expect(tsResult.items[0]).toMatchObject({ name: 'typescript', blogCount: 0 });
    });

    it('finds a category by prefix', async () => {
      const result = await postgresSearchEngine.searchCategories(normalizeQuery('front'), page());

      expect(result.items).toEqual([
        expect.objectContaining({ name: 'Frontend', slug: 'frontend', blogCount: 1 }),
      ]);
    });

    it('paginates the vocabularies with a working cursor', async () => {
      for (const name of ['react', 'redis', 'rust', 'ruby']) await makeTag(name);

      const first = await postgresSearchEngine.searchTags(normalizeQuery('r'), page({ limit: 2 }));
      expect(first.hasMore).toBe(true);

      const second = await postgresSearchEngine.searchTags(
        normalizeQuery('r'),
        page({ limit: 2, cursor: first.nextCursor! })
      );

      const firstIds = first.items.map((t) => t.id);
      expect(second.items.map((t) => t.id).some((id) => firstIds.includes(id))).toBe(false);
    });
  });

  describe('suggestions', () => {
    it('draws from tags, blog titles and usernames', async () => {
      const suggestions = await postgresSearchEngine.suggest(normalizeQuery('java'), 10);
      const sources = new Set(suggestions.map((s) => s.source));

      expect(suggestions.map((s) => s.text)).toEqual(
        expect.arrayContaining(['javascript', 'JavaScript'])
      );
      expect(sources.has('TAG')).toBe(true);
      expect(sources.has('BLOG')).toBe(true);
    });

    it('suggests a username', async () => {
      const suggestions = await postgresSearchEngine.suggest(normalizeQuery('grace'), 10);

      expect(suggestions).toContainEqual(
        expect.objectContaining({ text: 'gracehopper', source: 'USER' })
      );
    });

    it('never suggests a non-public blog title', async () => {
      const suggestions = await postgresSearchEngine.suggest(normalizeQuery('javascript d'), 10);

      expect(suggestions.map((s) => s.text)).not.toContain('JavaScript Draft');
    });

    it('honours the limit', async () => {
      const suggestions = await postgresSearchEngine.suggest(normalizeQuery('java'), 2);

      expect(suggestions.length).toBeLessThanOrEqual(2);
    });
  });

  describe('hostile input', () => {
    // These two use TWO-CHARACTER queries deliberately. Below three characters
    // the trigram sources are skipped entirely, which isolates the anchored
    // `LIKE` path — the only place escaping can go wrong. A longer query would
    // match fuzzily either way and prove nothing about the escaping.

    it('treats a percent sign as a literal, not a wildcard', async () => {
      await makeBlog(grace.id, { title: '%discount tips', slug: 'percent-discount' });

      const found = await titles('%d');

      // Escaped, the pattern is `\%d%` and matches only the title that really
      // starts with a percent sign. Unescaped it would be `%d%` — a LEADING
      // wildcard matching every title containing a "d", and unable to use an
      // index for any of them.
      expect(found).toEqual(['%discount tips']);
    });

    it('treats an underscore as a literal', async () => {
      await makeBlog(grace.id, { title: '_apply here', slug: 'underscore-apply' });

      const found = await titles('_a');

      // Escaped, `\_a%` matches only the literal leading underscore.
      // Unescaped, `_a%` is "any single character then an a" — which would
      // match "JavaScript".
      expect(found).toEqual(['_apply here']);
    });

    it('still matches a title that genuinely contains a percent sign', async () => {
      expect(await titles('100%')).toEqual(['100% JavaScript']);
    });

    it('does not break on SQL metacharacters', async () => {
      // Everything reaches Postgres as a bind parameter; these are just text.
      for (const q of [
        "'; DROP TABLE \"Blog\"; --",
        "javascript' OR '1'='1",
        'javascript\\',
        '\\%',
        '" OR ""="',
      ]) {
        await expect(searchBlogs(q)).resolves.toEqual(
          expect.objectContaining({ items: expect.any(Array) })
        );
      }

      // And the table is still there.
      const after = await titles('javascript');
      expect(after).toContain('JavaScript');
    });

    it('does not break on full-text operator syntax', async () => {
      // `websearch_to_tsquery` parses these safely rather than erroring the way
      // `to_tsquery` would.
      for (const q of ['javascript OR', '-javascript', '"unterminated', 'a & b | c !d']) {
        await expect(searchBlogs(q)).resolves.toBeDefined();
      }
    });

    it('handles a query made only of full-text stopwords', async () => {
      // "the and of" produces an EMPTY tsquery, which matches nothing — the
      // other candidate sources must still carry the query without erroring.
      await expect(searchBlogs('the and of')).resolves.toEqual(
        expect.objectContaining({ items: expect.any(Array) })
      );
    });
  });
});
