import request from 'supertest';
import app from '../../../app';
import { AppError } from '../../../core/exceptions/AppError';
import { tokensService } from '../../auth/tokens.service';
import { feedService } from '../feed.service';
import { DEFAULT_FEED_LIMIT, DEFAULT_TRENDING_WINDOW, MAX_FEED_LIMIT } from '../feed.config';

/**
 * Route-level tests with the service mocked, so what is under test is the HTTP
 * contract: auth wiring, query validation, the response envelope, and the fact
 * that a viewer identity can only ever come from the token.
 *
 * Behaviour against real SQL lives in `feed.db.test.ts`; composition lives in
 * `feed.service.test.ts`.
 */

jest.mock('../feed.service');

const mocked = feedService as jest.Mocked<typeof feedService>;

const token = tokensService.generateAccessToken({ userId: 'viewer-1', role: 'USER' });
const authHeader = `Bearer ${token}`;

const ITEM = {
  id: 'b1',
  title: 'A Post',
  slug: 'a-post',
  excerpt: 'A subtitle',
  coverImage: null,
  author: { id: 'a1', username: 'grace', name: 'Grace', avatar: null, isVerified: true },
  tags: [{ id: 't1', name: 'react', slug: 'react' }],
  categories: [],
  readingTimeMinutes: 6,
  publishedAt: '2026-03-01T00:00:00.000Z',
  engagement: { comments: 3, bookmarks: 1 },
};

const PAGE = { items: [ITEM], nextCursor: 'CURSOR', hasMore: true };
const EMPTY = { items: [], nextCursor: null, hasMore: false };

beforeEach(() => {
  jest.clearAllMocks();
  mocked.getFollowingFeed.mockResolvedValue(PAGE as never);
  mocked.getLatestFeed.mockResolvedValue(PAGE as never);
  mocked.getExploreFeed.mockResolvedValue(PAGE as never);
  mocked.getTrendingFeed.mockResolvedValue(PAGE as never);
});

describe('response envelope', () => {
  it('returns items in `data` and pagination in `meta`', async () => {
    const res = await request(app).get('/api/v1/feed/latest');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.meta).toMatchObject({
      nextCursor: 'CURSOR',
      hasNextPage: true,
      hasMore: true,
    });
  });

  it('reports the end of a feed with a null cursor', async () => {
    mocked.getLatestFeed.mockResolvedValue(EMPTY as never);

    const res = await request(app).get('/api/v1/feed/latest');

    expect(res.body.data.items).toEqual([]);
    expect(res.body.meta).toMatchObject({ nextCursor: null, hasNextPage: false });
  });

  it('never exposes the blog body or internal fields through the API', async () => {
    const res = await request(app).get('/api/v1/feed/latest');

    expect(res.body.data.items[0]).not.toHaveProperty('content');
    expect(res.body.data.items[0]).not.toHaveProperty('status');
    expect(res.body.data.items[0]).not.toHaveProperty('score');
    expect(res.body.data.items[0]).toHaveProperty('excerpt');
  });

  it('echoes the resolved window on trending, which is defaulted server-side', async () => {
    const res = await request(app).get('/api/v1/feed/trending');
    expect(res.body.meta.window).toBe(DEFAULT_TRENDING_WINDOW);
  });
});

