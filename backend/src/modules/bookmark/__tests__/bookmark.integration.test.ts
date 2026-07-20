import request from 'supertest';
import app from '../../../app';
import { bookmarkService } from '../bookmark.service';
import { tokensService } from '../../auth/tokens.service';
import { AppError } from '../../../core/exceptions/AppError';

// Integration tests mock the service layer to exercise Routes, Validators,
// requireAuth, the response envelope, and route ordering.
jest.mock('../bookmark.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const authHeader = `Bearer ${token}`;
const mockedService = bookmarkService as jest.Mocked<typeof bookmarkService>;

const STATUS = { isBookmarked: true, viewerBookmarksCount: 3, blogBookmarksCount: 9 };

const PAGE = {
  items: [
    {
      bookmarkId: 'b1',
      bookmarkedAt: new Date('2026-07-01T00:00:00Z'),
      isAvailable: true,
      blog: {
        id: 'blog1',
        title: 'Deep Dive',
        slug: 'deep-dive',
        coverImage: null,
        readingTimeMinutes: 7,
        author: {
          id: 'author1',
          username: 'ada',
          name: 'Ada',
          avatar: null,
          isVerified: true,
        },
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        visibility: 'PUBLIC' as const,
      },
    },
  ],
  nextCursor: null,
  hasNextPage: false,
  totalCount: 1,
};

describe('Bookmark Endpoints (Integration Mocks)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('POST /api/v1/blogs/:blogId/bookmark', () => {
    it('bookmarks as the authenticated user and returns the status envelope', async () => {
      mockedService.addBookmark.mockResolvedValue(STATUS);

      const response = await request(app)
        .post('/api/v1/blogs/blog1/bookmark')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.isBookmarked).toBe(true);
      expect(response.body.meta.message).toMatch(/bookmarked/i);
      // Authorization: the owner is ALWAYS the token's userId, never spoofable.
      expect(mockedService.addBookmark).toHaveBeenCalledWith('user-1', 'blog1', 'USER');
    });

    it('ignores a userId supplied in the body — the owner comes from the token', async () => {
      mockedService.addBookmark.mockResolvedValue(STATUS);

      await request(app)
        .post('/api/v1/blogs/blog1/bookmark')
        .set('Authorization', authHeader)
        .send({ userId: 'someone-else' });

      expect(mockedService.addBookmark).toHaveBeenCalledWith('user-1', 'blog1', 'USER');
    });

    it('returns 401 without a token', async () => {
      const response = await request(app).post('/api/v1/blogs/blog1/bookmark');

      expect(response.status).toBe(401);
      expect(mockedService.addBookmark).not.toHaveBeenCalled();
    });

    it('surfaces the service 404 for a blog the viewer cannot see', async () => {
      mockedService.addBookmark.mockRejectedValue(
        new AppError('Blog not found', 404, 'BLOG_NOT_FOUND')
      );

      const response = await request(app)
        .post('/api/v1/blogs/hidden/bookmark')
        .set('Authorization', authHeader);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('BLOG_NOT_FOUND');
    });
  });

  describe('DELETE /api/v1/blogs/:blogId/bookmark', () => {
    it('removes the bookmark for the authenticated user', async () => {
      mockedService.removeBookmark.mockResolvedValue({
        isBookmarked: false,
        viewerBookmarksCount: 2,
        blogBookmarksCount: 8,
      });

      const response = await request(app)
        .delete('/api/v1/blogs/blog1/bookmark')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.data.isBookmarked).toBe(false);
      expect(mockedService.removeBookmark).toHaveBeenCalledWith('user-1', 'blog1');
    });

    it('returns 401 without a token', async () => {
      const response = await request(app).delete('/api/v1/blogs/blog1/bookmark');
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/v1/blogs/:blogId/bookmark/toggle', () => {
    it('resolves ahead of the bare /:blogId/bookmark route', async () => {
      mockedService.toggleBookmark.mockResolvedValue(STATUS);

      const response = await request(app)
        .post('/api/v1/blogs/blog1/bookmark/toggle')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(mockedService.toggleBookmark).toHaveBeenCalledWith('user-1', 'blog1', 'USER');
      expect(mockedService.addBookmark).not.toHaveBeenCalled();
    });

    it('reflects the resulting state in the message', async () => {
      mockedService.toggleBookmark.mockResolvedValue({
        isBookmarked: false,
        viewerBookmarksCount: 2,
        blogBookmarksCount: 8,
      });

      const response = await request(app)
        .post('/api/v1/blogs/blog1/bookmark/toggle')
        .set('Authorization', authHeader);

      expect(response.body.meta.message).toMatch(/removed/i);
    });

    it('returns 401 without a token', async () => {
      const response = await request(app).post('/api/v1/blogs/blog1/bookmark/toggle');
      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/blogs/:blogId/bookmark-status', () => {
    it('returns the status for the authenticated viewer', async () => {
      mockedService.getStatus.mockResolvedValue(STATUS);

      const response = await request(app)
        .get('/api/v1/blogs/blog1/bookmark-status')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        isBookmarked: true,
        viewerBookmarksCount: 3,
        blogBookmarksCount: 9,
      });
      expect(mockedService.getStatus).toHaveBeenCalledWith('user-1', 'blog1', 'USER');
    });

    it('returns 401 without a token — bookmark state is private', async () => {
      const response = await request(app).get('/api/v1/blogs/blog1/bookmark-status');
      expect(response.status).toBe(401);
      expect(mockedService.getStatus).not.toHaveBeenCalled();
    });

    it('surfaces the service 404 for a blog the viewer cannot see', async () => {
      // Status must not be readable for a blog the viewer could not bookmark,
      // or the client renders an enabled button whose POST then 404s.
      mockedService.getStatus.mockRejectedValue(
        new AppError('Blog not found', 404, 'BLOG_NOT_FOUND')
      );

      const response = await request(app)
        .get('/api/v1/blogs/hidden/bookmark-status')
        .set('Authorization', authHeader);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('BLOG_NOT_FOUND');
    });
  });

  describe('GET /api/v1/users/me/bookmarks', () => {
    it('returns the library with pagination meta and resolves ahead of /users/:username', async () => {
      mockedService.getUserBookmarks.mockResolvedValue(PAGE as any);

      const response = await request(app)
        .get('/api/v1/users/me/bookmarks')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.meta).toMatchObject({ hasNextPage: false, totalCount: 1 });
      expect(mockedService.getUserBookmarks).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ sort: 'recent' }),
        'USER'
      );
    });

    it('forwards cursor, sort and filter params to the service', async () => {
      mockedService.getUserBookmarks.mockResolvedValue(PAGE as any);

      await request(app)
        .get('/api/v1/users/me/bookmarks?limit=5&cursor=b10&sort=oldest&authorId=a1&tag=rust')
        .set('Authorization', authHeader);

      expect(mockedService.getUserBookmarks).toHaveBeenCalledWith(
        'user-1',
        { limit: 5, cursor: 'b10', sort: 'oldest', authorId: 'a1', tag: 'rust' },
        'USER'
      );
    });

    it('returns 400 VALIDATION_ERROR for an out-of-range limit', async () => {
      const response = await request(app)
        .get('/api/v1/users/me/bookmarks?limit=999')
        .set('Authorization', authHeader);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockedService.getUserBookmarks).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR for an unknown sort value', async () => {
      const response = await request(app)
        .get('/api/v1/users/me/bookmarks?sort=popular')
        .set('Authorization', authHeader);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a token — a library is private to its owner', async () => {
      const response = await request(app).get('/api/v1/users/me/bookmarks');

      expect(response.status).toBe(401);
      expect(mockedService.getUserBookmarks).not.toHaveBeenCalled();
    });

    it('exposes no route for reading another user\'s library', async () => {
      mockedService.getUserBookmarks.mockResolvedValue(PAGE as any);

      const response = await request(app)
        .get('/api/v1/users/user-2/bookmarks')
        .set('Authorization', authHeader);

      expect(response.status).toBe(404);
      expect(mockedService.getUserBookmarks).not.toHaveBeenCalled();
    });
  });
});
