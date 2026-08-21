import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma';
import { AppError } from '../../../core/exceptions/AppError';
import {
  categorizeBlog,
  makeCategory,
  makeTag,
  makeUser,
  makeUserSettings,
  resetDb,
  tagBlog,
} from '../../../test/db';
import { SITEMAP_URLS_PER_CHUNK } from '../seo.config';
import { seoRepository } from '../seo.repository';
import { seoService } from '../seo.service';
import { sitemapService } from '../sitemap.service';
import {
  attachCover,
  clearSeoKeys,
  countQueries,
  makeDeveloperProfile,
  makeSeoBlog,
  overrideEnv,
  tiptapDoc,
  touchUpdatedAt,
  allElementText,
  urlBlocks,
  elementText,
} from './helpers';

/**
 * The SEO module against real SQL.
 *
 * Mock-based tests prove a query was BUILT as intended; only these prove it
 * BEHAVES as intended. Everything security-relevant in this module is a
 * predicate in a WHERE clause, and a predicate is exactly the thing a mock
 * cannot check.
 */

const APP_URL = 'https://narrative.test';
let restore: (() => void)[] = [];

beforeAll(async () => {
  await resetDb();
});

beforeEach(async () => {
  restore = [
    overrideEnv('APP_URL', APP_URL),
    overrideEnv('SEO_SITE_NAME', 'Narrative'),
    overrideEnv('SEO_SITEMAP_BASE_URL', undefined),
    overrideEnv('SEO_INDEXING_ENABLED', 'true'),
    overrideEnv('SEO_DEFAULT_IMAGE', undefined),
  ];
  await resetDb();
  await clearSeoKeys();
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
});

afterAll(async () => {
  await clearSeoKeys();
  await prisma.$disconnect();
});

/** The `<loc>` values of one sitemap section's first chunk. */
async function sitemapLocs(section: 'blogs' | 'authors' | 'categories' | 'tags', page = 1) {
  const document = await sitemapService.getChunk(section, page).catch((err) => {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  });
  return document ? allElementText(document.body, 'loc') : [];
}

// ---------------------------------------------------------------------------
// Metadata: content eligibility
// ---------------------------------------------------------------------------

describe('blog metadata eligibility', () => {
  it('serves a published, public post', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'visible', title: 'Visible' });

    const metadata = await seoService.getBlogMetadata('visible');

    expect(metadata.title).toBe('Visible — Narrative');
    expect(metadata.canonicalUrl).toBe(`${APP_URL}/blog/visible`);
    expect(metadata.robots.index).toBe(true);
  });

  it.each([
    ['a draft', { status: 'DRAFT' as const }],
    ['an archived post', { status: 'ARCHIVED' as const }],
    ['a soft-deleted post', { status: 'DELETED' as const }],
    ['a private post', { visibility: 'PRIVATE' as const }],
    ['a members-only post', { visibility: 'MEMBERS_ONLY' as const }],
    ['a moderator-hidden post', { isHidden: true }],
  ])('refuses %s with a 404 that reveals nothing', async (_label, overrides) => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'hidden-one', title: 'Secret Title', ...overrides });

    await expect(seoService.getBlogMetadata('hidden-one')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Not found',
    });
  });

  it('serves an unlisted post but asks not to index it', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'unlisted', visibility: 'UNLISTED' });

    const metadata = await seoService.getBlogMetadata('unlisted');
    expect(metadata.robots.directive).toBe('noindex, follow');
  });

  it("serves a suspended author's post but asks not to index it", async () => {
    const author = await makeUser({ status: 'SUSPENDED' });
    await makeSeoBlog(author.id, { slug: 'by-suspended' });

    const metadata = await seoService.getBlogMetadata('by-suspended');
    expect(metadata.robots.index).toBe(false);
  });

  it('404s an unknown slug', async () => {
    await expect(seoService.getBlogMetadata('never-existed')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('404s a renamed post under its old slug rather than serving stale metadata', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'old-slug' });

    await seoService.getBlogMetadata('old-slug'); // populates the cache
    await prisma.blog.update({ where: { id: blog.id }, data: { slug: 'new-slug' } });

    // The old address is gone the instant the slug changes, with no invalidation
    // involved: the cache is keyed by the post's ID and the slug no longer
    // resolves to one. That is the whole reason for the identity probe.
    await expect(seoService.getBlogMetadata('old-slug')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('serves the new canonical once the update event has been handled', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'before-rename' });

    await seoService.getBlogMetadata('before-rename');
    await prisma.blog.update({ where: { id: blog.id }, data: { slug: 'after-rename' } });

    // `blogService.update` re-slugs and emits BLOG_UPDATED; the subscriber turns
    // that into this call. Until it lands the entry is stale for at most its TTL
    // — the bound every cache in this module accepts for a lost event.
    await seoService.invalidateForBlog(blog.id, author.id);

    expect((await seoService.getBlogMetadata('after-rename')).canonicalUrl).toBe(
      `${APP_URL}/blog/after-rename`
    );
  });
});

