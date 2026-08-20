import request from 'supertest';
import app from '../../../app';
import { AppError } from '../../../core/exceptions/AppError';
import { tokensService } from '../../auth/tokens.service';
import { searchService } from '../search.service';

// Mocks the service to exercise routes, query validators, auth wiring, route
// ordering and the response envelope. Behaviour against real SQL lives in
// search.db.test.ts.
jest.mock('../search.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const authHeader = `Bearer ${token}`;
const mocked = searchService as jest.Mocked<typeof searchService>;

const BLOG_HIT = {
  id: 'b1',
  title: 'JavaScript Promises',
  slug: 'javascript-promises',
  excerpt: 'A tour of the microtask queue',
  coverImage: null,
  author: { id: 'a1', username: 'grace', name: 'Grace', avatar: null, isVerified: true },
  tags: [{ id: 't1', name: 'javascript', slug: 'javascript' }],
  categories: [],
  readingTimeMinutes: 7,
  publishedAt: '2026-03-01T00:00:00.000Z',
  score: 12.5,
};

const PAGE = { items: [BLOG_HIT], nextCursor: 'CURSOR', hasMore: true };
const EMPTY = { items: [], nextCursor: null, hasMore: false };

describe('Search Endpoints (Integration Mocks)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocked.searchBlogs.mockResolvedValue(PAGE as never);
    mocked.searchUsers.mockResolvedValue(EMPTY as never);
    mocked.searchTags.mockResolvedValue(EMPTY as never);
    mocked.searchCategories.mockResolvedValue(EMPTY as never);
    mocked.suggest.mockResolvedValue([]);
    mocked.globalSearch.mockResolvedValue({
      query: 'javascript',
      blogs: [],
      users: [],
      tags: [],
      categories: [],
    } as never);
    mocked.listHistory.mockResolvedValue([]);
    mocked.clearHistory.mockResolvedValue(0);
  });

  describe('GET /api/v1/search/blogs', () => {
    it('returns items in `data` and pagination in `meta`', async () => {
      const res = await request(app).get('/api/v1/search/blogs?q=javascript');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.meta).toMatchObject({
        nextCursor: 'CURSOR',
        hasNextPage: true,
        hasMore: true,
      });
    });

    it('never returns the blog content body', async () => {
      const res = await request(app).get('/api/v1/search/blogs?q=javascript');

      // A search page carries up to 50 hits; the Tiptap document would dwarf
      // everything else on the wire.
      expect(res.body.data.items[0]).not.toHaveProperty('content');
      expect(res.body.data.items[0]).toHaveProperty('excerpt');
    });

    it('applies defaults for sort and limit', async () => {
      await request(app).get('/api/v1/search/blogs?q=javascript');

      expect(mocked.searchBlogs).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'javascript', sort: 'relevance', limit: 20 }),
        undefined
      );
    });

    it('forwards pagination, sort and every filter', async () => {
      await request(app).get(
        '/api/v1/search/blogs?q=javascript&cursor=c1&limit=5&sort=newest' +
          '&author=grace&tag=react&category=frontend&from=2026-01-01&to=2026-06-01' +
          '&minReadingTime=2&maxReadingTime=10'
      );

      expect(mocked.searchBlogs).toHaveBeenCalledWith(
        {
          q: 'javascript',
          cursor: 'c1',
          limit: 5,
          sort: 'newest',
          author: 'grace',
          tag: ['react'],
          category: ['frontend'],
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: new Date('2026-06-01T00:00:00.000Z'),
          minReadingTime: 2,
          maxReadingTime: 10,
        },
        undefined
      );
    });

    it.each([
      ['repeated params', '?q=js&tag=react&tag=hooks'],
      ['a comma-separated list', '?q=js&tag=react,hooks'],
    ])('accepts a multi-valued filter as %s', async (_label, qs) => {
      await request(app).get(`/api/v1/search/blogs${qs}`);

      expect(mocked.searchBlogs).toHaveBeenCalledWith(
        expect.objectContaining({ tag: ['react', 'hooks'] }),
        undefined
      );
    });

    it('de-duplicates and lowercases multi-valued filters', async () => {
      await request(app).get('/api/v1/search/blogs?q=js&tag=React&tag=react&tag=REACT');

      expect(mocked.searchBlogs).toHaveBeenCalledWith(
        expect.objectContaining({ tag: ['react'] }),
        undefined
      );
    });

    it('passes the viewer id only when a valid token is present', async () => {
      await request(app).get('/api/v1/search/blogs?q=js').set('Authorization', authHeader);

      expect(mocked.searchBlogs).toHaveBeenCalledWith(expect.anything(), 'user-1');
    });

    it('treats an invalid token as anonymous instead of rejecting', async () => {
      // optionalAuth: an expired token mid-typeahead must degrade to an
      // anonymous search, never a 401.
      const res = await request(app)
        .get('/api/v1/search/blogs?q=js')
        .set('Authorization', 'Bearer garbage');

      expect(res.status).toBe(200);
      expect(mocked.searchBlogs).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it.each([
      ['a missing query', '?limit=5'],
      ['an empty query', '?q='],
      ['an over-long query', `?q=${'a'.repeat(129)}`],
      ['an unknown sort', '?q=js&sort=trending'],
      ['limit above the cap', '?q=js&limit=51'],
      ['limit below one', '?q=js&limit=0'],
      ['a non-numeric limit', '?q=js&limit=many'],
      ['an inverted date range', '?q=js&from=2026-06-01&to=2026-01-01'],
      ['inverted reading-time bounds', '?q=js&minReadingTime=10&maxReadingTime=2'],
      ['an unparsable date', '?q=js&from=notadate'],
    ])('rejects %s with a 400', async (_label, qs) => {
      const res = await request(app).get(`/api/v1/search/blogs${qs}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mocked.searchBlogs).not.toHaveBeenCalled();
    });

    it('surfaces an invalid cursor as a 400 INVALID_CURSOR', async () => {
      mocked.searchBlogs.mockRejectedValue(
        new AppError('Invalid or expired search cursor', 400, 'INVALID_CURSOR')
      );

      const res = await request(app).get('/api/v1/search/blogs?q=js&cursor=tampered');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });
  });

  describe('GET /api/v1/search/users | /tags | /categories', () => {
    it.each([
      ['/users', () => mocked.searchUsers],
      ['/tags', () => mocked.searchTags],
      ['/categories', () => mocked.searchCategories],
    ])('%s reaches its own service method', async (path, getMock) => {
      const res = await request(app).get(`/api/v1/search${path}?q=react`);

      expect(res.status).toBe(200);
      expect(getMock()).toHaveBeenCalled();
      expect(res.body.meta).toMatchObject({ nextCursor: null, hasMore: false });
    });

    it('rejects a blog-only filter on an entity endpoint by ignoring it', async () => {
      // The entity schemas do not declare `author`; Zod strips unknown keys, so
      // the filter cannot leak through to a query that would not honour it.
      await request(app).get('/api/v1/search/users?q=grace&author=someone');

      expect(mocked.searchUsers).toHaveBeenCalledWith(
        { q: 'grace', limit: 20, sort: 'relevance' },
        undefined
      );
    });

    it('does not pass a viewer to tag or category lookups', async () => {
      await request(app).get('/api/v1/search/tags?q=react').set('Authorization', authHeader);

      expect(mocked.searchTags).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('GET /api/v1/search', () => {
    it('returns the cross-entity overview without pagination meta', async () => {
      const res = await request(app).get('/api/v1/search?q=javascript');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        query: 'javascript',
        blogs: [],
        users: [],
        tags: [],
        categories: [],
      });
      expect(res.body.data).not.toHaveProperty('nextCursor');
    });

    it('caps the per-entity slice', async () => {
      const res = await request(app).get('/api/v1/search?q=js&limit=21');

      expect(res.status).toBe(400);
    });

    it('does not shadow the literal-segment routes', async () => {
      // `/` is registered last precisely so `/blogs` cannot be swallowed.
      await request(app).get('/api/v1/search/blogs?q=js');

      expect(mocked.searchBlogs).toHaveBeenCalled();
      expect(mocked.globalSearch).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/search/suggestions', () => {
    it('returns suggestions under `data.suggestions`', async () => {
      mocked.suggest.mockResolvedValue([
        { text: 'javascript', source: 'TAG', slug: 'javascript' },
      ]);

      const res = await request(app).get('/api/v1/search/suggestions?q=jav');

      expect(res.status).toBe(200);
      expect(res.body.data.suggestions).toEqual([
        { text: 'javascript', source: 'TAG', slug: 'javascript' },
      ]);
    });

    it('defaults and caps the limit', async () => {
      await request(app).get('/api/v1/search/suggestions?q=jav');
      expect(mocked.suggest).toHaveBeenCalledWith({ q: 'jav', limit: 10 });

      const res = await request(app).get('/api/v1/search/suggestions?q=jav&limit=21');
      expect(res.status).toBe(400);
    });

    it('accepts a single-character prefix', async () => {
      // Typeahead starts at the first keystroke.
      const res = await request(app).get('/api/v1/search/suggestions?q=j');

      expect(res.status).toBe(200);
    });
  });

  describe('search history', () => {
    it('requires authentication to read', async () => {
      const res = await request(app).get('/api/v1/search/history');

      expect(res.status).toBe(401);
      expect(mocked.listHistory).not.toHaveBeenCalled();
    });

    it('requires authentication to clear', async () => {
      const res = await request(app).delete('/api/v1/search/history');

      expect(res.status).toBe(401);
      expect(mocked.clearHistory).not.toHaveBeenCalled();
    });

    it('always reads the token user’s own history, never a param', async () => {
      const res = await request(app)
        .get('/api/v1/search/history?limit=5&userId=someone-else')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(mocked.listHistory).toHaveBeenCalledWith('user-1', 5);
    });

    it('reports how many entries were cleared', async () => {
      mocked.clearHistory.mockResolvedValue(12);

      const res = await request(app)
        .delete('/api/v1/search/history')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ cleared: 12 });
    });

    it('rejects an out-of-range history limit', async () => {
      const res = await request(app)
        .get('/api/v1/search/history?limit=500')
        .set('Authorization', authHeader);

      expect(res.status).toBe(400);
    });
  });
});
