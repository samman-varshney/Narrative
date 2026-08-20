import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../core/database/prisma';
import { redis } from '../../../core/providers/redis';
import { resetGenerationMemo as resetAnalyticsMemo } from '../../analytics/analytics.cache';
import { tokensService } from '../../auth/tokens.service';
import {
  disconnectDb,
  makeBlog,
  makeBookmark,
  makeFollow,
  makeUser,
  resetDb,
} from '../../../test/db';
import { bumpGeneration, resetGenerationMemo } from '../dashboard.cache';
import { clearDashboardKeys } from './helpers';

/**
 * The whole stack, end to end: real HTTP, real services, real Postgres, real
 * Redis. Nothing is mocked.
 *
 * The other suites each hold one variable still. This one holds none, which is
 * the only way to catch the failures that live BETWEEN layers — an analytics
 * range that the service builds and the repository then rejects, a cached
 * payload whose dates come back as strings, a section that works in isolation
 * and deadlocks beside the other seven.
 *
 * The scenario is one author with a real audience and one bystander, because
 * the single most important property of a dashboard is not what it shows its
 * owner but what it refuses to show anyone else.
 */

const today = new Date().toISOString().slice(0, 10);
const dayLabel = (daysAgo: number): Date =>
  new Date(new Date(`${today}T00:00:00.000Z`).getTime() - daysAgo * 86_400_000);

let alice: { id: string };
let bob: { id: string };
let carol: { id: string };
let alicePublished: { id: string };
let aliceDraft: { id: string };
let bobBlog: { id: string };
let aliceToken: string;
let bobToken: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await resetDb();
  await clearDashboardKeys();

  alice = await makeUser({ username: 'alice-e2e', name: 'Alice' });
  bob = await makeUser({ username: 'bob-e2e', name: 'Bob' });
  carol = await makeUser({ username: 'carol-e2e', name: 'Carol' });

  aliceToken = tokensService.generateAccessToken({ userId: alice.id, role: 'USER' });
  bobToken = tokensService.generateAccessToken({ userId: bob.id, role: 'USER' });

  // --- Alice's content -----------------------------------------------------
  alicePublished = await makeBlog(alice.id, {
    title: 'Alice Published',
    slug: 'alice-published',
    publishedAt: dayLabel(2),
  });
  await makeBlog(alice.id, {
    title: 'Alice Older',
    slug: 'alice-older',
    publishedAt: dayLabel(10),
  });
  aliceDraft = await makeBlog(alice.id, {
    title: 'Alice Draft',
    slug: 'alice-draft',
    status: 'DRAFT',
  });
  await makeBlog(alice.id, {
    title: 'Alice Archived',
    slug: 'alice-archived',
    status: 'ARCHIVED',
  });

  // --- Bob's content, which Alice saved ------------------------------------
  bobBlog = await makeBlog(bob.id, { title: 'Bob Published', slug: 'bob-published' });
  await makeBookmark(alice.id, bobBlog.id);

  // --- Alice's audience ----------------------------------------------------
  await makeFollow(bob.id, alice.id);
  await makeFollow(carol.id, alice.id);
  await makeFollow(alice.id, bob.id);

  // --- Engagement on Alice's post ------------------------------------------
  await prisma.comment.create({
    data: {
      blogId: alicePublished.id,
      authorId: bob.id,
      content: 'Great post, Alice',
      path: '',
    },
  });
  await prisma.comment.create({
    data: {
      blogId: alicePublished.id,
      authorId: alice.id,
      content: 'Thanks!',
      path: '',
    },
  });

  await prisma.notification.create({
    data: {
      recipientId: alice.id,
      actorId: bob.id,
      type: 'FOLLOW',
      entityType: 'USER',
      entityId: bob.id,
      dedupeKey: 'e2e-follow-bob-alice',
    },
  });

  // --- Analytics aggregates, as the flush worker would have written them ---
  await prisma.blogAnalyticsDaily.createMany({
    data: [
      {
        blogId: alicePublished.id,
        authorId: alice.id,
        date: dayLabel(1),
        views: 120,
        uniqueViews: 80,
        readStarts: 60,
        readCompletions: 30,
        totalReadingSeconds: 5_400,
        bookmarks: 6,
        unbookmarks: 1,
        comments: 2,
      },
      {
        blogId: alicePublished.id,
        authorId: alice.id,
        date: dayLabel(3),
        views: 40,
        uniqueViews: 35,
        readStarts: 20,
        readCompletions: 12,
        totalReadingSeconds: 2_000,
        bookmarks: 2,
        unbookmarks: 0,
        comments: 1,
      },
    ],
  });

  await prisma.userAnalyticsDaily.create({
    data: {
      userId: alice.id,
      date: dayLabel(1),
      followersGained: 2,
      followersLost: 0,
      blogsPublished: 1,
    },
  });
});

