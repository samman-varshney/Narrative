import request from 'supertest';
import app from '../../../app';
import { allowActiveAccounts } from '../../../test/auth';
import { commentService } from '../comment.service';
import { tokensService } from '../../auth/tokens.service';
import { AppError } from '../../../core/exceptions/AppError';

// Mock the service layer to exercise routing, validators, auth middleware, the
// response envelope, and route ordering (literal /:id/... before bare /:id).
jest.mock('../comment.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const adminToken = tokensService.generateAccessToken({ userId: 'admin-1', role: 'ADMIN' });
const authHeader = `Bearer ${token}`;
const adminHeader = `Bearer ${adminToken}`;

const mocked = commentService as jest.Mocked<typeof commentService>;

const COMMENT = { id: 'c1', content: 'hi', blogId: 'blog-1', parentId: null, depth: 0 };
const PAGE = { items: [COMMENT], nextCursor: null, hasNextPage: false, totalCount: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  // Comment writes sit behind `requireActiveAccount`, which looks the caller's
  // account up. These tests mint tokens for users that do not exist in the
  // database, so the guard is stubbed to "active" — suspension enforcement has
  // its own suite (moderation.suspension.db.test.ts).
  allowActiveAccounts();
});

describe('POST /api/v1/blogs/:blogId/comments', () => {
  it('401 without a token', async () => {
    const res = await request(app).post('/api/v1/blogs/blog-1/comments').send({ content: 'hi' });
    expect(res.status).toBe(401);
    expect(mocked.createComment).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR when content is missing', async () => {
    const res = await request(app)
      .post('/api/v1/blogs/blog-1/comments')
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('creates a comment as the authenticated user (201)', async () => {
    mocked.createComment.mockResolvedValue(COMMENT as any);
    const res = await request(app)
      .post('/api/v1/blogs/blog-1/comments')
      .set('Authorization', authHeader)
      .send({ content: 'hi' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.comment.id).toBe('c1');
    expect(mocked.createComment).toHaveBeenCalledWith(
      'user-1',
      'blog-1',
      expect.objectContaining({ content: 'hi' })
    );
  });

  it('surfaces a missing blog as 404', async () => {
    mocked.createComment.mockRejectedValue(
      new AppError('Blog not found', 404, 'BLOG_NOT_FOUND')
    );
    const res = await request(app)
      .post('/api/v1/blogs/ghost/comments')
      .set('Authorization', authHeader)
      .send({ content: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BLOG_NOT_FOUND');
  });
});

describe('GET /api/v1/blogs/:blogId/comments', () => {
  it('is reachable anonymously and returns the paginated envelope', async () => {
    mocked.getBlogComments.mockResolvedValue(PAGE as any);
    const res = await request(app).get('/api/v1/blogs/blog-1/comments');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.meta.totalCount).toBe(1);
  });

  it('parses tree=false into the query', async () => {
    mocked.getBlogComments.mockResolvedValue(PAGE as any);
    await request(app).get('/api/v1/blogs/blog-1/comments?tree=false&limit=5');
    expect(mocked.getBlogComments).toHaveBeenCalledWith(
      'blog-1',
      expect.objectContaining({ tree: false, limit: 5 })
    );
  });
});

describe('POST /api/v1/comments/:id/reply', () => {
  it('creates a reply (201)', async () => {
    mocked.reply.mockResolvedValue({ ...COMMENT, id: 'c2', parentId: 'c1' } as any);
    const res = await request(app)
      .post('/api/v1/comments/c1/reply')
      .set('Authorization', authHeader)
      .send({ content: 'a reply' });
    expect(res.status).toBe(201);
    expect(mocked.reply).toHaveBeenCalledWith('user-1', 'c1', expect.objectContaining({ content: 'a reply' }));
  });
});

describe('PATCH / DELETE /api/v1/comments/:id', () => {
  it('edits with author identity + role', async () => {
    mocked.edit.mockResolvedValue(COMMENT as any);
    const res = await request(app)
      .patch('/api/v1/comments/c1')
      .set('Authorization', authHeader)
      .send({ content: 'edited' });
    expect(res.status).toBe(200);
    expect(mocked.edit).toHaveBeenCalledWith('c1', 'user-1', 'USER', expect.any(Object));
  });

  it('propagates a 403 from the service on a non-owner edit', async () => {
    mocked.edit.mockRejectedValue(new AppError('nope', 403, 'FORBIDDEN'));
    const res = await request(app)
      .patch('/api/v1/comments/c1')
      .set('Authorization', authHeader)
      .send({ content: 'edited' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('soft-deletes', async () => {
    mocked.softDelete.mockResolvedValue({ ...COMMENT, isDeleted: true } as any);
    const res = await request(app).delete('/api/v1/comments/c1').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(mocked.softDelete).toHaveBeenCalledWith('c1', 'user-1', 'USER');
  });
});

describe('moderation (admin only)', () => {
  it('restore returns 403 for a non-admin (requireRole gate)', async () => {
    const res = await request(app).post('/api/v1/comments/c1/restore').set('Authorization', authHeader);
    expect(res.status).toBe(403);
    expect(mocked.restore).not.toHaveBeenCalled();
  });

  it('restore succeeds for an admin', async () => {
    mocked.restore.mockResolvedValue(COMMENT as any);
    const res = await request(app).post('/api/v1/comments/c1/restore').set('Authorization', adminHeader);
    expect(res.status).toBe(200);
    expect(mocked.restore).toHaveBeenCalledWith('c1', {
      userId: expect.any(String),
      role: 'ADMIN',
    });
  });

  it('hide requires the content:hide permission', async () => {
    const denied = await request(app).post('/api/v1/comments/c1/hide').set('Authorization', authHeader);
    expect(denied.status).toBe(403);

    mocked.hideForModeration.mockResolvedValue(COMMENT as any);
    const ok = await request(app).post('/api/v1/comments/c1/hide').set('Authorization', adminHeader);
    expect(ok.status).toBe(200);
    // The actor comes from the token, never from the request body.
    expect(mocked.hideForModeration).toHaveBeenCalledWith('c1', {
      userId: expect.any(String),
      role: 'ADMIN',
    });
  });
});

describe('route ordering: literal /:id/... beats bare /:id', () => {
  it('GET /comments/:id/replies routes to listReplies, not getOne', async () => {
    mocked.getReplies.mockResolvedValue(PAGE as any);
    const res = await request(app).get('/api/v1/comments/c1/replies');
    expect(res.status).toBe(200);
    expect(mocked.getReplies).toHaveBeenCalled();
    expect(mocked.getById).not.toHaveBeenCalled();
  });

  it('GET /comments/:id routes to getOne', async () => {
    mocked.getById.mockResolvedValue(COMMENT as any);
    const res = await request(app).get('/api/v1/comments/c1');
    expect(res.status).toBe(200);
    expect(mocked.getById).toHaveBeenCalledWith('c1');
  });
});
