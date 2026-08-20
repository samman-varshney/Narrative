import request from 'supertest';
import app from '../../../app';
import { allowActiveAccounts } from '../../../test/auth';
import { followService } from '../follow.service';
import { tokensService } from '../../auth/tokens.service';
import { AppError } from '../../../core/exceptions/AppError';

// Integration tests mock the service layer to exercise Routes, Validators,
// requireAuth/optionalAuth, the response envelope, and route ordering.
jest.mock('../follow.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const authHeader = `Bearer ${token}`;

const mockedService = followService as jest.Mocked<typeof followService>;

const STATUS = {
  isFollowing: true,
  isFollowedBy: false,
  isMutual: false,
  followersCount: 1,
  followingCount: 0,
};

describe('Follow Endpoints (Integration Mocks)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Following sits behind `requireActiveAccount`; see src/test/auth.ts.
    allowActiveAccounts();
  });

  describe('POST /api/v1/users/:userId/follow', () => {
    it('returns 401 without authentication', async () => {
      const response = await request(app).post('/api/v1/users/user-2/follow');
      expect(response.status).toBe(401);
      expect(mockedService.followUser).not.toHaveBeenCalled();
    });

    it('follows as the authenticated user and returns the status envelope', async () => {
      mockedService.followUser.mockResolvedValue(STATUS);

      const response = await request(app)
        .post('/api/v1/users/user-2/follow')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.isFollowing).toBe(true);
      expect(response.body.meta.message).toMatch(/followed/i);
      // Authorization: follower is ALWAYS the token's userId, never spoofable.
      expect(mockedService.followUser).toHaveBeenCalledWith('user-1', 'user-2');
    });

    it('is idempotent on a repeat follow (still 200)', async () => {
      mockedService.followUser.mockResolvedValue(STATUS);
      const response = await request(app)
        .post('/api/v1/users/user-2/follow')
        .set('Authorization', authHeader);
      expect(response.status).toBe(200);
    });

    it('surfaces a self-follow as 400 SELF_FOLLOW', async () => {
      mockedService.followUser.mockRejectedValue(
        new AppError('You cannot follow yourself', 400, 'SELF_FOLLOW')
      );

      const response = await request(app)
        .post('/api/v1/users/user-1/follow')
        .set('Authorization', authHeader);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SELF_FOLLOW');
    });
  });

  describe('DELETE /api/v1/users/:userId/follow', () => {
    it('returns 401 without authentication', async () => {
      const response = await request(app).delete('/api/v1/users/user-2/follow');
      expect(response.status).toBe(401);
    });

    it('unfollows and returns 200 (idempotent by design)', async () => {
      mockedService.unfollowUser.mockResolvedValue({ ...STATUS, isFollowing: false });

      const response = await request(app)
        .delete('/api/v1/users/user-2/follow')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.data.isFollowing).toBe(false);
      expect(mockedService.unfollowUser).toHaveBeenCalledWith('user-1', 'user-2');
    });
  });

  describe('GET /api/v1/users/:userId/followers (public)', () => {
    const page = { items: [{ id: 'a', username: 'alice' }], nextCursor: null, hasNextPage: false, totalCount: 1 };

    it('is publicly accessible WITHOUT a token (anonymous viewer)', async () => {
      mockedService.getFollowers.mockResolvedValue(page as any);

      const response = await request(app).get('/api/v1/users/user-2/followers');

      expect(response.status).toBe(200);
      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.meta).toMatchObject({ hasNextPage: false, totalCount: 1 });
      // Anonymous → no viewerId passed.
      expect(mockedService.getFollowers).toHaveBeenCalledWith('user-2', expect.any(Object), undefined);
    });

    it('passes the viewer id through when a token is present', async () => {
      mockedService.getFollowers.mockResolvedValue(page as any);

      await request(app)
        .get('/api/v1/users/user-2/followers?limit=5')
        .set('Authorization', authHeader);

      expect(mockedService.getFollowers).toHaveBeenCalledWith(
        'user-2',
        expect.objectContaining({ limit: 5 }),
        'user-1'
      );
    });

    it('returns 400 VALIDATION_ERROR for an out-of-range limit', async () => {
      const response = await request(app).get('/api/v1/users/user-2/followers?limit=999');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockedService.getFollowers).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/users/:userId/following (public)', () => {
    it('is publicly accessible and returns the list envelope', async () => {
      mockedService.getFollowing.mockResolvedValue({
        items: [],
        nextCursor: null,
        hasNextPage: false,
        totalCount: 0,
      });

      const response = await request(app).get('/api/v1/users/user-2/following');

      expect(response.status).toBe(200);
      expect(mockedService.getFollowing).toHaveBeenCalledWith('user-2', expect.any(Object), undefined);
    });
  });

  describe('GET /api/v1/users/:userId/follow-status (protected)', () => {
    it('returns 401 without a token', async () => {
      const response = await request(app).get('/api/v1/users/user-2/follow-status');
      expect(response.status).toBe(401);
    });

    it('returns the relationship status for the authenticated viewer', async () => {
      mockedService.getFollowStatus.mockResolvedValue(STATUS);

      const response = await request(app)
        .get('/api/v1/users/user-2/follow-status')
        .set('Authorization', authHeader);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ isFollowing: true, isMutual: false });
      expect(mockedService.getFollowStatus).toHaveBeenCalledWith('user-1', 'user-2');
    });
  });

  describe('route co-existence with userRoutes', () => {
    it('does not shadow the public single-segment user profile route', async () => {
      // A 1-segment path must fall through to userRoutes, not the follow router.
      // We only assert the follow service was not invoked for it.
      await request(app).get('/api/v1/users/someusername').catch(() => undefined);
      expect(mockedService.getFollowers).not.toHaveBeenCalled();
      expect(mockedService.getFollowing).not.toHaveBeenCalled();
    });
  });
});