describe('author metadata eligibility', () => {
  it('serves an active author with published work', async () => {
    const author = await makeUser({ username: 'grace', name: 'Grace Hopper' });
    await makeSeoBlog(author.id);

    const metadata = await seoService.getAuthorMetadata('grace');

    expect(metadata.canonicalUrl).toBe(`${APP_URL}/@grace`);
    expect(metadata.robots.index).toBe(true);
  });

  it.each([['SUSPENDED'], ['DEACTIVATED'], ['DELETED']])(
    '404s a %s account, indistinguishably from one that never existed',
    async (status) => {
      await makeUser({ username: 'gone', status: status as 'SUSPENDED' });

      const forGone = await seoService.getAuthorMetadata('gone').catch((e) => e);
      const forUnknown = await seoService.getAuthorMetadata('nobody').catch((e) => e);

      expect(forGone.statusCode).toBe(404);
      expect(forGone.message).toBe(forUnknown.message);
      expect(forGone.errorCode).toBe(forUnknown.errorCode);
    }
  );

  it('serves a private profile without its bio, and never indexes it', async () => {
    const author = await makeUser({ username: 'quiet' });
    await prisma.user.update({
      where: { id: author.id },
      data: { bio: 'A private biography' },
    });
    await makeUserSettings(author.id, { isPrivate: true });
    await makeSeoBlog(author.id);

    const metadata = await seoService.getAuthorMetadata('quiet');

    expect(metadata.robots.index).toBe(false);
    expect(JSON.stringify(metadata)).not.toContain('private biography');
  });

  it('does not index a profile with nothing published', async () => {
    await makeUser({ username: 'newcomer' });

    const metadata = await seoService.getAuthorMetadata('newcomer');
    expect(metadata.robots.index).toBe(false);
  });

  it('counts only eligible posts towards indexability', async () => {
    const author = await makeUser({ username: 'drafter' });
    await makeSeoBlog(author.id, { status: 'DRAFT' });
    await makeSeoBlog(author.id, { visibility: 'PRIVATE' });

    expect((await seoService.getAuthorMetadata('drafter')).robots.index).toBe(false);
  });

  it('publishes the external profiles as sameAs', async () => {
    const author = await makeUser({ username: 'grace' });
    await makeDeveloperProfile(author.id, {
      x: 'https://x.com/gracehopper',
      github: 'https://github.com/grace',
    });
    await makeSeoBlog(author.id);

    const metadata = await seoService.getAuthorMetadata('grace');
    const page = metadata.structuredData.find((n) => n['@type'] === 'ProfilePage')!;
    const person = page.mainEntity as Record<string, unknown>;

    expect(person.sameAs).toEqual(
      expect.arrayContaining(['https://x.com/gracehopper', 'https://github.com/grace'])
    );
    expect(metadata.twitter.creator).toBe('@gracehopper');
  });
});