describe('authentication', () => {
  it('rejects the following feed without a token', async () => {
    const res = await request(app).get('/api/v1/feed/following');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mocked.getFollowingFeed).not.toHaveBeenCalled();
  });

  it('rejects the following feed with an invalid token', async () => {
    const res = await request(app)
      .get('/api/v1/feed/following')
      .set('Authorization', 'Bearer not-a-token');

    expect(res.status).toBe(401);
  });

  it('serves the following feed to the TOKEN’S user, never a requested one', async () => {
    // There is no `:userId` on this route, so asking for someone else's feed is
    // not an authorization check that could be forgotten — it cannot be
    // expressed. A query parameter attempting it is simply ignored.
    const res = await request(app)
      .get('/api/v1/feed/following?userId=someone-else')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(mocked.getFollowingFeed).toHaveBeenCalledWith('viewer-1', expect.any(Object));
  });

  it.each([['latest'], ['explore'], ['trending']])(
    'serves /%s anonymously',
    async (feed) => {
      const res = await request(app).get(`/api/v1/feed/${feed}`);
      expect(res.status).toBe(200);
    }
  );

  it('degrades an expired token to an anonymous discovery request', async () => {
    const res = await request(app)
      .get('/api/v1/feed/explore')
      .set('Authorization', 'Bearer expired.token.value');

    expect(res.status).toBe(200);
    expect(mocked.getExploreFeed).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it('passes the viewer to explore when a valid token is present', async () => {
    await request(app).get('/api/v1/feed/explore').set('Authorization', authHeader);

    expect(mocked.getExploreFeed).toHaveBeenCalledWith(expect.any(Object), 'viewer-1');
  });
});

describe('query handling', () => {
  it('applies defaults', async () => {
    await request(app).get('/api/v1/feed/latest');

    expect(mocked.getLatestFeed).toHaveBeenCalledWith(
      expect.objectContaining({ limit: DEFAULT_FEED_LIMIT })
    );
  });

  it('forwards pagination and every filter', async () => {
    await request(app).get(
      '/api/v1/feed/latest?cursor=c1&limit=5&tag=react&category=frontend' +
        '&author=grace&minReadingTime=2&maxReadingTime=10'
    );

    expect(mocked.getLatestFeed).toHaveBeenCalledWith({
      cursor: 'c1',
      limit: 5,
      tag: ['react'],
      category: ['frontend'],
      author: 'grace',
      minReadingTime: 2,
      maxReadingTime: 10,
    });
  });

  it('forwards the explore opt-in', async () => {
    await request(app)
      .get('/api/v1/feed/explore?excludeFollowing=true')
      .set('Authorization', authHeader);

    expect(mocked.getExploreFeed).toHaveBeenCalledWith(
      expect.objectContaining({ excludeFollowing: true }),
      'viewer-1'
    );
  });

  it('forwards the trending window', async () => {
    await request(app).get('/api/v1/feed/trending?window=24h');

    expect(mocked.getTrendingFeed).toHaveBeenCalledWith(
      expect.objectContaining({ window: '24h' })
    );
  });

  it('forwards filters on the following feed', async () => {
    await request(app)
      .get('/api/v1/feed/following?tag=react,node&limit=5')
      .set('Authorization', authHeader);

    expect(mocked.getFollowingFeed).toHaveBeenCalledWith(
      'viewer-1',
      expect.objectContaining({ tag: ['react', 'node'], limit: 5 })
    );
  });
});

describe('validation', () => {
  it.each([
    ['limit=0'],
    [`limit=${MAX_FEED_LIMIT + 1}`],
    ['limit=abc'],
    ['minReadingTime=10&maxReadingTime=5'],
    ['minReadingTime=-4'],
  ])('rejects ?%s with a 400 and field details', async (query) => {
    const res = await request(app).get(`/api/v1/feed/latest?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(mocked.getLatestFeed).not.toHaveBeenCalled();
  });

  it('rejects an unknown trending window', async () => {
    const res = await request(app).get('/api/v1/feed/trending?window=90d');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an over-long cursor before decoding it', async () => {
    const res = await request(app).get(`/api/v1/feed/latest?cursor=${'x'.repeat(600)}`);

    expect(res.status).toBe(400);
    expect(mocked.getLatestFeed).not.toHaveBeenCalled();
  });

  it('validates the following feed too', async () => {
    const res = await request(app)
      .get('/api/v1/feed/following?limit=999')
      .set('Authorization', authHeader);

    expect(res.status).toBe(400);
  });
});

describe('error handling', () => {
  it('surfaces an invalid cursor as a 400 with a stable code', async () => {
    mocked.getLatestFeed.mockRejectedValue(
      new AppError('Invalid or expired feed cursor', 400, 'INVALID_CURSOR')
    );

    const res = await request(app).get('/api/v1/feed/latest?cursor=forged');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('does not leak internals when the service fails unexpectedly', async () => {
    mocked.getTrendingFeed.mockRejectedValue(new Error('analytics exploded'));

    const res = await request(app).get('/api/v1/feed/trending');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('analytics exploded');
  });
});

describe('routing', () => {
  it('does not expose an unknown feed', async () => {
    const res = await request(app).get('/api/v1/feed/recommended');
    expect(res.status).toBe(404);
  });

  it('does not expose a write surface', async () => {
    const res = await request(app).post('/api/v1/feed/latest').send({});
    expect(res.status).toBe(404);
  });
});
