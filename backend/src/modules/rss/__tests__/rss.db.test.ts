import {
  categorizeBlog,
  disconnectDb,
  makeCategory,
  makeTag,
  makeUser,
  resetDb,
  tagBlog,
} from '../../../test/db';
import { prisma } from '../../../core/database/prisma';
import { redis } from '../../../core/providers/redis';
import { AppError } from '../../../core/exceptions/AppError';
import { rssRepository } from '../rss.repository';
import { rssService } from '../rss.service';
import { MAX_ITEM_COUNT } from '../rss.config';
import {
  allElementText,
  attachCover,
  clearRssKeys,
  countQueries,
  elementText,
  itemBlocks,
  makeRssBlog,
  tiptapDoc,
} from './helpers';

/**
 * Real-SQL tests for the RSS module.
 *
 * Nothing here can be established with a mocked Prisma delegate. Eligibility is
 * enforced by literal predicates inside the query text, the join to SEO and
 * Media is exactly the kind of thing that looks right and returns the wrong row
 * count, and "no N+1" is a claim about the number of statements the driver
 * actually sends. These run against the local test database and the test Redis.
 *
 * A note on the fixtures: `publishedAt` and `updatedAt` are always explicit.
 * Ordering IS publication time and every HTTP validator is derived from
 * `updatedAt`, so leaving either to wall-clock time would make the assertions
 * depend on insertion order — the accident the id tiebreak exists to survive.
 */

const day = (n: number) => new Date(`2026-03-${String(n).padStart(2, '0')}T00:00:00Z`);

/** The item titles a feed carries, in the order it serves them. */
const titles = (xml: string) =>
  itemBlocks(xml).map((item) => elementText(item, 'title'));