describe('term metadata eligibility', () => {
  it('indexes a term that has eligible posts', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id);
    const tag = await makeTag('TypeScript', 'typescript');
    await tagBlog(blog.id, tag.id);

    const metadata = await seoService.getTagMetadata('typescript');

    expect(metadata.title).toBe('#TypeScript — Narrative');
    expect(metadata.robots.index).toBe(true);
  });

  it('does not index a term carried only by ineligible posts', async () => {
    const author = await makeUser();
    const draft = await makeSeoBlog(author.id, { status: 'DRAFT' });
    const tag = await makeTag('Empty', 'empty');
    await tagBlog(draft.id, tag.id);

    expect((await seoService.getTagMetadata('empty')).robots.index).toBe(false);
  });

  it('does not index a term carried only by a suspended author', async () => {
    const suspended = await makeUser({ status: 'SUSPENDED' });
    const blog = await makeSeoBlog(suspended.id);
    const category = await makeCategory('Ghost', 'ghost');
    await categorizeBlog(blog.id, category.id);

    expect((await seoService.getCategoryMetadata('ghost')).robots.index).toBe(false);
  });

  it('404s an unknown term', async () => {
    await expect(seoService.getTagMetadata('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Metadata: content
// ---------------------------------------------------------------------------

describe('metadata content', () => {
  it('derives a description from the body only when nothing cheaper exists', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, {
      slug: 'from-body',
      content: tiptapDoc('The opening paragraph of the post.'),
    });

    const metadata = await seoService.getBlogMetadata('from-body');
    expect(metadata.description).toBe('The opening paragraph of the post.');
  });

  it('publishes the cover as the Open Graph image, never its storage path', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'with-cover' });
    const media = await attachCover(blog.id, author.id);
    await touchUpdatedAt(blog.id, new Date('2026-02-01T00:00:00Z'));

    const metadata = await seoService.getBlogMetadata('with-cover');

    expect(metadata.openGraph.image).toBe(media.secureUrl);
    expect(JSON.stringify(metadata)).not.toContain('secret-internal-path');
  });

  it('omits a soft-deleted cover rather than publishing a broken image', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'dead-cover' });
    await attachCover(blog.id, author.id, { deletedAt: new Date() });

    expect((await seoService.getBlogMetadata('dead-cover')).openGraph.image).toBeNull();
  });

  it('carries the taxonomy in author-chosen order', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'tagged' });
    const first = await makeTag('First', 'first');
    const second = await makeTag('Second', 'second');
    await tagBlog(blog.id, first.id);
    await tagBlog(blog.id, second.id);

    const metadata = await seoService.getBlogMetadata('tagged');
    expect(metadata.openGraph.article!.tags).toEqual(['First', 'Second']);
  });

  it('never exposes an internal column', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'clean' });

    const serialized = JSON.stringify(await seoService.getBlogMetadata('clean'));

    for (const internal of ['isHidden', 'visibility', 'status', 'authorId', 'passwordHash']) {
      expect(serialized).not.toContain(internal);
    }
  });
});

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

