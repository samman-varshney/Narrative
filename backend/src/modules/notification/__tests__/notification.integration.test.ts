import request from 'supertest';
import app from '../../../app';
import { notificationService } from '../notification.service';
import { tokensService } from '../../auth/tokens.service';
import { AppError } from '../../../core/exceptions/AppError';

// Mocks the service to exercise routes, validators, requireAuth, the response
// envelope, and route ordering. Behaviour against real SQL lives in
// notification.db.test.ts.
jest.mock('../notification.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const authHeader = `Bearer ${token}`;
const mocked = notificationService as jest.Mocked<typeof notificationService>;

const PAGE = {
  items: [
    {
      id: 'n1',
      type: 'FOLLOW' as const,
      actor: { id: 'a1', username: 'grace', name: 'Grace', avatar: null, isVerified: true },
      entityType: 'USER',
      entityId: 'a1',
      metadata: null,
      isRead: false,
      readAt: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    },
  ],
  nextCursor: null,
  hasNextPage: false,
  totalCount: 1,
  unreadCount: 1,
};

const PREFS = {
  FOLLOW: { inApp: true, email: true },
  COMMENT: { inApp: true, email: false },
  REPLY: { inApp: true, email: true },
  BLOG: { inApp: true, email: true },
  SYSTEM: { inApp: true, email: true },
  MENTION: { inApp: true, email: true },
  LIKE: { inApp: true, email: false },
};

describe('Notification Endpoints (Integration Mocks)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/v1/notifications', () => {
    it('returns the list with pagination meta for the token user', async () => {
      mocked.list.mockResolvedValue(PAGE as any);

      const res = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.meta).toMatchObject({ totalCount: 1, unreadCount: 1 });
      // The recipient is always the token's user, never a param.
      expect(mocked.list).toHaveBeenCalledWith('user-1', expect.objectContaining({ sort: 'recent' }));
    });

    it('forwards filters and pagination to the service', async () => {
      mocked.list.mockResolvedValue(PAGE as any);

      await request(app)
        .get('/api/v1/notifications?limit=5&cursor=n9&sort=oldest&type=COMMENT&isRead=false')
        .set('Authorization', authHeader);

      expect(mocked.list).toHaveBeenCalledWith('user-1', {
        limit: 5,
        cursor: 'n9',
        sort: 'oldest',
        type: 'COMMENT',
        isRead: false,
      });
    });

    it('returns 400 for an out-of-range limit', async () => {
      const res = await request(app)
        .get('/api/v1/notifications?limit=999')
        .set('Authorization', authHeader);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mocked.list).not.toHaveBeenCalled();
    });

    it('returns 400 for an unknown type filter', async () => {
      const res = await request(app)
        .get('/api/v1/notifications?type=GOSSIP')
        .set('Authorization', authHeader);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a token', async () => {
      const res = await request(app).get('/api/v1/notifications');
      expect(res.status).toBe(401);
      expect(mocked.list).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/notifications/unread-count', () => {
    it('resolves ahead of the /:id routes', async () => {
      mocked.unreadCount.mockResolvedValue({ unreadCount: 7 });

      const res = await request(app)
        .get('/api/v1/notifications/unread-count')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.unreadCount).toBe(7);
      expect(mocked.unreadCount).toHaveBeenCalledWith('user-1');
    });

    it('returns 401 without a token', async () => {
      expect((await request(app).get('/api/v1/notifications/unread-count')).status).toBe(401);
    });
  });

  describe('PATCH /api/v1/notifications/:id/read', () => {
    it('marks one read', async () => {
      mocked.markRead.mockResolvedValue({ unreadCount: 3 });

      const res = await request(app)
        .patch('/api/v1/notifications/n1/read')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.unreadCount).toBe(3);
      expect(mocked.markRead).toHaveBeenCalledWith('user-1', 'n1');
    });

    it("surfaces 404 for another user's notification", async () => {
      mocked.markRead.mockRejectedValue(
        new AppError('Notification not found', 404, 'NOTIFICATION_NOT_FOUND')
      );

      const res = await request(app)
        .patch('/api/v1/notifications/someone-elses/read')
        .set('Authorization', authHeader);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOTIFICATION_NOT_FOUND');
    });

    it('returns 401 without a token', async () => {
      expect((await request(app).patch('/api/v1/notifications/n1/read')).status).toBe(401);
    });
  });

  describe('PATCH /api/v1/notifications/read-all', () => {
    it('resolves ahead of /:id/read rather than being treated as an id', async () => {
      mocked.markAllRead.mockResolvedValue({ updated: 5, unreadCount: 0 });

      const res = await request(app)
        .patch('/api/v1/notifications/read-all')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ updated: 5, unreadCount: 0 });
      expect(mocked.markAllRead).toHaveBeenCalledWith('user-1');
      expect(mocked.markRead).not.toHaveBeenCalled();
    });
  });

  describe('preferences', () => {
    it('returns the resolved preference matrix', async () => {
      mocked.getPreferences.mockResolvedValue(PREFS as any);

      const res = await request(app)
        .get('/api/v1/notifications/preferences')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.preferences.FOLLOW).toEqual({ inApp: true, email: true });
      expect(mocked.getPreferences).toHaveBeenCalledWith('user-1');
    });

    it('accepts a partial patch', async () => {
      mocked.updatePreferences.mockResolvedValue(PREFS as any);

      const res = await request(app)
        .patch('/api/v1/notifications/preferences')
        .set('Authorization', authHeader)
        .send({ FOLLOW: { email: false } });

      expect(res.status).toBe(200);
      expect(mocked.updatePreferences).toHaveBeenCalledWith('user-1', { FOLLOW: { email: false } });
    });

    it('rejects an unknown notification type in the body', async () => {
      const res = await request(app)
        .patch('/api/v1/notifications/preferences')
        .set('Authorization', authHeader)
        .send({ GOSSIP: { email: true } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mocked.updatePreferences).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean toggle', async () => {
      const res = await request(app)
        .patch('/api/v1/notifications/preferences')
        .set('Authorization', authHeader)
        .send({ FOLLOW: { email: 'yes' } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a token', async () => {
      expect((await request(app).get('/api/v1/notifications/preferences')).status).toBe(401);
    });
  });

  it('exposes no route for reading another user\'s notifications', async () => {
    const res = await request(app)
      .get('/api/v1/notifications/user-2')
      .set('Authorization', authHeader);

    // `/:id` is not a GET route — only PATCH /:id/read exists.
    expect(res.status).toBe(404);
  });
});