beforeEach(async () => {
  await clearDashboardKeys();
  resetGenerationMemo();
  resetAnalyticsMemo();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await clearDashboardKeys();
  await resetDb();
  await disconnectDb();
});

const overview = (token: string, query = '') =>
  request(app).get(`/api/v1/dashboard/overview${query}`).set(auth(token));

describe('the author\'s dashboard', () => {
  it('assembles every section in one request', async () => {
    const res = await overview(aliceToken);

    expect(res.status).toBe(200);
    expect(res.body.meta.degradedSections).toEqual([]);

    const data = res.body.data.overview;
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining([
        'stats',
        'recentBlogs',
        'drafts',
        'topContent',
        'audience',
        'bookmarks',
        'notifications',
        'activity',
      ])
    );
  });

  it('counts content by status', async () => {
    const { body } = await overview(aliceToken);

    expect(body.data.overview.stats.content).toEqual({
      total: 4,
      published: 2,
      drafts: 1,
      archived: 1,
    });
  });

  it('reports the live audience totals', async () => {
    const { body } = await overview(aliceToken);

    // Two followers, one followed — live from the graph, not summed from deltas.
    expect(body.data.overview.stats.audience).toEqual({ followers: 2, following: 1 });
    expect(body.data.overview.audience.growth).toEqual({ gained: 2, lost: 0, net: 2 });
  });

  it('aggregates engagement from the analytics rows', async () => {
    const { body } = await overview(aliceToken);
    const engagement = body.data.overview.stats.engagement;

    expect(engagement.views).toBe(160);
    expect(engagement.netBookmarks).toBe(7); // 8 added, 1 removed
    expect(engagement.comments).toBe(3);
    expect(engagement.reading.completions).toBe(42);
    // 7400 seconds over 42 completions.
    expect(engagement.reading.averageSeconds).toBe(176);
    // A 30-day window cannot report exact uniques — one reader on two days
    // would be counted twice.
    expect(engagement.uniqueViews).toBeNull();
    expect(engagement.uniqueReaderDays).toBe(115);
  });

  it('lists recent content newest-published first, without the body', async () => {
    const { body } = await overview(aliceToken);
    const recent = body.data.overview.recentBlogs;

    expect(recent.map((blog: { title: string }) => blog.title)).toEqual([
      'Alice Published',
      'Alice Older',
    ]);
    expect(recent[0]).not.toHaveProperty('content');
    expect(recent[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('lists drafts', async () => {
    const { body } = await overview(aliceToken);

    expect(body.data.overview.drafts).toHaveLength(1);
    expect(body.data.overview.drafts[0]).toMatchObject({
      id: aliceDraft.id,
      title: 'Alice Draft',
      status: 'DRAFT',
    });
  });

  it('ranks top content and hydrates it with blog metadata', async () => {
    const { body } = await overview(aliceToken);
    const top = body.data.overview.topContent;

    expect(top).toHaveLength(1);
    expect(top[0].blog.id).toBe(alicePublished.id);
    expect(top[0].views).toBe(160);
    // Hydration is what this module adds on top of the ranking.
    expect(top[0].blog).toHaveProperty('status', 'PUBLISHED');
    expect(top[0].blog).toHaveProperty('readingTimeMinutes');
  });

  it('shows saved content and its total', async () => {
    const { body } = await overview(aliceToken);

    expect(body.data.overview.bookmarks.total).toBe(1);
    expect(body.data.overview.bookmarks.items[0].blog).toMatchObject({
      id: bobBlog.id,
      title: 'Bob Published',
    });
    expect(body.data.overview.stats.library.bookmarks).toBe(1);
  });

  it('shows unread notifications', async () => {
    const { body } = await overview(aliceToken);

    expect(body.data.overview.notifications.unread).toBe(1);
    expect(body.data.overview.notifications.items[0].type).toBe('FOLLOW');
    expect(body.data.overview.stats.notifications.unread).toBe(1);
  });

  it('merges activity from comments, followers and publishing', async () => {
    const { body } = await overview(aliceToken);
    const types = body.data.overview.activity.map((row: { type: string }) => row.type);

    expect(types).toContain('COMMENT_RECEIVED');
    expect(types).toContain('FOLLOWER_GAINED');
    expect(types).toContain('BLOG_PUBLISHED');
  });

  it('excludes the author\'s own reply from the activity feed', async () => {
    const { body } = await overview(aliceToken);
    const excerpts = body.data.overview.activity
      .filter((row: { type: string }) => row.type === 'COMMENT_RECEIVED')
      .map((row: { excerpt: string }) => row.excerpt);

    expect(excerpts).toContain('Great post, Alice');
    expect(excerpts).not.toContain('Thanks!');
  });

  it('is ordered newest first', async () => {
    const { body } = await overview(aliceToken);
    const timestamps = body.data.overview.activity.map(
      (row: { occurredAt: string }) => row.occurredAt
    );

    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });
});

describe('user isolation', () => {
  it('shows Bob his own dashboard, not Alice\'s', async () => {
    const { body } = await overview(bobToken);

    expect(body.data.overview.stats.content.published).toBe(1);
    expect(body.data.overview.stats.audience.followers).toBe(1); // only Alice
    // Alice's engagement is nowhere in it.
    expect(body.data.overview.stats.engagement.views).toBe(0);
    expect(body.data.overview.recentBlogs.map((b: { title: string }) => b.title)).toEqual(
      ['Bob Published']
    );
  });

  it('leaks no draft of Alice\'s into Bob\'s dashboard', async () => {
    const { body } = await overview(bobToken);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Alice Draft');
    expect(serialized).not.toContain('Alice Archived');
  });

  it('cannot be redirected at another user by a query parameter', async () => {
    const { body } = await overview(bobToken, `?userId=${alice.id}`);

    // No parameter exists to ask for someone else's dashboard, so an injected
    // one is simply ignored rather than honoured.
    expect(body.data.overview.stats.content.published).toBe(1);
    expect(JSON.stringify(body)).not.toContain('Alice Draft');
  });

  it('does not serve one user a cached entry built for another', async () => {
    await overview(aliceToken);
    const { body } = await overview(bobToken);

    expect(body.data.overview.stats.content.total).toBe(1);
    expect(body.data.overview.stats.engagement.views).toBe(0);
  });
});

describe('caching', () => {
  it('serves a repeat request from Redis, and an invalidation clears it', async () => {
    // Its own author, so the write below cannot leak into another test's
    // expectations if this one fails part-way through.
    const writer = await makeUser({ username: 'cache-writer-e2e' });
    const token = tokensService.generateAccessToken({
      userId: writer.id,
      role: 'USER',
    });

    const first = await overview(token);
    expect(first.body.data.overview.stats.content.drafts).toBe(0);

    // Written directly, so no domain event is emitted and nothing invalidates.
    await makeBlog(writer.id, {
      title: 'Written behind the cache',
      slug: 'behind-cache',
      status: 'DRAFT',
    });

    const second = await overview(token);
    expect(second.body.data.overview.stats.content.drafts).toBe(0);
    expect(second.body.data.overview.drafts).toEqual([]);

    // …and an invalidation makes it visible, which is what proves the previous
    // assertion was a cache hit rather than a coincidence.
    await bumpGeneration([writer.id]);

    const third = await overview(token);
    expect(third.body.data.overview.stats.content.drafts).toBe(1);
    // The counter and the panel listing the same rows move TOGETHER. They are
    // both read live for exactly this reason — sourcing the counter from the
    // analytics overview instead would leave it a cache generation behind the
    // panel beside it.
    expect(third.body.data.overview.drafts).toHaveLength(1);
  });

  it('keeps range presets in separate entries', async () => {
    const week = await overview(aliceToken, '?range=7d');
    const all = await overview(aliceToken, '?range=all');

    expect(week.body.meta.range.startDate).not.toBe(all.body.meta.range.startDate);
    expect(week.body.meta.range.granularity).toBe('day');
  });

  it('serves the dashboard when Redis is unreachable', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
    jest.spyOn(redis, 'set').mockRejectedValue(new Error('redis down'));

    const res = await overview(aliceToken);

    // Degraded to "uncached", never to an error page.
    expect(res.status).toBe(200);
    expect(res.body.meta.degradedSections).toEqual([]);
    expect(res.body.data.overview.stats.content.published).toBe(2);
  });
});

describe('section endpoints', () => {
  it('returns only the requested sections from the composite endpoint', async () => {
    const { body } = await overview(aliceToken, '?sections=stats,drafts');

    expect(body.data.overview).toHaveProperty('stats');
    expect(body.data.overview).toHaveProperty('drafts');
    expect(body.data.overview).not.toHaveProperty('activity');
  });

  it('serves stats on their own', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set(auth(aliceToken));

    expect(res.status).toBe(200);
    expect(res.body.data.stats.content.published).toBe(2);
    expect(res.body.meta.range.preset).toBe('30d');
  });

  it('serves gap-filled chart series', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/charts?range=7d&series=views,followers')
      .set(auth(aliceToken));

    expect(res.status).toBe(200);
    // Every day in the window is present, including the ones with no rows.
    expect(res.body.data.charts.views.points).toHaveLength(7);
    expect(res.body.data.charts.engagement).toBeUndefined();

    const withViews = res.body.data.charts.views.points.filter(
      (point: { views: number }) => point.views > 0
    );
    expect(withViews).toHaveLength(2);
    expect(res.body.data.charts.followers.current).toBe(2);
  });

  it('serves a weekly series for the all-time range without exceeding the cap', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/charts?range=all&series=views')
      .set(auth(aliceToken));

    expect(res.status).toBe(200);
    expect(res.body.meta.range.granularity).toBe('week');
    expect(res.body.data.charts.views.points.length).toBeLessThanOrEqual(370);
  });

  it('serves paginated drafts', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/drafts?limit=10')
      .set(auth(aliceToken));

    expect(res.status).toBe(200);
    expect(res.body.data.items[0].title).toBe('Alice Draft');
    expect(res.body.meta.totalCount).toBe(1);
  });

  it('serves top content ranked by a chosen metric', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/top-content?metric=comments&limit=5')
      .set(auth(aliceToken));

    expect(res.status).toBe(200);
    expect(res.body.meta.metric).toBe('comments');
    expect(res.body.data.items[0].blog.id).toBe(alicePublished.id);
  });

  it('serves activity on its own', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/activity?limit=5')
      .set(auth(aliceToken));

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });
});