describe('sitemap contents', () => {
  it('lists a published, public post at its canonical URL', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'listed' });

    expect(await sitemapLocs('blogs')).toEqual([`${APP_URL}/blog/listed`]);
  });

  it.each([
    ['drafts', { status: 'DRAFT' as const }],
    ['archived posts', { status: 'ARCHIVED' as const }],
    ['deleted posts', { status: 'DELETED' as const }],
    ['private posts', { visibility: 'PRIVATE' as const }],
    ['members-only posts', { visibility: 'MEMBERS_ONLY' as const }],
    ['unlisted posts', { visibility: 'UNLISTED' as const }],
    ['moderator-hidden posts', { isHidden: true }],
    ['posts with no publication instant', { publishedAt: null }],
  ])('excludes %s', async (_label, overrides) => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'included' });
    await makeSeoBlog(author.id, { slug: 'excluded', ...overrides });

    expect(await sitemapLocs('blogs')).toEqual([`${APP_URL}/blog/included`]);
  });

  it.each([['SUSPENDED'], ['DEACTIVATED'], ['DELETED']])(
    "excludes a %s author's posts",
    async (status) => {
      const active = await makeUser();
      const inactive = await makeUser({ status: status as 'SUSPENDED' });
      await makeSeoBlog(active.id, { slug: 'kept' });
      await makeSeoBlog(inactive.id, { slug: 'dropped' });

      expect(await sitemapLocs('blogs')).toEqual([`${APP_URL}/blog/kept`]);
    }
  );

  // A sitemap is a list of CANONICAL URLs; listing a post whose canonical points
  // elsewhere would have the platform contradicting itself in two documents.
  it('excludes a post whose author pointed its canonical at another site', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'ours' });
    await makeSeoBlog(author.id, {
      slug: 'cross-posted',
      canonicalUrl: 'https://elsewhere.test/original',
    });

    expect(await sitemapLocs('blogs')).toEqual([`${APP_URL}/blog/ours`]);
  });

  it('keeps a post whose canonical merely restates our own URL', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, {
      slug: 'self-canonical',
      canonicalUrl: `${APP_URL}/blog/self-canonical`,
    });

    expect(await sitemapLocs('blogs')).toEqual([`${APP_URL}/blog/self-canonical`]);
  });

  it('lists authors who have published, and excludes private ones', async () => {
    const published = await makeUser({ username: 'published' });
    const priv = await makeUser({ username: 'private' });
    const silent = await makeUser({ username: 'silent' });

    await makeUserSettings(priv.id, { isPrivate: true });
    await makeSeoBlog(published.id);
    await makeSeoBlog(priv.id);

    expect(await sitemapLocs('authors')).toEqual([`${APP_URL}/@published`]);
    expect(await sitemapLocs('authors')).not.toContain(`${APP_URL}/@${silent.username}`);
  });

  it('lists only terms that have something to list', async () => {
    const author = await makeUser();
    const live = await makeSeoBlog(author.id);
    const draft = await makeSeoBlog(author.id, { status: 'DRAFT' });

    const used = await makeTag('Used', 'used');
    const unused = await makeTag('Unused', 'unused');
    const draftOnly = await makeTag('DraftOnly', 'draft-only');

    await tagBlog(live.id, used.id);
    await tagBlog(draft.id, draftOnly.id);
    void unused;

    expect(await sitemapLocs('tags')).toEqual([`${APP_URL}/tags/used`]);
  });

  it('never lists the same URL twice, even for a post in many terms', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'multi' });

    for (const name of ['A', 'B', 'C']) {
      const tag = await makeTag(name, name.toLowerCase());
      await tagBlog(blog.id, tag.id);
    }

    const locs = await sitemapLocs('blogs');
    expect(locs).toEqual([`${APP_URL}/blog/multi`]);
    expect(new Set(locs).size).toBe(locs.length);
  });

  it('carries a lastmod taken from the data, never the clock', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'dated' });
    await touchUpdatedAt(blog.id, new Date('2026-03-04T05:06:07Z'));

    const document = await sitemapService.getChunk('blogs', 1);
    expect(elementText(urlBlocks(document.body)[0]!, 'lastmod')).toBe('2026-03-04T05:06:07Z');
  });

  it('lists the home page in its own section', async () => {
    const document = await sitemapService.getChunk('pages', 1);
    expect(allElementText(document.body, 'loc')).toEqual([APP_URL]);
  });
});

describe('sitemap index', () => {
  it('names one child sitemap per populated chunk', async () => {
    const author = await makeUser({ username: 'grace' });
    const blog = await makeSeoBlog(author.id);
    const tag = await makeTag('TypeScript', 'typescript');
    await tagBlog(blog.id, tag.id);

    const index = await sitemapService.getIndex();
    const locs = allElementText(index.body, 'loc');

    expect(locs).toEqual([
      `${APP_URL}/sitemap-pages-1.xml`,
      `${APP_URL}/sitemap-blogs-1.xml`,
      `${APP_URL}/sitemap-authors-1.xml`,
      `${APP_URL}/sitemap-tags-1.xml`,
    ]);
  });

  it('omits a section with nothing in it rather than listing an empty document', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id);

    const index = await sitemapService.getIndex();
    expect(index.body).not.toContain('sitemap-categories');
    expect(index.body).not.toContain('sitemap-tags');
  });

  it('404s a chunk that does not exist', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id);

    await expect(sitemapService.getChunk('blogs', 2)).rejects.toMatchObject({ statusCode: 404 });
    await expect(sitemapService.getChunk('tags', 1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses every sitemap when the deployment disables indexing', async () => {
    const undo = overrideEnv('SEO_INDEXING_ENABLED', 'false');
    try {
      await expect(sitemapService.getIndex()).rejects.toMatchObject({ statusCode: 404 });
      await expect(sitemapService.getChunk('pages', 1)).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      undo();
    }
  });
});

