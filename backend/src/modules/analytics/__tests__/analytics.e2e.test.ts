import request from 'supertest';
import app from '../../../app';
import { redis } from '../../../core/providers/redis';
import { eventBus } from '../../../core/events/eventBus';
import { tokensService } from '../../auth/tokens.service';
import { resetDb, disconnectDb, makeUser, makeBlog } from '../../../test/db';
import {
  registerAnalyticsSubscribers,
  resetAnalyticsSubscriberRegistration,
} from '../subscribers';
import { AnalyticsBuffer } from '../analytics.buffer';
import { PostgresAnalyticsStore } from '../store/PostgresAnalyticsStore';
import { runFlush } from '../analytics.worker';
import { resetGenerationMemo } from '../analytics.cache';
import { clearAnalyticsKeys } from './helpers';

/**
 * The complete loop, with nothing mocked:
 *
 *   GET /blogs/:slug  →  BLOG_VIEWED  →  subscriber  →  Redis buffer
 *                     →  flush  →  PostgreSQL  →  GET /analytics/...
 *
 * Every other suite in this module tests one link. This one tests that the links
 * are actually joined — which is the failure the others cannot see: a subscriber
 * that is never registered, a route that is never mounted, an event whose
 * payload does not carry what the handler reads. All three produce a dashboard
 * of zeroes with no error anywhere.
 *
 * Under NODE_ENV=test the event bus dispatches inline rather than through
 * BullMQ (see eventBus.ts), so a view is buffered by the time the response
 * returns. Production takes the queue path; the subscriber and its payload
 * contract are identical either way.
 */

const buffer = new AnalyticsBuffer(redis);
const store = new PostgresAnalyticsStore();

/**
 * Waits for the analytics subscribers to finish, then flushes.
 *
 * `eventBus.emit` is fire-and-forget by contract, so under NODE_ENV=test the
 * inline dispatch it starts is still running when the HTTP response returns.
 * Flushing without waiting would race the subscriber and intermittently drop the
 * most recent event — which reads as a lost view rather than as a test that
 * measured too early. `settled()` makes the wait deterministic; a sleep would
 * only make it slow.
 *
 * Production has no equivalent race: `emit` enqueues a durable BullMQ job, and
 * the flush is a separate scheduled job that runs long afterwards.
 */
async function flush() {
  await eventBus.settled();
  return runFlush(buffer, store);
}