describe('a brand-new author', () => {
  it('gets an empty dashboard, not a broken one', async () => {
    const newcomer = await makeUser({ username: 'newcomer-e2e' });
    const token = tokensService.generateAccessToken({
      userId: newcomer.id,
      role: 'USER',
    });

    const res = await overview(token);

    expect(res.status).toBe(200);
    expect(res.body.meta.degradedSections).toEqual([]);

    const data = res.body.data.overview;
    expect(data.stats.content).toEqual({
      total: 0,
      published: 0,
      drafts: 0,
      archived: 0,
    });
    expect(data.stats.engagement.views).toBe(0);
    // Null, not zero: nobody has started reading, so there is no rate to report.
    expect(data.stats.engagement.reading.completionRate).toBeNull();
    expect(data.recentBlogs).toEqual([]);
    expect(data.drafts).toEqual([]);
    expect(data.topContent).toEqual([]);
    expect(data.activity).toEqual([]);
    expect(data.bookmarks).toEqual({ total: 0, items: [] });
  });

  it('gets a flat chart rather than an absent one', async () => {
    const newcomer = await makeUser({ username: 'newcomer-charts-e2e' });
    const token = tokensService.generateAccessToken({
      userId: newcomer.id,
      role: 'USER',
    });

    const res = await request(app)
      .get('/api/v1/dashboard/charts?range=7d&series=views')
      .set(auth(token));

    expect(res.body.data.charts.views.points).toHaveLength(7);
    expect(
      res.body.data.charts.views.points.every((point: { views: number }) => point.views === 0)
    ).toBe(true);
  });
});