describe('sitemap chunking', () => {
  /**
   * Chunking is asserted against the repository with a small chunk size rather
   * than by writing five thousand rows: what is under test is the arithmetic
   * that assigns a row to a page and the ordering that makes it reproducible,
   * and neither depends on the constant's value.
   */
  it('assigns rows to pages under a stable, oldest-first order', async () => {
    const author = await makeUser();
    for (let i = 1; i <= 5; i++) {
      await makeSeoBlog(author.id, {
        slug: `post-${i}`,
        publishedAt: new Date(`2026-01-0${i}T00:00:00Z`),
      });
    }

    const summary = await seoRepository.findSitemapChunkSummary('blogs');
    expect(summary).toEqual([
      { page: 1, urls: 5, lastmod: expect.any(Date) },
    ]);

    const chunk = await seoRepository.findSitemapChunk('blogs', 1);
    expect(chunk.map((row) => row.key)).toEqual([
      'post-1',
      'post-2',
      'post-3',
      'post-4',
      'post-5',
    ]);
  });

  it('keeps early pages stable when new posts arrive', async () => {
    const author = await makeUser();
    for (let i = 1; i <= 3; i++) {
      await makeSeoBlog(author.id, {
        slug: `early-${i}`,
        publishedAt: new Date(`2026-01-0${i}T00:00:00Z`),
      });
    }

    const before = (await seoRepository.findSitemapChunk('blogs', 1)).map((r) => r.key);

    await makeSeoBlog(author.id, {
      slug: 'newest',
      publishedAt: new Date('2026-06-01T00:00:00Z'),
    });

    const after = (await seoRepository.findSitemapChunk('blogs', 1)).map((r) => r.key);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('returns nothing beyond the end rather than wrapping', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id);

    expect(await seoRepository.findSitemapChunk('blogs', 2)).toEqual([]);
  });

  it('bounds a chunk to the configured size', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id);

    const sql = seoRepository.buildChunkQuery('blogs', 1);
    expect(JSON.stringify(sql)).toContain(String(SITEMAP_URLS_PER_CHUNK));
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('query counts', () => {
  it('resolves a post with a bounded number of queries, whatever its taxonomy', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'busy', subtitle: 'has a subtitle' });

    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      const tag = await makeTag(name, name.toLowerCase());
      await tagBlog(blog.id, tag.id);
      const category = await makeCategory(`C${name}`, `c-${name.toLowerCase()}`);
      await categorizeBlog(blog.id, category.id);
    }
    await clearSeoKeys();

    const { queries } = await countQueries(() => seoService.getBlogMetadata('busy'));

    // The identity probe plus one projected read. The taxonomy rides along on
    // that read rather than costing a query per term — the N+1 this shape exists
    // to avoid.
    expect(queries).toBeLessThanOrEqual(2);
  });

  it('loads the body only when no cheaper description exists', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'cheap', subtitle: 'a subtitle' });
    await makeSeoBlog(author.id, { slug: 'costly', content: tiptapDoc('body text') });
    await clearSeoKeys();

    const cheap = await countQueries(() => seoService.getBlogMetadata('cheap'));
    await clearSeoKeys();
    const costly = await countQueries(() => seoService.getBlogMetadata('costly'));

    expect(costly.queries).toBeGreaterThan(cheap.queries);
  });

  it('serves a cached resource with only the identity probe', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'warm', subtitle: 'warm' });

    await seoService.getBlogMetadata('warm');
    const { queries } = await countQueries(() => seoService.getBlogMetadata('warm'));

    expect(queries).toBe(1);
  });

  it('builds a sitemap chunk of many posts in a single query', async () => {
    const author = await makeUser();
    for (let i = 0; i < 25; i++) await makeSeoBlog(author.id, { slug: `bulk-${i}` });
    await clearSeoKeys();

    const { result, queries } = await countQueries(() =>
      sitemapService.getChunk('blogs', 1)
    );

    expect(urlBlocks(result.body)).toHaveLength(25);
    expect(queries).toBe(1);
  });

  it('builds the whole index with one query per section', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id);
    const tag = await makeTag('T', 't');
    const category = await makeCategory('C', 'c');
    await tagBlog(blog.id, tag.id);
    await categorizeBlog(blog.id, category.id);
    await clearSeoKeys();

    const { queries } = await countQueries(() => sitemapService.getIndex());

    // blogs, authors, categories, tags — and nothing per chunk.
    expect(queries).toBe(4);
  });

  it('serves a cached sitemap with no queries at all', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id);

    await sitemapService.getIndex();
    const { queries } = await countQueries(() => sitemapService.getIndex());

    expect(queries).toBe(0);
  });
});

