import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../core/database/prisma';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import {
  categorizeBlog,
  disconnectDb,
  makeCategory,
  makeTag,
  makeUser,
  resetDb,
  tagBlog,
} from '../../../test/db';
import { RSS_CONTENT_TYPE } from '../rss.config';
import {
  registerRssSubscribers,
  resetRssSubscriberRegistration,
} from '../subscribers';
import {
  attachCover,
  clearRssKeys,
  elementText,
  itemBlocks,
  makeRssBlog,
  touchUpdatedAt,
} from './helpers';

/**
 * The whole path, end to end: HTTP request, real database, real Redis, real
 * event bus, real XML out.
 *
 * The route tests mock the service and the database tests bypass HTTP; this is
 * the only suite where a mistake in the wiring BETWEEN them can show up — a
 * header set on the wrong branch, a subscriber that never reaches the cache, a
 * document that is correct in a unit test and wrong once it has been through
 * Redis.
 */

const day = (n: number) => new Date(`2026-03-${String(n).padStart(2, '0')}T00:00:00Z`);
const titles = (xml: string) => itemBlocks(xml).map((item) => elementText(item, 'title'));

describe('RSS end to end', () => {
  let grace: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    await clearRssKeys();
    eventBus.clearHandlers();
    resetRssSubscriberRegistration();
    registerRssSubscribers();

    grace = await makeUser({ username: 'gracehopper', name: 'Grace Hopper' });
  });

  afterAll(async () => {
    eventBus.clearHandlers();
    resetRssSubscriberRegistration();
    await clearRssKeys();
    await disconnectDb();
  });

  // -------------------------------------------------------------------------
  // A complete document
  // -------------------------------------------------------------------------

  describe('a complete feed', () => {
    beforeEach(async () => {
      const blog = await makeRssBlog(grace.id, {
        title: 'Structural Typing',
        slug: 'structural-typing',
        subtitle: 'What it buys and what it costs.',
        publishedAt: day(5),
        updatedAt: day(6),
      });
      const category = await makeCategory('Engineering', 'engineering');
      const tag = await makeTag('typescript', 'typescript');
      await categorizeBlog(blog.id, category.id);
      await tagBlog(blog.id, tag.id);
      await attachCover(blog.id, grace.id, {
        secureUrl: 'https://cdn.test/cover.jpg',
        mimeType: 'image/jpeg',
        fileSize: 9001,
      });
      // Last, because every write above rewrote `@updatedAt` — which is what
      // `lastBuildDate` and the HTTP validators are derived from.
      await touchUpdatedAt(blog.id, day(6));
    });

    it('serves a valid RSS 2.0 document with everything an item can carry', async () => {
      const res = await request(app).get('/api/v1/rss');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(RSS_CONTENT_TYPE);

      const xml = res.text;
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(xml).toContain('<rss version="2.0"');

      // Channel
      expect(elementText(xml, 'title')).toBe('Narrative');
      expect(elementText(xml, 'generator')).toBe('Narrative RSS');
      expect(elementText(xml, 'atom:id')).toBe('urn:narrative:feed:global');
      expect(elementText(xml, 'lastBuildDate')).toBe('Fri, 06 Mar 2026 00:00:00 GMT');
      expect(xml).toContain('rel="self"');

      // Item
      const item = itemBlocks(xml)[0] as string;
      expect(elementText(item, 'title')).toBe('Structural Typing');
      expect(elementText(item, 'link')).toContain('/blog/structural-typing');
      expect(elementText(item, 'description')).toBe('What it buys and what it costs.');
      expect(elementText(item, 'dc:creator')).toBe('Grace Hopper');
      expect(elementText(item, 'pubDate')).toBe('Thu, 05 Mar 2026 00:00:00 GMT');
      expect(item).toContain('<guid isPermaLink="false">urn:narrative:blog:');
      expect(item).toContain('<category>Engineering</category>');
      expect(item).toContain('<category>typescript</category>');
      expect(item).toContain('<enclosure url="https://cdn.test/cover.jpg"');
    });

    it('serves each feed type over HTTP', async () => {
      for (const path of [
        '/api/v1/rss',
        '/api/v1/rss/authors/gracehopper',
        '/api/v1/rss/categories/engineering',
        '/api/v1/rss/tags/typescript',
      ]) {
        const res = await request(app).get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        expect(titles(res.text)).toEqual(['Structural Typing']);
      }
    });

    it('advertises each feed’s own address as its self link', async () => {
      const res = await request(app).get('/api/v1/rss/tags/typescript');
      expect(res.text).toContain('href="http://localhost:3000/api/v1/rss/tags/typescript"');
    });

    it('404s an unknown subject in XML, with nothing cacheable about it', async () => {
      const res = await request(app).get('/api/v1/rss/authors/nobody');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('<code>FEED_NOT_FOUND</code>');
    });
  });

  // -------------------------------------------------------------------------
  // Conditional requests over the wire
  // -------------------------------------------------------------------------

  describe('conditional requests', () => {
    beforeEach(async () => {
      await makeRssBlog(grace.id, { title: 'First', publishedAt: day(1), updatedAt: day(1) });
    });

    it('answers a reader that already has the current feed with 304', async () => {
      const first = await request(app).get('/api/v1/rss');
      expect(first.status).toBe(200);

      const second = await request(app)
        .get('/api/v1/rss')
        .set('If-None-Match', first.headers.etag as string);

      expect(second.status).toBe(304);
      expect(second.text).toBeFalsy();
      expect(second.headers.etag).toBe(first.headers.etag);
    });

    it('answers a Last-Modified round trip with 304', async () => {
      const first = await request(app).get('/api/v1/rss');

      const second = await request(app)
        .get('/api/v1/rss')
        .set('If-Modified-Since', first.headers['last-modified'] as string);

      expect(second.status).toBe(304);
    });

    it('sends a fresh document once the feed genuinely changes', async () => {
      const first = await request(app).get('/api/v1/rss');
      const etag = first.headers.etag as string;

      const second = await makeRssBlog(grace.id, {
        title: 'Second',
        publishedAt: day(2),
        updatedAt: day(2),
      });
      eventBus.emit(EVENTS.BLOG_PUBLISHED, { blogId: second.id, authorId: grace.id });
      await eventBus.settled();

      const after = await request(app).get('/api/v1/rss').set('If-None-Match', etag);

      expect(after.status).toBe(200);
      expect(after.headers.etag).not.toBe(etag);
      expect(titles(after.text)).toEqual(['Second', 'First']);
    });

    it('keeps the same validator across a cache eviction', async () => {
      // The document is a pure function of the data, so a rebuild produces the
      // same bytes and the same ETag — which is what stops every subscriber
      // re-downloading every feed whenever an entry expires.
      const first = await request(app).get('/api/v1/rss');
      await clearRssKeys();
      const rebuilt = await request(app).get('/api/v1/rss');

      expect(rebuilt.headers.etag).toBe(first.headers.etag);
      expect(rebuilt.text).toBe(first.text);
    });
  });

  // -------------------------------------------------------------------------
  // Event-driven freshness
  // -------------------------------------------------------------------------

  describe('event-driven invalidation', () => {
    it('removes a post from a warm feed when a moderator hides it', async () => {
      const blog = await makeRssBlog(grace.id, { title: 'Bad Post', publishedAt: day(1) });

      const warm = await request(app).get('/api/v1/rss');
      expect(titles(warm.text)).toEqual(['Bad Post']);

      await prisma.blog.update({
        where: { id: blog.id },
        data: { isHidden: true, hiddenAt: new Date() },
      });
      eventBus.emit(EVENTS.CONTENT_MODERATED, {
        targetType: 'BLOG',
        targetId: blog.id,
        ownerId: grace.id,
        action: 'HIDDEN',
      });
      await eventBus.settled();

      // Without the invalidation the cached document would keep being served,
      // and re-served as a 304, for the rest of its TTL.
      const after = await request(app).get('/api/v1/rss');
      expect(itemBlocks(after.text)).toHaveLength(0);
    });

    it('removes a suspended author’s catalogue from every warm feed', async () => {
      const blog = await makeRssBlog(grace.id, { title: 'Gone', publishedAt: day(1) });
      const tag = await makeTag('typescript', 'typescript');
      await tagBlog(blog.id, tag.id);

      expect(titles((await request(app).get('/api/v1/rss')).text)).toEqual(['Gone']);
      expect(titles((await request(app).get('/api/v1/rss/tags/typescript')).text)).toEqual(['Gone']);

      await prisma.user.update({ where: { id: grace.id }, data: { status: 'SUSPENDED' } });
      eventBus.emit(EVENTS.USER_SUSPENDED, { userId: grace.id, actorId: 'mod-1' });
      await eventBus.settled();

      expect(itemBlocks((await request(app).get('/api/v1/rss')).text)).toHaveLength(0);
      // The tag feed too — this is what the root generation exists for: the set
      // of tags a catalogue touches is unbounded and cannot be enumerated on a
      // moderation path.
      expect(itemBlocks((await request(app).get('/api/v1/rss/tags/typescript')).text)).toHaveLength(
        0
      );
      // ...and the author's own feed is now indistinguishable from a stranger's.
      expect((await request(app).get('/api/v1/rss/authors/gracehopper')).status).toBe(404);
    });

    it('never lets an invalidation failure surface to a reader', async () => {
      await makeRssBlog(grace.id, { title: 'First', publishedAt: day(1) });

      eventBus.emit(EVENTS.BLOG_PUBLISHED, {});
      eventBus.emit(EVENTS.BLOG_UPDATED, { blogId: 'does-not-exist' });
      await eventBus.settled();

      const res = await request(app).get('/api/v1/rss');
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------

  describe('security', () => {
    it('leaks no ineligible content through any feed or any limit', async () => {
      const tag = await makeTag('everything', 'everything');
      const category = await makeCategory('Everything', 'everything');
      const hidden = await makeUser({ username: 'ghost', name: 'Ghost', status: 'SUSPENDED' });

      const secrets = [
        await makeRssBlog(grace.id, { title: 'SECRET-draft', status: 'DRAFT' }),
        await makeRssBlog(grace.id, { title: 'SECRET-private', visibility: 'PRIVATE' }),
        await makeRssBlog(grace.id, { title: 'SECRET-unlisted', visibility: 'UNLISTED' }),
        await makeRssBlog(grace.id, { title: 'SECRET-members', visibility: 'MEMBERS_ONLY' }),
        await makeRssBlog(grace.id, { title: 'SECRET-deleted', status: 'DELETED' }),
        await makeRssBlog(grace.id, { title: 'SECRET-archived', status: 'ARCHIVED' }),
        await makeRssBlog(grace.id, { title: 'SECRET-hidden', isHidden: true }),
        await makeRssBlog(hidden.id, { title: 'SECRET-suspended-author' }),
      ];
      for (const blog of secrets) {
        await tagBlog(blog.id, tag.id);
        await categorizeBlog(blog.id, category.id);
      }
      // One eligible post, so the feeds are not trivially empty.
      await makeRssBlog(grace.id, { title: 'Visible', publishedAt: day(1) });

      for (const path of [
        '/api/v1/rss',
        '/api/v1/rss?limit=50',
        '/api/v1/rss/authors/gracehopper',
        '/api/v1/rss/authors/ghost',
        '/api/v1/rss/categories/everything',
        '/api/v1/rss/tags/everything',
      ]) {
        const res = await request(app).get(path);
        expect({ path, leaked: res.text.includes('SECRET') }).toEqual({ path, leaked: false });
      }
    });

    it('exposes no internal identifiers, storage paths or account data', async () => {
      const blog = await makeRssBlog(grace.id, { title: 'A Post', publishedAt: day(1) });
      await attachCover(blog.id, grace.id);

      const xml = (await request(app).get('/api/v1/rss')).text;

      // The storage `publicId` is an internal path and is never selected by the
      // query that builds a feed.
      expect(xml).not.toContain('secret-internal-path');
      expect(xml).not.toContain(grace.email);
      expect(xml).not.toContain('passwordHash');
      expect(xml).not.toContain('PUBLISHED');
      expect(xml).not.toContain(grace.id);
    });

    it('cannot be made to serve gated content by holding a token', async () => {
      // There is no viewer anywhere in this module, so a token cannot widen a
      // feed. That is the property that makes `Cache-Control: public` safe.
      await makeRssBlog(grace.id, { title: 'Members', visibility: 'MEMBERS_ONLY' });
      await makeRssBlog(grace.id, { title: 'Visible', publishedAt: day(1) });

      const anonymous = await request(app).get('/api/v1/rss');
      const authenticated = await request(app)
        .get('/api/v1/rss')
        .set('Authorization', 'Bearer whatever');

      expect(authenticated.text).toBe(anonymous.text);
      expect(anonymous.text).not.toContain('Members');
    });

    it('produces a well-formed document from thoroughly hostile content', async () => {
      await prisma.user.update({
        where: { id: grace.id },
        data: { name: '<script>alert("xss")</script>' },
      });
      const blog = await makeRssBlog(grace.id, {
        title: ']]></title><item><title>forged</title></item><!--',
        subtitle: '<img src=x onerror="alert(1)">',
        slug: 'hostile',
        publishedAt: day(1),
        canonicalUrl: 'javascript:alert(1)',
      });
      const tag = await makeTag('</category><category>forged', 'forged');
      await tagBlog(blog.id, tag.id);

      const xml = (await request(app).get('/api/v1/rss')).text;

      expect(xml).not.toContain('<script>');
      expect(xml).not.toContain('<img');
      expect(xml).not.toContain('javascript:');
      expect(xml).not.toContain('<title>forged</title>');
      // Exactly one item and one channel: nothing escaped its element.
      expect(itemBlocks(xml)).toHaveLength(1);
      expect(xml.match(/<channel>/g)).toHaveLength(1);
    });
  });
});