let author: Awaited<ReturnType<typeof makeUser>>;
let reader: Awaited<ReturnType<typeof makeUser>>;
let blog: Awaited<ReturnType<typeof makeBlog>>;
let authorToken: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('analytics end-to-end (no mocks)', () => {
  beforeAll(() => {
    // app.ts deliberately does NOT register subscribers — that is server.ts's
    // job — so the wiring under test has to be established here.
    registerAnalyticsSubscribers();
  });

  afterAll(async () => {
    eventBus.clearHandlers();
    resetAnalyticsSubscriberRegistration();
    await clearAnalyticsKeys();
    await disconnectDb();
  });

  beforeEach(async () => {
    await resetDb();
    await clearAnalyticsKeys();
    resetGenerationMemo();

    author = await makeUser();
    reader = await makeUser();
    blog = await makeBlog(author.id, { readingTimeMinutes: 5 });

    authorToken = tokensService.generateAccessToken({ userId: author.id, role: 'USER' });
  });

  describe('a public blog read becomes a view on the author’s dashboard', () => {
    it('counts an anonymous read', async () => {
      const res = await request(app)
        .get(`/api/v1/blogs/${blog.slug}`)
        .set('x-anonymous-id', 'anon-reader-aaaaaaaa');

      expect(res.status).toBe(200);

      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      expect(overview.status).toBe(200);
      expect(overview.body.data.overview.views).toBe(1);
      expect(overview.body.data.overview.uniqueViews).toBe(1);
    });

    it('counts a signed-in read', async () => {
      const readerToken = tokensService.generateAccessToken({
        userId: reader.id,
        role: 'USER',
      });

      await request(app).get(`/api/v1/blogs/${blog.slug}`).set(auth(readerToken));
      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      expect(overview.body.data.overview.views).toBe(1);
    });

    it('does not count the author reading their own post', async () => {
      await request(app).get(`/api/v1/blogs/${blog.slug}`).set(auth(authorToken));
      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      // A brand-new post must not show "1 view" because its author opened it.
      expect(overview.body.data.overview.views).toBe(0);
    });

    it('counts one view however many times the same reader refreshes', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app)
          .get(`/api/v1/blogs/${blog.slug}`)
          .set('x-anonymous-id', 'anon-refresher-aaa');
      }
      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      expect(overview.body.data.overview.views).toBe(1);
    });

    it('counts distinct readers separately', async () => {
      for (const id of ['anon-aaaaaaaaaaaaaaa', 'anon-bbbbbbbbbbbbbbb', 'anon-ccccccccccccccc']) {
        await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', id);
      }
      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      expect(overview.body.data.overview.views).toBe(3);
      expect(overview.body.data.overview.uniqueViews).toBe(3);
    });

    it('does not count a read of an unpublished blog', async () => {
      const draft = await makeBlog(author.id, { status: 'DRAFT' });

      // The owner can open their own draft by slug; it is authoring, not
      // readership, so nothing should be recorded.
      await request(app).get(`/api/v1/blogs/${draft.slug}`).set(auth(authorToken));
      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${draft.id}/overview`)
        .set(auth(authorToken));

      expect(overview.body.data.overview.views).toBe(0);
    });

    it('ignores a malformed anonymous id rather than failing the page', async () => {
      const res = await request(app)
        .get(`/api/v1/blogs/${blog.slug}`)
        .set('x-anonymous-id', 'short');

      // A bad client build must never take the blog page down.
      expect(res.status).toBe(200);

      await flush();
      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      // Counted (the read happened), but not attributable to a unique reader.
      expect(overview.body.data.overview.views).toBe(1);
      expect(overview.body.data.overview.uniqueViews).toBe(0);
    });
  });

  describe('reading telemetry', () => {
    it('records a start and completion and reports the rates', async () => {
      const anonymousId = 'anon-readerrrrrrrrr';
      const sessionId = 'session-eeeeeeeeeeee';

      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', anonymousId);

      const started = await request(app)
        .post(`/api/v1/analytics/blogs/${blog.id}/read`)
        .send({ event: 'BLOG_READ_STARTED', sessionId, anonymousId });
      expect(started.status).toBe(202);

      // A moment of real elapsed time, so the server-measured duration clears
      // the minimum.
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const completed = await request(app)
        .post(`/api/v1/analytics/blogs/${blog.id}/read`)
        .send({ event: 'BLOG_READ_COMPLETED', sessionId, anonymousId, durationSeconds: 200 });
      expect(completed.status).toBe(202);

      await flush();

      const reading = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/reading`)
        .set(auth(authorToken));

      expect(reading.body.data.reading).toMatchObject({
        readStarts: 1,
        readCompletions: 1,
        completionRate: 1,
        readThroughRate: 1,
      });
      // Clamped to the ~1s actually observed, not the 200 claimed.
      expect(reading.body.data.reading.averageReadingSeconds).toBeLessThan(10);
    });

    it('does not count a completion that was never started', async () => {
      await request(app)
        .post(`/api/v1/analytics/blogs/${blog.id}/read`)
        .send({
          event: 'BLOG_READ_COMPLETED',
          sessionId: 'session-ffffffffffff',
          anonymousId: 'anon-forgerrrrrrrrr',
          durationSeconds: 600,
        });

      await flush();

      const reading = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/reading`)
        .set(auth(authorToken));

      // The endpoint accepted the request (202) but nothing was recorded — the
      // client is not told which of its events counted.
      expect(reading.body.data.reading.readCompletions).toBe(0);
    });
  });

  describe('engagement flows through the existing domain events', () => {
    it('counts a bookmark on the blog’s dashboard', async () => {
      const readerToken = tokensService.generateAccessToken({
        userId: reader.id,
        role: 'USER',
      });

      const res = await request(app)
        .post(`/api/v1/blogs/${blog.id}/bookmark`)
        .set(auth(readerToken));
      expect(res.status).toBeLessThan(400);

      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      // BLOG_BOOKMARKED carries no authorId; this only works because ingestion
      // resolves the blog's owner itself.
      expect(overview.body.data.overview.bookmarks).toBe(1);
      expect(overview.body.data.overview.netBookmarks).toBe(1);
    });

    it('reports a bookmark then unbookmark as gross 1 and net 0', async () => {
      const readerToken = tokensService.generateAccessToken({
        userId: reader.id,
        role: 'USER',
      });

      await request(app).post(`/api/v1/blogs/${blog.id}/bookmark`).set(auth(readerToken));
      await request(app).delete(`/api/v1/blogs/${blog.id}/bookmark`).set(auth(readerToken));

      await flush();

      const overview = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      expect(overview.body.data.overview.bookmarks).toBe(1);
      expect(overview.body.data.overview.netBookmarks).toBe(0);
    });

    it('counts a new follower on the author’s growth chart', async () => {
      const readerToken = tokensService.generateAccessToken({
        userId: reader.id,
        role: 'USER',
      });

      await request(app).post(`/api/v1/users/${author.id}/follow`).set(auth(readerToken));
      await flush();

      const followers = await request(app)
        .get('/api/v1/analytics/me/followers')
        .set(auth(authorToken));

      expect(followers.status).toBe(200);
      expect(followers.body.data.points[0]).toMatchObject({ gained: 1, lost: 0, net: 1 });
      // The live count, read from Follow rather than summed from deltas.
      expect(followers.body.data.currentFollowers).toBe(1);
    });
  });

  describe('the author dashboard', () => {
    it('aggregates across all of the author’s blogs', async () => {
      const second = await makeBlog(author.id);

      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', 'anon-1aaaaaaaaaaa');
      await request(app).get(`/api/v1/blogs/${second.slug}`).set('x-anonymous-id', 'anon-2aaaaaaaaaaa');
      await flush();

      const overview = await request(app)
        .get('/api/v1/analytics/me/overview')
        .set(auth(authorToken));

      expect(overview.body.data.overview.views).toBe(2);
      expect(overview.body.data.overview.publishedBlogs).toBe(2);
    });

    it('ranks top blogs by views', async () => {
      const second = await makeBlog(author.id, { title: 'The Popular One' });

      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', 'anon-1aaaaaaaaaaa');
      for (const id of ['anon-2aaaaaaaaaaa', 'anon-3aaaaaaaaaaa', 'anon-4aaaaaaaaaaa']) {
        await request(app).get(`/api/v1/blogs/${second.slug}`).set('x-anonymous-id', id);
      }
      await flush();

      const top = await request(app)
        .get('/api/v1/analytics/me/top-blogs')
        .set(auth(authorToken));

      expect(top.body.data.items[0]).toMatchObject({ title: 'The Popular One', views: 3 });
      expect(top.body.data.items[1]).toMatchObject({ views: 1 });
    });

    it('returns a views time series', async () => {
      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', 'anon-1aaaaaaaaaaa');
      await flush();

      const views = await request(app).get('/api/v1/analytics/me/views').set(auth(authorToken));

      expect(views.status).toBe(200);
      expect(views.body.data.points).toHaveLength(1);
      expect(views.body.data.points[0]).toMatchObject({ views: 1, uniqueViews: 1 });
      // A plain calendar day, never a full ISO timestamp.
      expect(views.body.data.points[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // The SECOND identical request is served from the report cache. It has to
      // return the same payload, not fail on a JSON-revived date.
      const cached = await request(app).get('/api/v1/analytics/me/views').set(auth(authorToken));

      expect(cached.status).toBe(200);
      expect(cached.body.data.points).toEqual(views.body.data.points);
    });

    it('serves a repeated top-blogs request identically from cache', async () => {
      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', 'anon-1aaaaaaaaaaa');
      await flush();

      const first = await request(app)
        .get('/api/v1/analytics/me/top-blogs')
        .set(auth(authorToken));
      const second = await request(app)
        .get('/api/v1/analytics/me/top-blogs')
        .set(auth(authorToken));

      expect(second.status).toBe(200);
      expect(second.body.data.items).toEqual(first.body.data.items);
    });
  });

  describe('authorization across the real stack', () => {
    it('refuses another author’s blog analytics with 404', async () => {
      const stranger = await makeUser();
      const strangerToken = tokensService.generateAccessToken({
        userId: stranger.id,
        role: 'USER',
      });

      const res = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(strangerToken));

      expect(res.status).toBe(404);
    });

    it('lets an ADMIN read any blog’s analytics', async () => {
      const admin = await makeUser({ role: 'ADMIN' });
      const adminToken = tokensService.generateAccessToken({
        userId: admin.id,
        role: 'ADMIN',
      });

      const res = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(adminToken));

      expect(res.status).toBe(200);
    });

    it('never shows one author another’s numbers on /me', async () => {
      const stranger = await makeUser();
      const strangerToken = tokensService.generateAccessToken({
        userId: stranger.id,
        role: 'USER',
      });

      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', 'anon-1aaaaaaaaaaa');
      await flush();

      const res = await request(app).get('/api/v1/analytics/me/overview').set(auth(strangerToken));

      expect(res.body.data.overview.views).toBe(0);
    });
  });

  describe('eventual consistency', () => {
    it('reports nothing until the flush has run', async () => {
      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', 'anon-1aaaaaaaaaaa');

      const before = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      // The documented contract: a view is durable in Redis immediately and
      // visible on the dashboard within one flush interval. Never blocking the
      // reader's request is what buys that.
      expect(before.body.data.overview.views).toBe(0);

      await flush();

      const after = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      expect(after.body.data.overview.views).toBe(1);
    });

    it('serves fresh numbers after a flush despite the report cache', async () => {
      // The read above populated the cache with zeroes. The flush bumps the
      // author's generation, so this must not be served from that entry.
      await request(app).get(`/api/v1/blogs/${blog.slug}`).set('x-anonymous-id', 'anon-1aaaaaaaaaaa');
      await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      await flush();
      resetGenerationMemo(); // the memo would otherwise hold the old generation for 5s

      const after = await request(app)
        .get(`/api/v1/analytics/blogs/${blog.id}/overview`)
        .set(auth(authorToken));

      expect(after.body.data.overview.views).toBe(1);
    });
  });

  describe('analytics never breaks the user’s action', () => {
    it('serves the blog page even when the analytics buffer is unavailable', async () => {
      const broken = jest
        .spyOn(redis, 'pipeline')
        .mockImplementation(() => {
          throw new Error('redis is down');
        });

      try {
        const res = await request(app)
          .get(`/api/v1/blogs/${blog.slug}`)
          .set('x-anonymous-id', 'anon-1aaaaaaaaaaa');

        // The whole point of the module's placement: a reader opening a post
        // must not be able to tell that analytics is broken.
        expect(res.status).toBe(200);
        expect(res.body.data.blog.slug).toBe(blog.slug);
      } finally {
        broken.mockRestore();
      }
    });
  });
});