describe('RSS module (real database)', () => {
  let grace: Awaited<ReturnType<typeof makeUser>>;
  let alan: Awaited<ReturnType<typeof makeUser>>;
  let suspended: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await clearRssKeys();

    grace = await makeUser({ username: 'gracehopper', name: 'Grace Hopper' });
    alan = await makeUser({ username: 'alanturing', name: 'Alan Turing' });
    suspended = await makeUser({ username: 'ghost', name: 'Ghost', status: 'SUSPENDED' });
  });

  afterAll(async () => {
    await clearRssKeys();
    await disconnectDb();
  });

  // -------------------------------------------------------------------------
  // Content eligibility — the security requirement
  // -------------------------------------------------------------------------

  describe('content eligibility', () => {
    beforeEach(async () => {
      await makeRssBlog(grace.id, { title: 'public', publishedAt: day(10) });
      await makeRssBlog(grace.id, { title: 'draft', status: 'DRAFT' });
      await makeRssBlog(grace.id, { title: 'archived', status: 'ARCHIVED', publishedAt: day(9) });
      await makeRssBlog(grace.id, { title: 'deleted', status: 'DELETED', publishedAt: day(8) });
      await makeRssBlog(grace.id, { title: 'private', visibility: 'PRIVATE', publishedAt: day(7) });
      await makeRssBlog(grace.id, { title: 'unlisted', visibility: 'UNLISTED', publishedAt: day(6) });
      await makeRssBlog(grace.id, {
        title: 'members-only',
        visibility: 'MEMBERS_ONLY',
        publishedAt: day(5),
      });
      await makeRssBlog(grace.id, { title: 'hidden', isHidden: true, publishedAt: day(4) });
      await makeRssBlog(grace.id, { title: 'no-published-at', publishedAt: null });
      await makeRssBlog(suspended.id, { title: 'by-suspended', publishedAt: day(11) });
    });

    it('syndicates only published, public content by active authors', async () => {
      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });
      expect(titles(feed.body)).toEqual(['public']);
    });

    it.each([
      ['drafts', 'draft'],
      ['archived posts', 'archived'],
      ['soft-deleted posts', 'deleted'],
      ['private posts', 'private'],
      ['members-only posts', 'members-only'],
      ['moderated posts', 'hidden'],
      ['posts by non-active authors', 'by-suspended'],
      ['published posts with no publication instant', 'no-published-at'],
    ])('never syndicates %s', async (_label, title) => {
      const feed = await rssService.getFeed({ scope: 'global', limit: 50 });
      expect(feed.body).not.toContain(`<title>${title}</title>`);
    });

    it('never syndicates UNLISTED content, which is reachable by link but not broadcast', async () => {
      // `blogService.canView` ALLOWS an unlisted post — that is what unlisted
      // means. A feed document is copied by every subscriber and re-published by
      // aggregators, which converts "reachable by link" into "broadcast".
      const feed = await rssService.getFeed({ scope: 'global', limit: 50 });
      expect(feed.body).not.toContain('unlisted');
    });

    it('applies the same rules to every feed type', async () => {
      const tag = await makeTag('Everything', 'everything');
      const category = await makeCategory('Everything', 'everything');
      for (const blog of await prisma.blog.findMany({ select: { id: true } })) {
        await tagBlog(blog.id, tag.id);
        await categorizeBlog(blog.id, category.id);
      }

      const author = await rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 50 });
      const byTag = await rssService.getFeed({ scope: 'tag', key: 'everything', limit: 50 });
      const byCategory = await rssService.getFeed({
        scope: 'category',
        key: 'everything',
        limit: 50,
      });

      expect(titles(author.body)).toEqual(['public']);
      expect(titles(byTag.body)).toEqual(['public']);
      expect(titles(byCategory.body)).toEqual(['public']);
    });

    it('drops an author’s whole catalogue the moment their account leaves ACTIVE', async () => {
      await prisma.user.update({ where: { id: grace.id }, data: { status: 'SUSPENDED' } });
      await clearRssKeys();

      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });
      expect(itemBlocks(feed.body)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Feed types
  // -------------------------------------------------------------------------

  describe('feed types', () => {
    let engineering: Awaited<ReturnType<typeof makeCategory>>;
    let typescriptTag: Awaited<ReturnType<typeof makeTag>>;

    beforeEach(async () => {
      engineering = await makeCategory('Engineering', 'engineering');
      typescriptTag = await makeTag('typescript', 'typescript');

      const a = await makeRssBlog(grace.id, { title: 'Grace One', publishedAt: day(3) });
      const b = await makeRssBlog(grace.id, { title: 'Grace Two', publishedAt: day(2) });
      const c = await makeRssBlog(alan.id, { title: 'Alan One', publishedAt: day(1) });

      await categorizeBlog(a.id, engineering.id);
      await tagBlog(a.id, typescriptTag.id);
      await tagBlog(c.id, typescriptTag.id);
      void b;
    });

    it('serves the global feed newest first', async () => {
      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });
      expect(titles(feed.body)).toEqual(['Grace One', 'Grace Two', 'Alan One']);
    });

    it('serves an author feed containing only that author', async () => {
      const feed = await rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 20 });
      expect(titles(feed.body)).toEqual(['Grace One', 'Grace Two']);
      expect(elementText(feed.body, 'title')).toBe('Grace Hopper — Narrative');
    });

    it('serves a category feed', async () => {
      const feed = await rssService.getFeed({
        scope: 'category',
        key: 'engineering',
        limit: 20,
      });
      expect(titles(feed.body)).toEqual(['Grace One']);
      expect(elementText(feed.body, 'title')).toBe('Engineering — Narrative');
    });

    it('serves a tag feed spanning authors', async () => {
      const feed = await rssService.getFeed({ scope: 'tag', key: 'typescript', limit: 20 });
      expect(titles(feed.body)).toEqual(['Grace One', 'Alan One']);
      expect(elementText(feed.body, 'title')).toBe('#typescript — Narrative');
    });

    it('gives each feed a distinct, stable identity', async () => {
      const feeds = await Promise.all([
        rssService.getFeed({ scope: 'global', limit: 20 }),
        rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 20 }),
        rssService.getFeed({ scope: 'category', key: 'engineering', limit: 20 }),
        rssService.getFeed({ scope: 'tag', key: 'typescript', limit: 20 }),
      ]);

      const ids = feeds.map((feed) => elementText(feed.body, 'atom:id'));
      expect(new Set(ids).size).toBe(4);
      expect(ids[0]).toBe('urn:narrative:feed:global');
      expect(ids[1]).toBe(`urn:narrative:feed:author:${grace.id}`);
    });

    it('serves an empty but valid feed for a subject with no eligible posts', async () => {
      const empty = await makeTag('empty', 'empty');
      void empty;

      const feed = await rssService.getFeed({ scope: 'tag', key: 'empty', limit: 20 });

      expect(feed.itemCount).toBe(0);
      expect(feed.lastModified).toBeNull();
      expect(feed.body).toContain('</channel>');
      expect(feed.body).toContain('</rss>');
      // Still gets a validator, so a polling reader can be told 304.
      expect(feed.etag).toMatch(/^"[0-9a-f]{32}"$/);
    });
  });

  // -------------------------------------------------------------------------
  // Subject resolution
  // -------------------------------------------------------------------------

  describe('subject resolution', () => {
    it('404s an unknown author, category or tag', async () => {
      await expect(
        rssService.getFeed({ scope: 'author', key: 'nobody', limit: 20 })
      ).rejects.toThrow(AppError);
      await expect(
        rssService.getFeed({ scope: 'category', key: 'nope', limit: 20 })
      ).rejects.toMatchObject({ statusCode: 404, errorCode: 'FEED_NOT_FOUND' });
      await expect(
        rssService.getFeed({ scope: 'tag', key: 'nope', limit: 20 })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it.each([['SUSPENDED'], ['DEACTIVATED'], ['DELETED']] as const)(
      'makes a %s account indistinguishable from one that never existed',
      async (status) => {
        await prisma.user.update({ where: { id: alan.id }, data: { status } });

        const refuse = (username: string): Promise<AppError> =>
          rssService
            .getFeed({ scope: 'author', key: username, limit: 20 })
            .then(() => {
              throw new Error(`expected ${username} to be refused`);
            })
            .catch((err: AppError) => err);

        const missing = await refuse('nobody-at-all');
        const inactive = await refuse('alanturing');

        // Any difference here turns a public endpoint into an oracle for who
        // has been suspended.
        expect(inactive.statusCode).toBe(missing.statusCode);
        expect(inactive.errorCode).toBe(missing.errorCode);
        expect(inactive.message).toBe(missing.message);
      }
    );

    it('serves a private profile’s public writing, matching blog search', async () => {
      // `UserSettings.isPrivate` hides a user from the PEOPLE DIRECTORY, not
      // their published public posts — so the platform's discovery surfaces
      // cannot disagree about whether an author's public writing exists.
      await prisma.userSettings.create({ data: { userId: grace.id, isPrivate: true } });
      await makeRssBlog(grace.id, { title: 'Still Public', publishedAt: day(3) });

      const feed = await rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 20 });
      expect(titles(feed.body)).toEqual(['Still Public']);
    });

    it('states an author’s configured language and refuses a nonsense one', async () => {
      await prisma.userSettings.create({ data: { userId: grace.id, language: 'fr' } });
      await prisma.userSettings.create({ data: { userId: alan.id, language: '<>' } });
      await makeRssBlog(grace.id, { publishedAt: day(3) });
      await makeRssBlog(alan.id, { publishedAt: day(3) });

      const french = await rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 20 });
      const nonsense = await rssService.getFeed({ scope: 'author', key: 'alanturing', limit: 20 });

      expect(elementText(french.body, 'language')).toBe('fr');
      expect(elementText(nonsense.body, 'language')).toBe('en');
    });
  });

  // -------------------------------------------------------------------------
  // Item content
  // -------------------------------------------------------------------------

  describe('item content', () => {
    it('carries the identity, link, dates and author of a post', async () => {
      const blog = await makeRssBlog(grace.id, {
        title: 'A Post',
        slug: 'a-post',
        subtitle: 'A subtitle',
        publishedAt: day(5),
        updatedAt: day(6),
      });

      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });
      const item = itemBlocks(feed.body)[0] as string;

      expect(item).toContain(`<guid isPermaLink="false">urn:narrative:blog:${blog.id}</guid>`);
      expect(elementText(item, 'link')).toContain('/blog/a-post');
      expect(elementText(item, 'description')).toBe('A subtitle');
      expect(elementText(item, 'dc:creator')).toBe('Grace Hopper');
      expect(elementText(item, 'pubDate')).toBe('Thu, 05 Mar 2026 00:00:00 GMT');
      expect(elementText(item, 'atom:updated')).toBe('2026-03-06T00:00:00.000Z');
    });

    it('keeps a GUID stable when the title and slug change', async () => {
      // The property the scheme exists for: a URL-based GUID would resurface a
      // renamed post in every subscriber's unread list and leave the original
      // behind as a permanent duplicate.
      const blog = await makeRssBlog(grace.id, { title: 'Before', slug: 'before', publishedAt: day(5) });
      const before = await rssService.getFeed({ scope: 'global', limit: 20 });

      await prisma.blog.update({
        where: { id: blog.id },
        data: { title: 'After', slug: 'after' },
      });
      await clearRssKeys();
      const after = await rssService.getFeed({ scope: 'global', limit: 20 });

      const guid = `urn:narrative:blog:${blog.id}`;
      expect(before.body).toContain(guid);
      expect(after.body).toContain(guid);
      expect(after.body).toContain('<title>After</title>');
      expect(elementText(itemBlocks(after.body)[0] as string, 'link')).toContain('/blog/after');
    });

    it('prefers the SEO description, then the subtitle, then the body', async () => {
      await makeRssBlog(grace.id, {
        title: 'Seo',
        publishedAt: day(3),
        subtitle: 'sub',
        metaDescription: 'the seo summary',
        content: tiptapDoc('the body'),
      });
      await makeRssBlog(grace.id, {
        title: 'Sub',
        publishedAt: day(2),
        subtitle: 'the subtitle',
        content: tiptapDoc('the body'),
      });
      await makeRssBlog(grace.id, {
        title: 'Body',
        publishedAt: day(1),
        content: tiptapDoc('the body text'),
      });

      const items = itemBlocks((await rssService.getFeed({ scope: 'global', limit: 20 })).body);
      expect(items.map((item) => elementText(item, 'description'))).toEqual([
        'the seo summary',
        'the subtitle',
        'the body text',
      ]);
    });

    it('honours an author’s canonical URL but refuses a dangerous scheme', async () => {
      await makeRssBlog(grace.id, {
        title: 'Canonical',
        slug: 'canonical',
        publishedAt: day(3),
        canonicalUrl: 'https://elsewhere.test/original',
      });
      await makeRssBlog(grace.id, {
        title: 'Hostile',
        slug: 'hostile',
        publishedAt: day(2),
        canonicalUrl: 'javascript:alert(1)',
      });

      const items = itemBlocks((await rssService.getFeed({ scope: 'global', limit: 20 })).body);

      expect(elementText(items[0] as string, 'link')).toBe('https://elsewhere.test/original');
      // Falls back to the URL the platform derived itself rather than handing
      // every subscriber's reader an executable href.
      expect(elementText(items[1] as string, 'link')).toContain('/blog/hostile');
      expect((await rssService.getFeed({ scope: 'global', limit: 20 })).body).not.toContain(
        'javascript:'
      );
    });

    it('renders categories before tags, each in the order the author chose', async () => {
      const blog = await makeRssBlog(grace.id, { publishedAt: day(3) });
      const engineering = await makeCategory('Engineering', 'engineering');
      const first = await makeTag('first', 'first');
      const second = await makeTag('second', 'second');

      await categorizeBlog(blog.id, engineering.id);
      await tagBlog(blog.id, first.id);
      await tagBlog(blog.id, second.id);

      const item = itemBlocks((await rssService.getFeed({ scope: 'global', limit: 20 })).body)[0]!;
      expect(allElementText(item, 'category')).toEqual(['Engineering', 'first', 'second']);
    });

    it('publishes a cover as an enclosure, and never its storage path', async () => {
      const blog = await makeRssBlog(grace.id, { publishedAt: day(3) });
      await attachCover(blog.id, grace.id, {
        secureUrl: 'https://cdn.test/covers/a.jpg',
        mimeType: 'image/png',
        fileSize: 4242,
      });

      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });

      expect(feed.body).toContain(
        '<enclosure url="https://cdn.test/covers/a.jpg" type="image/png" length="4242" />'
      );
      expect(feed.body).not.toContain('secret-internal-path');
    });

    it('stays valid when a cover’s asset has been deleted', async () => {
      const blog = await makeRssBlog(grace.id, { title: 'No Cover', publishedAt: day(3) });
      await attachCover(blog.id, grace.id, { deletedAt: new Date() });

      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });

      expect(feed.body).not.toContain('<enclosure');
      expect(titles(feed.body)).toEqual(['No Cover']);
    });

    it('derives lastBuildDate from the data, not the clock', async () => {
      await makeRssBlog(grace.id, { publishedAt: day(1), updatedAt: day(4) });
      await makeRssBlog(grace.id, { publishedAt: day(3), updatedAt: day(2) });

      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });

      // The newest MODIFICATION, not the newest publication — a corrected post
      // must move the channel's build date so readers refetch.
      expect(feed.lastModified?.toISOString()).toBe(day(4).toISOString());
      expect(elementText(feed.body, 'lastBuildDate')).toBe('Wed, 04 Mar 2026 00:00:00 GMT');
    });
  });

  // -------------------------------------------------------------------------
  // Bounds
  // -------------------------------------------------------------------------

  describe('bounded feeds', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 12; i++) {
        await makeRssBlog(grace.id, {
          title: `Post ${i}`,
          publishedAt: new Date(`2026-03-01T00:00:${String(i).padStart(2, '0')}Z`),
        });
      }
    });

    it('serves exactly the requested number of items', async () => {
      const feed = await rssService.getFeed({ scope: 'global', limit: 5 });
      expect(feed.itemCount).toBe(5);
      expect(itemBlocks(feed.body)).toHaveLength(5);
    });

    it('serves the NEWEST items when the feed is trimmed', async () => {
      const feed = await rssService.getFeed({ scope: 'global', limit: 3 });
      expect(titles(feed.body)).toEqual(['Post 12', 'Post 11', 'Post 10']);
    });

    it('cannot be made to return more than the ceiling', async () => {
      // No cursor exists anywhere in this module, so MAX_ITEM_COUNT is the depth
      // of the entire syndication surface.
      const rows = await rssRepository.findFeedRows({
        scope: 'global',
        subjectId: null,
        limit: MAX_ITEM_COUNT,
      });
      expect(rows.length).toBeLessThanOrEqual(MAX_ITEM_COUNT);
    });
  });

  // -------------------------------------------------------------------------
  // Performance
  // -------------------------------------------------------------------------

  describe('performance', () => {
    beforeEach(async () => {
      const engineering = await makeCategory('Engineering', 'engineering');
      const tags = await Promise.all([
        makeTag('a', 'a'),
        makeTag('b', 'b'),
        makeTag('c', 'c'),
      ]);

      for (let i = 1; i <= 20; i++) {
        const blog = await makeRssBlog(grace.id, {
          title: `Post ${i}`,
          subtitle: `Subtitle ${i}`,
          publishedAt: new Date(`2026-03-01T00:00:${String(i).padStart(2, '0')}Z`),
        });
        await categorizeBlog(blog.id, engineering.id);
        for (const tag of tags) await tagBlog(blog.id, tag.id);
      }
    });

    it('builds a 20-item feed in a constant number of queries', async () => {
      await clearRssKeys();
      const { result, queries } = await countQueries(() =>
        rssService.getFeed({ scope: 'global', limit: 20 })
      );

      expect(result.itemCount).toBe(20);
      // rows + tags + categories. Every item here has a subtitle, so no body is
      // loaded at all — which is the whole reason `content` is out of the main
      // projection.
      expect(queries).toBe(3);
    });

    it('issues the same number of queries for one item as for twenty', async () => {
      // The definition of "no N+1": query count must not scale with page size.
      await clearRssKeys();
      const small = await countQueries(() => rssService.getFeed({ scope: 'global', limit: 1 }));
      await clearRssKeys();
      const large = await countQueries(() => rssService.getFeed({ scope: 'global', limit: 20 }));

      expect(large.queries).toBe(small.queries);
    });

    it('adds exactly one query when bodies are needed, however many need them', async () => {
      await prisma.blog.updateMany({ data: { subtitle: null } });
      await prisma.blogSEO.deleteMany();
      await prisma.blog.updateMany({ data: { content: tiptapDoc('body text') as never } });
      await clearRssKeys();

      const { result, queries } = await countQueries(() =>
        rssService.getFeed({ scope: 'global', limit: 20 })
      );

      expect(queries).toBe(4);
      expect(elementText(itemBlocks(result.body)[0] as string, 'description')).toBe('body text');
    });

    it('adds one subject lookup for a scoped feed and nothing else', async () => {
      await clearRssKeys();
      const { queries } = await countQueries(() =>
        rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 20 })
      );
      expect(queries).toBe(4);
    });

    it('costs a warm scoped feed exactly one indexed lookup', async () => {
      // The subject is resolved BEFORE the cache is consulted, so the cache can
      // be keyed on a database id rather than on a slug that can be renamed.
      // See rss.service — this is the price of that, and it is the whole price.
      await rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 20 });
      const { queries } = await countQueries(() =>
        rssService.getFeed({ scope: 'author', key: 'gracehopper', limit: 20 })
      );
      expect(queries).toBe(1);
    });

    it('does not multiply blog rows by their tag count', async () => {
      // Each post here carries three tags and a category. A LEFT JOIN would
      // return four rows per post before the LIMIT, quietly shrinking the feed.
      const rows = await rssRepository.findFeedRows({
        scope: 'global',
        subjectId: null,
        limit: 20,
      });
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((row) => row.id)).size).toBe(20);
    });

    it('serves a cache hit with no database access at all', async () => {
      await rssService.getFeed({ scope: 'global', limit: 20 });
      const { queries } = await countQueries(() =>
        rssService.getFeed({ scope: 'global', limit: 20 })
      );
      expect(queries).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Query plans
  // -------------------------------------------------------------------------

  describe('query plans', () => {
    beforeEach(async () => {
      const tag = await makeTag('plan', 'plan');
      const category = await makeCategory('Plan', 'plan');
      for (let i = 1; i <= 30; i++) {
        const blog = await makeRssBlog(grace.id, {
          publishedAt: new Date(`2026-03-01T00:00:${String(i).padStart(2, '0')}Z`),
        });
        await tagBlog(blog.id, tag.id);
        await categorizeBlog(blog.id, category.id);
      }
      // The planner will happily sequential-scan a tiny table whatever the
      // indexes say. Statistics make the choice meaningful.
      await prisma.$executeRawUnsafe('ANALYZE "Blog", "BlogTag", "BlogCategory", "User"');
    });

    it.each([
      ['global', null],
      ['author', 'author'],
      ['tag', 'tag'],
      ['category', 'category'],
    ] as const)('plans the %s feed without a sequential scan of Blog', async (scope, kind) => {
      const subjectId =
        kind === 'author'
          ? grace.id
          : kind === 'tag'
            ? (await prisma.tag.findUniqueOrThrow({ where: { slug: 'plan' } })).id
            : kind === 'category'
              ? (await prisma.category.findUniqueOrThrow({ where: { slug: 'plan' } })).id
              : null;

      // EXPLAIN over the statement the repository actually builds, not a copy
      // of it that would drift the first time that file changes.
      const query = rssRepository.buildFeedQuery({ scope, subjectId, limit: 20 });
      const plan = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`EXPLAIN ${query}`;
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');

      // Anchored on the closing quote so it cannot be satisfied — or falsely
      // tripped — by a scan of "BlogTag" or "BlogCategory", which are tiny
      // join tables the planner is right to scan.
      expect(text).not.toContain('Seq Scan on "Blog"');
    });

    it('uses the partial published index the eligibility literals were written for', async () => {
      const query = rssRepository.buildFeedQuery({
        scope: 'global',
        subjectId: null,
        limit: 20,
      });
      const plan = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`EXPLAIN ${query}`;
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');

      // Parameterising the status/visibility predicate would silently
      // disqualify this index and turn every feed into a sequential scan, with
      // nothing in the logs to notice.
      expect(text).toContain('blog_search_published_idx');
    });
  });

  // -------------------------------------------------------------------------
  // Caching and invalidation
  // -------------------------------------------------------------------------

  describe('caching', () => {
    beforeEach(async () => {
      await makeRssBlog(grace.id, { title: 'First', publishedAt: day(1) });
    });

    it('serves a second identical request from Redis', async () => {
      const first = await rssService.getFeed({ scope: 'global', limit: 20 });
      const second = await rssService.getFeed({ scope: 'global', limit: 20 });

      expect(second.body).toBe(first.body);
      expect(second.etag).toBe(first.etag);
    });

    it('mints the same ETag for an unchanged feed across regenerations', async () => {
      // The whole point of deriving lastBuildDate from the data: a rebuild that
      // produced a different validator would make every subscriber download
      // every feed on every poll.
      const first = await rssService.getFeed({ scope: 'global', limit: 20 });
      await clearRssKeys();
      const rebuilt = await rssService.getFeed({ scope: 'global', limit: 20 });

      expect(rebuilt.etag).toBe(first.etag);
      expect(rebuilt.body).toBe(first.body);
    });

    it('keeps feeds and limits on separate entries', async () => {
      const twenty = await rssService.getFeed({ scope: 'global', limit: 20 });
      await makeRssBlog(grace.id, { title: 'Second', publishedAt: day(2) });

      // Still cached under limit=20...
      expect((await rssService.getFeed({ scope: 'global', limit: 20 })).body).toBe(twenty.body);
      // ...but limit=10 is a different document and is built fresh.
      const ten = await rssService.getFeed({ scope: 'global', limit: 10 });
      expect(titles(ten.body)).toContain('Second');
    });

    it('degrades to database generation when Redis is unavailable', async () => {
      const get = jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down') as never);
      const set = jest.spyOn(redis, 'set').mockRejectedValue(new Error('redis down') as never);
      const pipeline = jest.spyOn(redis, 'pipeline').mockImplementation(() => {
        throw new Error('redis down');
      });

      try {
        const feed = await rssService.getFeed({ scope: 'global', limit: 20 });
        expect(titles(feed.body)).toEqual(['First']);
      } finally {
        get.mockRestore();
        set.mockRestore();
        pipeline.mockRestore();
      }
    });
  });

  describe('invalidation', () => {
    it('drops the feeds a post belongs to, and only those', async () => {
      const engineering = await makeCategory('Engineering', 'engineering');
      const typescriptTag = await makeTag('typescript', 'typescript');
      const design = await makeCategory('Design', 'design');
      const rust = await makeTag('rust', 'rust');

      const blog = await makeRssBlog(grace.id, { title: 'First', publishedAt: day(1) });
      await categorizeBlog(blog.id, engineering.id);
      await tagBlog(blog.id, typescriptTag.id);

      const other = await makeRssBlog(alan.id, { title: 'Alan', publishedAt: day(1) });
      await categorizeBlog(other.id, design.id);
      await tagBlog(other.id, rust.id);

      // Warm every feed, so a later rebuild is visible as database work.
      const feeds = {
        global: { scope: 'global' as const, key: undefined },
        grace: { scope: 'author' as const, key: 'gracehopper' },
        alan: { scope: 'author' as const, key: 'alanturing' },
        engineering: { scope: 'category' as const, key: 'engineering' },
        design: { scope: 'category' as const, key: 'design' },
        typescript: { scope: 'tag' as const, key: 'typescript' },
        rust: { scope: 'tag' as const, key: 'rust' },
      };
      for (const feed of Object.values(feeds)) {
        await rssService.getFeed({ ...feed, limit: 20 });
      }

      await rssService.invalidateForBlog(blog.id, grace.id);

      // Whether a feed was invalidated is not visible in its BYTES — a feed
      // whose content did not actually change re-renders to the same document
      // and keeps its ETag, which is exactly what should happen. What is
      // visible is whether the request had to touch the database beyond the
      // one subject lookup a scoped feed always pays (see rss.service).
      const rebuilt: Record<string, boolean> = {};
      for (const [name, feed] of Object.entries(feeds)) {
        const { queries } = await countQueries(() =>
          rssService.getFeed({ ...feed, limit: 20 })
        );
        const cachedCost = feed.scope === 'global' ? 0 : 1;
        rebuilt[name] = queries > cachedCost;
      }

      expect(rebuilt).toEqual({
        // Feeds the post belongs to: dropped and rebuilt.
        global: true,
        grace: true,
        engineering: true,
        typescript: true,
        // Everything else still serving its cached entry. This is what "not
        // blindly invalidating every author/category/tag feed" means in
        // practice.
        alan: false,
        design: false,
        rust: false,
      });
    });

    it('makes a newly published post appear in the feeds it belongs to', async () => {
      const engineering = await makeCategory('Engineering', 'engineering');
      const first = await makeRssBlog(grace.id, { title: 'First', publishedAt: day(1) });
      await categorizeBlog(first.id, engineering.id);

      await rssService.getFeed({ scope: 'global', limit: 20 });
      await rssService.getFeed({ scope: 'category', key: 'engineering', limit: 20 });

      const second = await makeRssBlog(grace.id, { title: 'Second', publishedAt: day(2) });
      await categorizeBlog(second.id, engineering.id);
      await rssService.invalidateForBlog(second.id, grace.id);

      expect(titles((await rssService.getFeed({ scope: 'global', limit: 20 })).body)).toEqual([
        'Second',
        'First',
      ]);
      expect(
        titles(
          (await rssService.getFeed({ scope: 'category', key: 'engineering', limit: 20 })).body
        )
      ).toEqual(['Second', 'First']);
    });

    it('drops every feed when a catalogue leaves discovery', async () => {
      await makeRssBlog(grace.id, { title: 'Gone', publishedAt: day(1) });
      const warm = await rssService.getFeed({ scope: 'global', limit: 20 });
      expect(titles(warm.body)).toEqual(['Gone']);

      await prisma.user.update({ where: { id: grace.id }, data: { status: 'SUSPENDED' } });
      await rssService.invalidateEverything();

      // Without the invalidation the cached document would keep being served —
      // and re-served to conditional requests as a 304 — for the rest of its
      // TTL, long after a moderator acted.
      const after = await rssService.getFeed({ scope: 'global', limit: 20 });
      expect(itemBlocks(after.body)).toHaveLength(0);
    });

    it('still invalidates when the post can no longer be resolved', async () => {
      await makeRssBlog(grace.id, { title: 'First', publishedAt: day(1) });
      const warm = await rssService.getFeed({ scope: 'global', limit: 20 });

      await makeRssBlog(grace.id, { title: 'Second', publishedAt: day(2) });
      // A hard-deleted row, or a race with another write.
      await rssService.invalidateForBlog('does-not-exist', grace.id);

      const after = await rssService.getFeed({ scope: 'global', limit: 20 });
      expect(after.etag).not.toBe(warm.etag);
      expect(titles(after.body)).toContain('Second');
    });
  });

  // -------------------------------------------------------------------------
  // Hostile content
  // -------------------------------------------------------------------------

  describe('hostile content', () => {
    it('escapes user-authored titles, names and tags end to end', async () => {
      await prisma.user.update({
        where: { id: grace.id },
        data: { name: 'Bobby <b>Tables</b> & Co' },
      });
      const blog = await makeRssBlog(grace.id, {
        title: '</title><script>alert(1)</script>',
        subtitle: ']]></description><item><title>injected</title></item>',
        publishedAt: day(1),
      });
      const tag = await makeTag('<img src=x onerror=alert(1)>', 'evil');
      await tagBlog(blog.id, tag.id);

      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });

      expect(feed.body).not.toContain('<script>');
      expect(feed.body).not.toContain('<img');
      expect(feed.body).not.toContain('<title>injected</title>');
      // Exactly one item, so nothing escaped its element and forged another.
      expect(itemBlocks(feed.body)).toHaveLength(1);
    });

    it('publishes the rest of a feed when one post cannot be rendered', async () => {
      await makeRssBlog(grace.id, { title: 'Good One', publishedAt: day(2) });
      await makeRssBlog(grace.id, { title: 'Bad One', publishedAt: day(1) });

      // A row the mapping cannot handle — the shape a corrupt column or an
      // unexpected driver value would produce.
      const original = rssRepository.findFeedRows.bind(rssRepository);
      const spy = jest
        .spyOn(rssRepository, 'findFeedRows')
        .mockImplementation(async (params) => {
          const rows = await original(params);
          return rows.map((row) =>
            row.title === 'Bad One'
              ? ({
                  ...row,
                  get authorUsername(): string {
                    throw new Error('corrupt row');
                  },
                } as typeof row)
              : row
          );
        });

      try {
        await clearRssKeys();
        const feed = await rssService.getFeed({ scope: 'global', limit: 20 });

        // One missing item, nineteen delivered — not a 500 for every
        // subscriber polling at that moment.
        expect(titles(feed.body)).toEqual(['Good One']);
        expect(feed.body).toContain('</rss>');
      } finally {
        spy.mockRestore();
      }
    });

    it('never leaks internal state into a document', async () => {
      await makeRssBlog(grace.id, { title: 'A Post', publishedAt: day(1) });
      const feed = await rssService.getFeed({ scope: 'global', limit: 20 });

      for (const secret of ['PUBLISHED', 'isHidden', 'visibility', 'authorId', '@test.local']) {
        expect(feed.body).not.toContain(secret);
      }
    });
  });
});
