import request from 'supertest';
import app from '../../../app';
import { AppError } from '../../../core/exceptions/AppError';
import { tokensService } from '../../auth/tokens.service';
import { analyticsService } from '../analytics.service';

/**
 * The HTTP surface: routing, auth wiring, query validation, response envelope.
 *
 * The service is mocked. Behaviour against real Redis and PostgreSQL lives in
 * analytics.flush.test.ts and analytics.db.test.ts; what these prove is the
 * contract a dashboard actually consumes — that an unauthenticated request never
 * reaches the service at all, that a bad range is rejected before any query
 * runs, and that the wire shape is what the client was promised.
 */
jest.mock('../analytics.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const authHeader = `Bearer ${token}`;
const mocked = analyticsService as jest.Mocked<typeof analyticsService>;

const RANGE = {
  startDate: new Date('2026-08-01T00:00:00.000Z'),
  endDate: new Date('2026-08-20T00:00:00.000Z'),
  granularity: 'day' as const,
};

const USER_OVERVIEW = {
  userId: 'user-1',
  range: { startDate: '2026-08-01', endDate: '2026-08-20' },
  totalBlogs: 3,
  publishedBlogs: 2,
  draftBlogs: 1,
  followers: 12,
  views: 100,
  uniqueViews: 80,
  bookmarks: 5,
  netBookmarks: 4,
  comments: 7,
  followersGained: 3,
  followersLost: 1,
  blogsPublishedInRange: 1,
  reading: {
    readStarts: 40,
    readCompletions: 22,
    averageReadingSeconds: 210,
    totalReadingSeconds: 4_620,
    completionRate: 0.55,
    readThroughRate: 0.22,
  },
};

const BLOG_OVERVIEW = {
  blogId: 'blog-1',
  title: 'A Post',
  slug: 'a-post',
  status: 'PUBLISHED',
  publishedAt: '2026-08-01T00:00:00.000Z',
  range: { startDate: '2026-08-01', endDate: '2026-08-20' },
  views: 50,
  uniqueViews: 40,
  bookmarks: 3,
  netBookmarks: 3,
  comments: 2,
  reading: USER_OVERVIEW.reading,
};

describe('Analytics Endpoints (integration, mocked service)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mocked.getUserOverview.mockResolvedValue(USER_OVERVIEW as never);
    mocked.getUserViews.mockResolvedValue({ range: RANGE, points: [] } as never);
    mocked.getUserEngagement.mockResolvedValue({ range: RANGE, points: [] } as never);
    mocked.getUserFollowers.mockResolvedValue({
      range: RANGE,
      currentFollowers: 12,
      points: [],
    } as never);
    mocked.getUserTopBlogs.mockResolvedValue({
      range: RANGE,
      metric: 'views',
      items: [],
      nextCursor: null,
      hasNextPage: false,
    } as never);

    mocked.getBlogOverview.mockResolvedValue(BLOG_OVERVIEW as never);
    mocked.getBlogViews.mockResolvedValue({ range: RANGE, points: [] } as never);
    mocked.getBlogEngagement.mockResolvedValue({ range: RANGE, points: [] } as never);
    mocked.getBlogReading.mockResolvedValue({
      range: RANGE,
      reading: USER_OVERVIEW.reading,
      estimatedReadingMinutes: 8,
    } as never);
    mocked.recordReadingProgress.mockResolvedValue(undefined as never);
  });

  describe('authentication', () => {
    const protectedRoutes = [
      '/api/v1/analytics/me/overview',
      '/api/v1/analytics/me/views',
      '/api/v1/analytics/me/engagement',
      '/api/v1/analytics/me/followers',
      '/api/v1/analytics/me/top-blogs',
      '/api/v1/analytics/blogs/blog-1/overview',
      '/api/v1/analytics/blogs/blog-1/views',
      '/api/v1/analytics/blogs/blog-1/reading',
      '/api/v1/analytics/blogs/blog-1/engagement',
    ];

    it.each(protectedRoutes)('rejects %s without a token', async (route) => {
      const res = await request(app).get(route);

      expect(res.status).toBe(401);
    });

    it('does not reach the service when unauthenticated', async () => {
      await request(app).get('/api/v1/analytics/me/overview');

      // Auth must gate BEFORE any query is planned, or an unauthenticated
      // request still costs a database round trip.
      expect(mocked.getUserOverview).not.toHaveBeenCalled();
    });

    it('rejects an invalid token', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/me/overview')
        .set('Authorization', 'Bearer not-a-real-token');

      expect(res.status).toBe(401);
    });
  });

  describe('GET /analytics/me/overview', () => {
    it('returns the overview and echoes the resolved range', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/me/overview')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.overview).toMatchObject({ views: 100, followers: 12 });
      // The client charts a range it did not necessarily specify, so it has to
      // be told which one it got.
      expect(res.body.meta.range).toEqual({ startDate: '2026-08-01', endDate: '2026-08-20' });
    });

    it('scopes the request to the token’s own user', async () => {
      await request(app).get('/api/v1/analytics/me/overview').set('Authorization', authHeader);

      // No `granularity` here: an overview collapses the range into one set of
      // totals, so it uses the range-only schema and never advertises a bucket
      // size it would ignore.
      expect(mocked.getUserOverview).toHaveBeenCalledWith(
        { userId: 'user-1', role: 'USER' },
        {}
      );
    });

    it('does not accept a granularity it would ignore', async () => {
      await request(app)
        .get('/api/v1/analytics/me/overview?granularity=week')
        .set('Authorization', authHeader);

      const query = mocked.getUserOverview.mock.calls[0]?.[1];
      expect(query).not.toHaveProperty('granularity');
    });

    it('serves a year-long overview that the series bucket cap would reject', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/me/overview?startDate=2025-08-21&endDate=2026-08-20')
        .set('Authorization', authHeader);

      // One indexed aggregate, not 365 data points.
      expect(res.status).toBe(200);
    });
  });

  describe('date range parameters', () => {
    it('passes explicit dates and granularity through', async () => {
      await request(app)
        .get('/api/v1/analytics/me/views?startDate=2026-08-01&endDate=2026-08-20&granularity=week')
        .set('Authorization', authHeader);

      expect(mocked.getUserViews).toHaveBeenCalledWith(expect.anything(), {
        startDate: '2026-08-01',
        endDate: '2026-08-20',
        granularity: 'week',
      });
    });

    it('defaults granularity to day', async () => {
      await request(app).get('/api/v1/analytics/me/views').set('Authorization', authHeader);

      expect(mocked.getUserViews).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ granularity: 'day' })
      );
    });

    it('rejects an unknown granularity without reaching the service', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/me/views?granularity=hour')
        .set('Authorization', authHeader);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mocked.getUserViews).not.toHaveBeenCalled();
    });

    it('rejects a malformed date', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/me/views?startDate=August%201st')
        .set('Authorization', authHeader);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('surfaces the service’s range errors with their own codes', async () => {
      mocked.getUserViews.mockRejectedValue(
        new AppError('too many points', 400, 'RANGE_TOO_LARGE')
      );

      const res = await request(app)
        .get('/api/v1/analytics/me/views?startDate=2020-01-01&endDate=2026-08-20')
        .set('Authorization', authHeader);

      expect(res.status).toBe(400);
      // Distinct from VALIDATION_ERROR so a client can offer "try a coarser
      // granularity" rather than "check your input".
      expect(res.body.error.code).toBe('RANGE_TOO_LARGE');
    });
  });

  describe('GET /analytics/me/top-blogs', () => {
    it('returns items in data and pagination in meta', async () => {
      mocked.getUserTopBlogs.mockResolvedValue({
        range: RANGE,
        metric: 'views',
        items: [
          {
            blogId: 'blog-1',
            title: 'A Post',
            slug: 'a-post',
            publishedAt: null,
            views: 10,
            uniqueViews: 8,
            netBookmarks: 1,
            comments: 0,
            metricValue: 10,
          },
        ],
        nextCursor: 'CURSOR',
        hasNextPage: true,
      } as never);

      const res = await request(app)
        .get('/api/v1/analytics/me/top-blogs')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.meta).toMatchObject({
        nextCursor: 'CURSOR',
        hasNextPage: true,
        metric: 'views',
      });
    });

    it('accepts a metric and a cursor', async () => {
      await request(app)
        .get('/api/v1/analytics/me/top-blogs?metric=comments&limit=5&cursor=abc')
        .set('Authorization', authHeader);

      expect(mocked.getUserTopBlogs).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ metric: 'comments', limit: 5, cursor: 'abc' })
      );
    });

    it('rejects an unknown metric', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/me/top-blogs?metric=DROP+TABLE')
        .set('Authorization', authHeader);

      // The metric selects a SQL fragment, so it must never be an open string.
      expect(res.status).toBe(400);
      expect(mocked.getUserTopBlogs).not.toHaveBeenCalled();
    });

    it('caps the page size', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/me/top-blogs?limit=500')
        .set('Authorization', authHeader);

      expect(res.status).toBe(400);
    });
  });

  describe('per-blog reports', () => {
    it('passes the blog id and the requester to the service', async () => {
      await request(app)
        .get('/api/v1/analytics/blogs/blog-99/overview')
        .set('Authorization', authHeader);

      expect(mocked.getBlogOverview).toHaveBeenCalledWith(
        'blog-99',
        { userId: 'user-1', role: 'USER' },
        expect.anything()
      );
    });

    it('returns 404 for a blog the requester does not own', async () => {
      mocked.getBlogOverview.mockRejectedValue(
        new AppError('Blog not found', 404, 'BLOG_NOT_FOUND')
      );

      const res = await request(app)
        .get('/api/v1/analytics/blogs/someone-elses-blog/overview')
        .set('Authorization', authHeader);

      // 404, never 403: a 403 would confirm the id is real, which for a draft
      // is exactly the fact its author relies on us not to leak.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BLOG_NOT_FOUND');
    });

    it('returns reading stats with the post’s own estimate alongside', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/blogs/blog-1/reading')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.reading.completionRate).toBe(0.55);
      expect(res.body.data.estimatedReadingMinutes).toBe(8);
    });
  });

  describe('POST /analytics/blogs/:blogId/read', () => {
    const body = {
      event: 'BLOG_READ_STARTED',
      sessionId: 'session-aaaaaaaaaaaa',
      anonymousId: 'anon-aaaaaaaaaaaaa',
    };

    it('accepts telemetry from an anonymous reader', async () => {
      const res = await request(app).post('/api/v1/analytics/blogs/blog-1/read').send(body);

      // 202, not 200: the event is buffered for processing, not stored. Saying
      // 200 OK would claim a durability the pipeline does not offer.
      expect(res.status).toBe(202);
      expect(mocked.recordReadingProgress).toHaveBeenCalled();
    });

    it('accepts telemetry from a signed-in reader', async () => {
      const res = await request(app)
        .post('/api/v1/analytics/blogs/blog-1/read')
        .set('Authorization', authHeader)
        .send({ event: 'BLOG_READ_COMPLETED', sessionId: 'session-aaaaaaaaaaaa', durationSeconds: 300 });

      expect(res.status).toBe(202);
      expect(mocked.recordReadingProgress).toHaveBeenCalledWith(
        'blog-1',
        expect.objectContaining({ event: 'BLOG_READ_COMPLETED', durationSeconds: 300 }),
        { userId: 'user-1', role: 'USER' },
        expect.any(String)
      );
    });

    it('derives a STABLE event id, so a repeated beacon dedupes', async () => {
      await request(app).post('/api/v1/analytics/blogs/blog-1/read').send(body);
      await request(app).post('/api/v1/analytics/blogs/blog-1/read').send(body);

      const [first, second] = mocked.recordReadingProgress.mock.calls;
      // `sendBeacon` and a retrying fetch both deliver twice; a random id would
      // make each delivery look like a separate read.
      expect(first?.[3]).toBe(second?.[3]);
    });

    it('gives a different event id to a different session', async () => {
      await request(app).post('/api/v1/analytics/blogs/blog-1/read').send(body);
      await request(app)
        .post('/api/v1/analytics/blogs/blog-1/read')
        .send({ ...body, sessionId: 'session-bbbbbbbbbbbb' });

      const [first, second] = mocked.recordReadingProgress.mock.calls;
      expect(first?.[3]).not.toBe(second?.[3]);
    });

    it('gives a different event id to start and completion of one session', async () => {
      await request(app).post('/api/v1/analytics/blogs/blog-1/read').send(body);
      await request(app)
        .post('/api/v1/analytics/blogs/blog-1/read')
        .send({ ...body, event: 'BLOG_READ_COMPLETED' });

      const [first, second] = mocked.recordReadingProgress.mock.calls;
      expect(first?.[3]).not.toBe(second?.[3]);
    });

    it('refuses an event type a client may not report', async () => {
      const res = await request(app)
        .post('/api/v1/analytics/blogs/blog-1/read')
        .send({ ...body, event: 'BLOG_VIEWED' });

      // Otherwise any caller could manufacture views for any blog.
      expect(res.status).toBe(400);
      expect(mocked.recordReadingProgress).not.toHaveBeenCalled();
    });

    it('refuses a session id that could forge a Redis key segment', async () => {
      const res = await request(app)
        .post('/api/v1/analytics/blogs/blog-1/read')
        .send({ ...body, sessionId: 'a'.repeat(300) });

      expect(res.status).toBe(400);
    });

    it('returns 404 for a blog the reader cannot see', async () => {
      mocked.recordReadingProgress.mockRejectedValue(
        new AppError('Blog not found', 404, 'BLOG_NOT_FOUND')
      );

      const res = await request(app).post('/api/v1/analytics/blogs/private-blog/read').send(body);

      // Without the visibility check this endpoint would be an id-enumeration
      // oracle for the whole blog table.
      expect(res.status).toBe(404);
    });
  });

  describe('route ordering', () => {
    it('does not capture /me as a blog id', async () => {
      await request(app).get('/api/v1/analytics/me/overview').set('Authorization', authHeader);

      expect(mocked.getUserOverview).toHaveBeenCalled();
      expect(mocked.getBlogOverview).not.toHaveBeenCalled();
    });

    it('404s an unknown analytics path rather than falling through', async () => {
      const res = await request(app)
        .get('/api/v1/analytics/nope')
        .set('Authorization', authHeader);

      expect(res.status).toBe(404);
    });
  });
});
