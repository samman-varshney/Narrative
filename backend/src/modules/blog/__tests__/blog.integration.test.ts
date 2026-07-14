import request from 'supertest';
import app from '../../../app';
import { blogService } from '../blog.service';
import { tokensService } from '../../auth/tokens.service';
import { AppError } from '../../../core/exceptions/AppError';

// Integration tests mock the service layer to exercise Routes, Validators,
// requireAuth/optionalAuth, requireRole, the response envelope, and — critically
// — route ordering (literal segments vs /:slug).
jest.mock('../blog.service');

const token = tokensService.generateAccessToken({ userId: 'user-1', role: 'USER' });
const adminToken = tokensService.generateAccessToken({ userId: 'admin-1', role: 'ADMIN' });
const authHeader = `Bearer ${token}`;
const adminHeader = `Bearer ${adminToken}`;

const mocked = blogService as jest.Mocked<typeof blogService>;

const BLOG = { id: 'blog-1', slug: 'hello-world', title: 'Hello World', status: 'DRAFT' };
const PAGE = { items: [BLOG], nextCursor: null, hasNextPage: false, totalCount: 1 };

beforeEach(() => jest.clearAllMocks());

describe('POST /api/v1/blogs', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/v1/blogs').send({ title: 'x' });
    expect(res.status).toBe(401);
    expect(mocked.createDraft).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_ERROR when the title is missing', async () => {
    const res = await request(app).post('/api/v1/blogs').set('Authorization', authHeader).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mocked.createDraft).not.toHaveBeenCalled();
  });

  it('creates a draft as the authenticated user (201)', async () => {
    mocked.createDraft.mockResolvedValue(BLOG as any);
    const res = await request(app)
      .post('/api/v1/blogs')
      .set('Authorization', authHeader)
      .send({ title: 'Hello World' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.blog.slug).toBe('hello-world');
    expect(mocked.createDraft).toHaveBeenCalledWith('user-1', expect.objectContaining({ title: 'Hello World' }));
  });
});

describe('GET /api/v1/blogs/:slug (public)', () => {
  it('is reachable anonymously and passes an undefined viewer', async () => {
    mocked.getBySlug.mockResolvedValue(BLOG as any);
    const res = await request(app).get('/api/v1/blogs/hello-world');
    expect(res.status).toBe(200);
    expect(res.body.data.blog.slug).toBe('hello-world');
    expect(mocked.getBySlug).toHaveBeenCalledWith('hello-world', undefined);
  });

  it('passes a viewer context when authenticated', async () => {
    mocked.getBySlug.mockResolvedValue(BLOG as any);
    await request(app).get('/api/v1/blogs/hello-world').set('Authorization', authHeader);
    expect(mocked.getBySlug).toHaveBeenCalledWith('hello-world', { userId: 'user-1', role: 'USER' });
  });

  it('surfaces a hidden blog as 404 BLOG_NOT_FOUND', async () => {
    mocked.getBySlug.mockRejectedValue(new AppError('Blog not found', 404, 'BLOG_NOT_FOUND'));
    const res = await request(app).get('/api/v1/blogs/secret');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BLOG_NOT_FOUND');
  });
});

describe('route ordering (literal segments must beat /:slug)', () => {
  it('GET /blogs/me routes to myBlogs, not getBySlug', async () => {
    mocked.getMyBlogs.mockResolvedValue(PAGE as any);
    const res = await request(app).get('/api/v1/blogs/me').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(mocked.getMyBlogs).toHaveBeenCalled();
    expect(mocked.getBySlug).not.toHaveBeenCalled();
  });

  it('GET /blogs/me/drafts routes to myDrafts', async () => {
    mocked.getMyDrafts.mockResolvedValue(PAGE as any);
    const res = await request(app).get('/api/v1/blogs/me/drafts').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(mocked.getMyDrafts).toHaveBeenCalled();
  });

  it('GET /blogs/author/:username routes to byAuthor (public)', async () => {
    mocked.getByAuthor.mockResolvedValue(PAGE as any);
    const res = await request(app).get('/api/v1/blogs/author/alice');
    expect(res.status).toBe(200);
    expect(mocked.getByAuthor).toHaveBeenCalledWith('alice', expect.any(Object));
    expect(mocked.getBySlug).not.toHaveBeenCalled();
  });

  it('GET /blogs/categories routes to listCategories, not getBySlug', async () => {
    mocked.listCategories.mockResolvedValue([] as any);
    const res = await request(app).get('/api/v1/blogs/categories');
    expect(res.status).toBe(200);
    expect(mocked.getBySlug).not.toHaveBeenCalled();
  });
});

describe('lifecycle actions', () => {
  it('POST /:id/publish requires auth', async () => {
    const res = await request(app).post('/api/v1/blogs/blog-1/publish');
    expect(res.status).toBe(401);
  });

  it('POST /:id/publish invokes the service', async () => {
    mocked.publish.mockResolvedValue({ ...BLOG, status: 'PUBLISHED' } as any);
    const res = await request(app).post('/api/v1/blogs/blog-1/publish').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(mocked.publish).toHaveBeenCalledWith('blog-1', 'user-1', 'USER');
  });

  it('surfaces an invalid transition as 409 INVALID_TRANSITION', async () => {
    mocked.archive.mockRejectedValue(
      new AppError('Cannot archive a blog in ARCHIVED state', 409, 'INVALID_TRANSITION')
    );
    const res = await request(app).post('/api/v1/blogs/blog-1/archive').set('Authorization', authHeader);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('DELETE /:id soft-deletes and returns 200', async () => {
    mocked.softDelete.mockResolvedValue(undefined as any);
    const res = await request(app).delete('/api/v1/blogs/blog-1').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(mocked.softDelete).toHaveBeenCalledWith('blog-1', 'user-1', 'USER');
  });
});

describe('cover upload (multipart through mocked MediaService)', () => {
  it('PATCH /:id/cover accepts a file and invokes updateCover', async () => {
    mocked.updateCover.mockResolvedValue(BLOG as any);
    const res = await request(app)
      .patch('/api/v1/blogs/blog-1/cover')
      .set('Authorization', authHeader)
      .attach('file', Buffer.from('fake-image-bytes'), 'cover.png');

    expect(res.status).toBe(200);
    expect(mocked.updateCover).toHaveBeenCalledWith('blog-1', 'user-1', 'USER', expect.anything());
  });

  it('returns 400 NO_FILE when no file is attached', async () => {
    const res = await request(app).patch('/api/v1/blogs/blog-1/cover').set('Authorization', authHeader);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILE');
  });
});

describe('category management (admin-gated)', () => {
  it('POST /blogs/categories is forbidden for non-admins (403)', async () => {
    const res = await request(app)
      .post('/api/v1/blogs/categories')
      .set('Authorization', authHeader)
      .send({ name: 'Engineering' });
    expect(res.status).toBe(403);
    expect(mocked.createCategory).not.toHaveBeenCalled();
  });

  it('POST /blogs/categories succeeds for an admin (201)', async () => {
    mocked.createCategory.mockResolvedValue({ id: 'c1', name: 'Engineering', slug: 'engineering' } as any);
    const res = await request(app)
      .post('/api/v1/blogs/categories')
      .set('Authorization', adminHeader)
      .send({ name: 'Engineering' });
    expect(res.status).toBe(201);
    expect(mocked.createCategory).toHaveBeenCalledWith('Engineering');
  });
});
