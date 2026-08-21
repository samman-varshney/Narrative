import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../core/database/prisma';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import {
  categorizeBlog,
  makeCategory,
  makeTag,
  makeUser,
  makeUserSettings,
  resetDb,
  tagBlog,
} from '../../../test/db';
import {
  registerSeoSubscribers,
  resetSeoSubscriberRegistration,
} from '../subscribers';
import {
  allElementText,
  clearSeoKeys,
  makeSeoBlog,
  metaContent,
  overrideEnv,
  touchUpdatedAt,
} from './helpers';

/**
 * The whole path, end to end: a real database, a real Redis, the real Express
 * app, and the real event subscribers.
 *
 * Nothing is mocked. What these tests exercise is the composition — that
 * eligibility survives caching, that an event actually reaches a cache key, and
 * that hostile content stays hostile-free all the way to the wire. The unit
 * suites prove each rule; this one proves they are wired together.
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

  eventBus.clearHandlers();
  resetSeoSubscriberRegistration();
  registerSeoSubscribers();
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  eventBus.clearHandlers();
  resetSeoSubscriberRegistration();
});

afterAll(async () => {
  await clearSeoKeys();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('a complete page', () => {
  it('describes a post with everything a renderer needs', async () => {
    const author = await makeUser({ username: 'grace', name: 'Grace Hopper' });
    const blog = await makeSeoBlog(author.id, {
      slug: 'on-compilers',
      title: 'On Compilers',
      subtitle: 'A short tour of the front end',
    });
    const category = await makeCategory('Engineering', 'engineering');
    const tag = await makeTag('TypeScript', 'typescript');
    await categorizeBlog(blog.id, category.id);
    await tagBlog(blog.id, tag.id);
    await touchUpdatedAt(blog.id, new Date('2026-02-01T00:00:00Z'));

    const res = await request(app).get('/api/v1/seo/blogs/on-compilers');
    const data = res.body.data;

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      resource: 'blog',
      title: 'On Compilers — Narrative',
      description: 'A short tour of the front end',
      canonicalUrl: `${APP_URL}/blog/on-compilers`,
      robots: { index: true, follow: true, directive: 'index, follow' },
      openGraph: {
        type: 'article',
        siteName: 'Narrative',
        title: 'On Compilers',
        url: `${APP_URL}/blog/on-compilers`,
        article: { section: 'Engineering', tags: ['TypeScript'] },
      },
      twitter: { card: 'summary' },
      breadcrumbs: [
        { name: 'Home', url: APP_URL },
        { name: 'Engineering', url: `${APP_URL}/categories/engineering` },
        { name: 'On Compilers', url: `${APP_URL}/blog/on-compilers` },
      ],
    });

    const posting = data.structuredData.find(
      (n: Record<string, unknown>) => n['@type'] === 'BlogPosting'
    );
    expect(posting).toMatchObject({
      headline: 'On Compilers',
      datePublished: '2026-01-01T00:00:00.000Z',
      dateModified: '2026-02-01T00:00:00.000Z',
      author: { name: 'Grace Hopper' },
    });
  });

  it('renders the same resolution as head tags', async () => {
    const author = await makeUser({ username: 'grace' });
    await makeSeoBlog(author.id, { slug: 'on-compilers', title: 'On Compilers' });

    const res = await request(app).get('/api/v1/seo/blogs/on-compilers?format=html');

    expect(res.text).toContain('<title>On Compilers — Narrative</title>');
    expect(res.text).toContain(`<link rel="canonical" href="${APP_URL}/blog/on-compilers" />`);
    expect(metaContent(res.text, 'robots')).toBe('index, follow');
    expect(metaContent(res.text, 'og:type')).toBe('article');
    expect(res.text).toContain('application/ld+json');
  });
});

describe('a complete crawl', () => {
  it('leads a crawler from robots.txt to every public URL', async () => {
    const author = await makeUser({ username: 'grace' });
    const blog = await makeSeoBlog(author.id, { slug: 'on-compilers' });
    const category = await makeCategory('Engineering', 'engineering');
    const tag = await makeTag('TypeScript', 'typescript');
    await categorizeBlog(blog.id, category.id);
    await tagBlog(blog.id, tag.id);

    // 1. robots.txt names the sitemap.
    const robots = await request(app).get('/robots.txt');
    expect(robots.text).toContain(`Sitemap: ${APP_URL}/sitemap.xml`);

    // 2. The index names its children.
    const index = await request(app).get('/sitemap.xml');
    const children = allElementText(index.text, 'loc');
    expect(children).toContain(`${APP_URL}/sitemap-blogs-1.xml`);

    // 3. Every child resolves, and between them they list every public page.
    const found: string[] = [];
    for (const child of children) {
      const chunk = await request(app).get(new URL(child).pathname);
      expect(chunk.status).toBe(200);
      found.push(...allElementText(chunk.text, 'loc'));
    }

    expect(found).toEqual(
      expect.arrayContaining([
        APP_URL,
        `${APP_URL}/blog/on-compilers`,
        `${APP_URL}/@grace`,
        `${APP_URL}/categories/engineering`,
        `${APP_URL}/tags/typescript`,
      ])
    );
    expect(new Set(found).size).toBe(found.length);
  });

  it('every sitemap URL agrees with that page\'s own canonical', async () => {
    const author = await makeUser({ username: 'grace' });
    await makeSeoBlog(author.id, { slug: 'on-compilers' });

    const chunk = await request(app).get('/sitemap-blogs-1.xml');
    const [loc] = allElementText(chunk.text, 'loc');

    const metadata = await request(app).get('/api/v1/seo/blogs/on-compilers');
    expect(metadata.body.data.canonicalUrl).toBe(loc);
  });

  it('turns the whole surface off when indexing is disabled', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'on-compilers' });

    const undo = overrideEnv('SEO_INDEXING_ENABLED', 'false');
    try {
      await clearSeoKeys();

      const robots = await request(app).get('/robots.txt');
      expect(robots.text).toMatch(/^Disallow: \/$/m);
      expect(robots.text).not.toContain('Sitemap:');

      expect((await request(app).get('/sitemap.xml')).status).toBe(404);

      const metadata = await request(app).get('/api/v1/seo/blogs/on-compilers');
      expect(metadata.body.data.robots.directive).toBe('noindex, nofollow');
    } finally {
      undo();
    }
  });
});

describe('conditional requests', () => {
  it('answers a repeat crawl of the sitemap with 304', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id);

    const first = await request(app).get('/sitemap-blogs-1.xml');
    const second = await request(app)
      .get('/sitemap-blogs-1.xml')
      .set('If-None-Match', first.headers.etag);

    expect(first.status).toBe(200);
    expect(second.status).toBe(304);
  });

  it('mints the same ETag for an unchanged sitemap across regenerations', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id);

    const first = await request(app).get('/sitemap-blogs-1.xml');
    await clearSeoKeys(); // force a rebuild from the database
    const second = await request(app).get('/sitemap-blogs-1.xml');

    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('mints a new ETag once the content really changes', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'first' });

    const before = await request(app).get('/sitemap-blogs-1.xml');

    await makeSeoBlog(author.id, { slug: 'second' });
    await clearSeoKeys();

    const after = await request(app).get('/sitemap-blogs-1.xml');
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });
});

describe('event-driven invalidation', () => {
  it('publishes a new post into the sitemap without waiting for a TTL', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'first' });

    // Warm the cache.
    expect(allElementText((await request(app).get('/sitemap-blogs-1.xml')).text, 'loc')).toEqual([
      `${APP_URL}/blog/first`,
    ]);

    const second = await makeSeoBlog(author.id, { slug: 'second' });
    eventBus.emit(EVENTS.BLOG_PUBLISHED, { blogId: second.id, authorId: author.id });
    await eventBus.settled();

    const locs = allElementText((await request(app).get('/sitemap-blogs-1.xml')).text, 'loc');
    expect(locs).toEqual([`${APP_URL}/blog/first`, `${APP_URL}/blog/second`]);
  });

  it('drops a post from the metadata cache when it is edited', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'edited', title: 'Before' });

    expect((await request(app).get('/api/v1/seo/blogs/edited')).body.data.title).toBe(
      'Before — Narrative'
    );

    await prisma.blog.update({ where: { id: blog.id }, data: { title: 'After' } });
    eventBus.emit(EVENTS.BLOG_UPDATED, { blogId: blog.id, authorId: author.id });
    await eventBus.settled();

    expect((await request(app).get('/api/v1/seo/blogs/edited')).body.data.title).toBe(
      'After — Narrative'
    );
  });

  it('takes a suspended author out of every cached surface immediately', async () => {
    const author = await makeUser({ username: 'grace' });
    await makeSeoBlog(author.id, { slug: 'by-grace' });

    // Warm both surfaces while the account is healthy.
    expect((await request(app).get('/api/v1/seo/blogs/by-grace')).body.data.robots.index).toBe(
      true
    );
    expect(
      allElementText((await request(app).get('/sitemap-blogs-1.xml')).text, 'loc')
    ).toHaveLength(1);

    await prisma.user.update({ where: { id: author.id }, data: { status: 'SUSPENDED' } });
    eventBus.emit(EVENTS.USER_SUSPENDED, { userId: author.id, actorId: 'moderator-1' });
    await eventBus.settled();

    // The post's page still exists — that is the Blog module's rule — but it
    // asks not to be indexed, and it is gone from the sitemap.
    const metadata = await request(app).get('/api/v1/seo/blogs/by-grace');
    expect(metadata.body.data.robots.index).toBe(false);

    expect((await request(app).get('/sitemap-blogs-1.xml')).status).toBe(404);
    expect((await request(app).get('/api/v1/seo/authors/grace')).status).toBe(404);
  });

  it('takes moderated content out immediately', async () => {
    const author = await makeUser();
    const blog = await makeSeoBlog(author.id, { slug: 'hidden-later' });

    await request(app).get('/sitemap-blogs-1.xml'); // warm

    await prisma.blog.update({
      where: { id: blog.id },
      data: { isHidden: true, hiddenAt: new Date() },
    });
    eventBus.emit(EVENTS.CONTENT_MODERATED, {
      targetType: 'BLOG',
      targetId: blog.id,
      ownerId: author.id,
      actorId: 'moderator-1',
    });
    await eventBus.settled();

    expect((await request(app).get('/api/v1/seo/blogs/hidden-later')).status).toBe(404);
    expect((await request(app).get('/sitemap-blogs-1.xml')).status).toBe(404);
  });

  it('refreshes a profile when it is edited', async () => {
    const author = await makeUser({ username: 'grace', name: 'Grace' });
    await makeSeoBlog(author.id);

    expect((await request(app).get('/api/v1/seo/authors/grace')).body.data.title).toBe(
      'Grace — Narrative'
    );

    await prisma.user.update({
      where: { id: author.id },
      data: { name: 'Grace Hopper' },
    });
    eventBus.emit(EVENTS.USER_PROFILE_UPDATED, { userId: author.id });
    await eventBus.settled();

    expect((await request(app).get('/api/v1/seo/authors/grace')).body.data.title).toBe(
      'Grace Hopper — Narrative'
    );
  });
});

describe('security', () => {
  it('never serves metadata for content a stranger may not see', async () => {
    const author = await makeUser();

    for (const [slug, overrides] of [
      ['a-draft', { status: 'DRAFT' as const }],
      ['a-private', { visibility: 'PRIVATE' as const }],
      ['members-only', { visibility: 'MEMBERS_ONLY' as const }],
      ['hidden', { isHidden: true }],
      ['deleted', { status: 'DELETED' as const }],
    ] as const) {
      await makeSeoBlog(author.id, { slug, title: `Secret ${slug}`, ...overrides });

      const res = await request(app).get(`/api/v1/seo/blogs/${slug}`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('Secret');
    }
  });

  it('never lists non-public content in a sitemap', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'public-one' });
    await makeSeoBlog(author.id, { slug: 'draft-one', status: 'DRAFT' });
    await makeSeoBlog(author.id, { slug: 'private-one', visibility: 'PRIVATE' });
    await makeSeoBlog(author.id, { slug: 'gated-one', visibility: 'MEMBERS_ONLY' });
    await makeSeoBlog(author.id, { slug: 'hidden-one', isHidden: true });

    const chunk = await request(app).get('/sitemap-blogs-1.xml');

    expect(allElementText(chunk.text, 'loc')).toEqual([`${APP_URL}/blog/public-one`]);
    for (const excluded of ['draft-one', 'private-one', 'gated-one', 'hidden-one']) {
      expect(chunk.text).not.toContain(excluded);
    }
  });

  it('never lists a private profile', async () => {
    const priv = await makeUser({ username: 'quiet' });
    const open = await makeUser({ username: 'loud' });
    await makeUserSettings(priv.id, { isPrivate: true });
    await makeSeoBlog(priv.id);
    await makeSeoBlog(open.id);

    const chunk = await request(app).get('/sitemap-authors-1.xml');

    expect(chunk.text).toContain('/@loud');
    expect(chunk.text).not.toContain('/@quiet');
  });

  // The full-stack version of the escaping tests: hostile content stored in the
  // database, read back through every layer, and asserted on the wire.
  it('neutralises hostile content all the way to the response', async () => {
    const author = await makeUser({
      username: 'attacker',
      name: '</script><img src=x onerror=alert(1)>',
    });
    const blog = await makeSeoBlog(author.id, {
      slug: 'hostile',
      title: '"><script>alert(1)</script>',
      metaDescription: '</title><script>alert(2)</script>',
      ogImage: 'javascript:alert(3)',
      canonicalUrl: 'javascript:alert(4)',
    });
    const tag = await makeTag('<b>tag</b>', 'hostile-tag');
    await tagBlog(blog.id, tag.id);

    const json = await request(app).get('/api/v1/seo/blogs/hostile');
    expect(json.status).toBe(200);
    expect(json.body.data.canonicalUrl).toBe(`${APP_URL}/blog/hostile`);
    expect(json.body.data.openGraph.image).toBeNull();
    expect(JSON.stringify(json.body)).not.toContain('<script');
    expect(JSON.stringify(json.body)).not.toContain('onerror');

    const html = await request(app).get('/api/v1/seo/blogs/hostile?format=html');
    expect(html.text).not.toContain('<script>alert');
    expect(html.text).not.toContain('onerror=');
    expect(html.text).not.toMatch(/<\/script><img/);
    // The JSON-LD block is still parseable — escaping did not corrupt it.
    const ld = html.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(() => JSON.parse(ld![1] as string)).not.toThrow();

    const sitemap = await request(app).get('/sitemap-tags-1.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain(`${APP_URL}/tags/hostile-tag`);
  });

  it('builds every URL from configuration, never from a request header', async () => {
    const author = await makeUser({ username: 'grace' });
    await makeSeoBlog(author.id, { slug: 'on-compilers' });

    const res = await request(app)
      .get('/api/v1/seo/blogs/on-compilers')
      .set('Host', 'evil.test')
      .set('X-Forwarded-Host', 'evil.test')
      .set('X-Forwarded-Proto', 'http');

    expect(JSON.stringify(res.body)).not.toContain('evil.test');
    expect(res.body.data.canonicalUrl).toBe(`${APP_URL}/blog/on-compilers`);

    const robots = await request(app).get('/robots.txt').set('Host', 'evil.test');
    expect(robots.text).not.toContain('evil.test');
    expect(robots.text).toContain(`Sitemap: ${APP_URL}/sitemap.xml`);
  });

  it('cannot be made to serve a poisoned cache entry through a spoofed host', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'on-compilers' });

    // The attacker's request populates the cache first.
    await request(app).get('/sitemap-blogs-1.xml').set('X-Forwarded-Host', 'evil.test');

    const victim = await request(app).get('/sitemap-blogs-1.xml');
    expect(victim.text).not.toContain('evil.test');
    expect(victim.text).toContain(`${APP_URL}/blog/on-compilers`);
  });

  it('never exposes an internal storage path or database column', async () => {
    const author = await makeUser({ username: 'grace' });
    await makeSeoBlog(author.id, { slug: 'on-compilers' });

    const bodies = [
      (await request(app).get('/api/v1/seo/blogs/on-compilers')).text,
      (await request(app).get('/api/v1/seo/authors/grace')).text,
      (await request(app).get('/sitemap.xml')).text,
      (await request(app).get('/sitemap-blogs-1.xml')).text,
      (await request(app).get('/robots.txt')).text,
    ].join('\n');

    for (const internal of ['passwordHash', 'isHidden', 'visibility', 'authorId', 'publicId']) {
      expect(bodies).not.toContain(internal);
    }
  });
});

describe('degradation', () => {
  it('serves metadata when the cache write fails', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'resilient', title: 'Resilient' });

    const redis = require('../../../core/providers/redis').redis;
    const spy = jest.spyOn(redis, 'set').mockRejectedValue(new Error('redis down'));

    try {
      const res = await request(app).get('/api/v1/seo/blogs/resilient');
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Resilient — Narrative');
    } finally {
      spy.mockRestore();
    }
  });

  it('serves a sitemap when the cache read fails', async () => {
    const author = await makeUser();
    await makeSeoBlog(author.id, { slug: 'resilient' });

    const redis = require('../../../core/providers/redis').redis;
    const spy = jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));

    try {
      const res = await request(app).get('/sitemap-blogs-1.xml');
      expect(res.status).toBe(200);
      expect(res.text).toContain(`${APP_URL}/blog/resilient`);
    } finally {
      spy.mockRestore();
    }
  });
});