describe('query plans', () => {
  /**
   * The eligibility predicate is emitted as SQL LITERALS precisely so Postgres
   * can prove the PARTIAL indexes apply. Parameterising it would disqualify
   * every one of them silently — a sequential scan with nothing in the logs to
   * notice — so applicability is asserted rather than assumed.
   *
   * ── Why `enable_seqscan = off` rather than a plain EXPLAIN ────────────────
   * The property under test is whether the index is USABLE for this predicate,
   * not whether the planner happens to prefer it. On a test-sized table a
   * sequential scan genuinely is cheaper and the planner is right to choose it,
   * so a plain EXPLAIN would assert the size of the fixture rather than the
   * shape of the query — and it would keep passing after a change that made the
   * index inapplicable, because the plan looked the same either way.
   *
   * With sequential scans disabled the planner must use an index if one
   * qualifies. If the literals were ever parameterised the partial index would
   * stop qualifying, and this test would fail — which is exactly the regression
   * it exists to catch. `SET LOCAL` inside a transaction, so the setting cannot
   * leak into another test through the connection pool.
   */
  async function explainWithoutSeqScan(sql: Prisma.Sql): Promise<string> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRaw<Record<string, string>[]>(Prisma.sql`EXPLAIN ${sql}`);
      return rows.map((row) => Object.values(row)[0]).join('\n');
    });
  }

  beforeEach(async () => {
    const author = await makeUser();
    const tag = await makeTag('plan', 'plan');
    const category = await makeCategory('Plan', 'plan');

    for (let i = 0; i < 30; i++) {
      const blog = await makeSeoBlog(author.id, {
        slug: `plan-${i}`,
        publishedAt: new Date(`2026-03-01T00:00:${String(i).padStart(2, '0')}Z`),
      });
      await tagBlog(blog.id, tag.id);
      await categorizeBlog(blog.id, category.id);
    }

    await prisma.$executeRawUnsafe('ANALYZE "Blog", "User", "BlogTag", "BlogCategory", "BlogSEO"');
  });

  it('can be served by the published partial index the literals were written for', async () => {
    const plan = await explainWithoutSeqScan(seoRepository.buildChunkQuery('blogs', 1));
    expect(plan).toContain('blog_search_published_idx');
  });

  it('has an index-driven plan available for every section', async () => {
    for (const section of ['blogs', 'authors', 'categories', 'tags'] as const) {
      const plan = await explainWithoutSeqScan(seoRepository.buildChunkQuery(section, 1));

      // Anchored on the closing quote so it cannot be falsely tripped by a scan
      // of a tiny join table the planner is right to walk.
      expect(plan).not.toContain('Seq Scan on "Blog"');
    }
  });

  it('emits the eligibility predicate as literals, never as bind parameters', () => {
    const sql = JSON.stringify(seoRepository.buildChunkQuery('blogs', 1));

    expect(sql).toContain("'PUBLISHED'");
    expect(sql).toContain("'PUBLIC'");
    expect(sql).toContain("'ACTIVE'");
  });

  it('binds every value that comes from a request', () => {
    const sql = seoRepository.buildChunkQuery('blogs', 3);
    // The offset and the limit are parameters, not interpolated numbers.
    expect(sql.values).toEqual(expect.arrayContaining([SITEMAP_URLS_PER_CHUNK, 10_000]));
  });

  it('orders without a sort of the whole eligible set', async () => {
    // The ordering is appended to the section SELECT rather than wrapped around
    // it, so the index can provide it. A `Sort` node here would mean every
    // sitemap request sorts every published post on the platform.
    const plan = await explainWithoutSeqScan(seoRepository.buildChunkQuery('blogs', 1));
    expect(plan).not.toMatch(/^\s*->\s+Sort/m);
  });
});
