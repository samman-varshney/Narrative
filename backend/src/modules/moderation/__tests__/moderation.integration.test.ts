import request from 'supertest';
import app from '../../../app';
import { allowActiveAccounts } from '../../../test/auth';
import { tokensService } from '../../auth/tokens.service';
import { moderationService } from '../moderation.service';
import { reportService } from '../report.service';

jest.mock('../moderation.service');
jest.mock('../report.service');

/**
 * The HTTP contract, with the services mocked.
 *
 * What is under test is the wiring: which routes exist, who is allowed through
 * them, what shape goes in, and — the one that matters most on an
 * administrative surface — where the ACTOR comes from. Behaviour lives in the
 * service suites; SQL in `moderation.db.test.ts`; the whole stack in
 * `moderation.e2e.test.ts`.
 *
 * The permission matrix is asserted route by route rather than sampled. An
 * admin API is precisely the place where "we tested a couple of them" is how a
 * missing middleware ships.
 */

const mockedModeration = moderationService as jest.Mocked<typeof moderationService>;
const mockedReports = reportService as jest.Mocked<typeof reportService>;

const token = (userId: string, role: string) =>
  `Bearer ${tokensService.generateAccessToken({ userId, role })}`;

const USER = token('user-1', 'USER');
const MODERATOR = token('mod-1', 'MODERATOR');
const ADMIN = token('admin-1', 'ADMIN');

beforeEach(() => {
  jest.clearAllMocks();
  allowActiveAccounts();

  mockedReports.createReport.mockResolvedValue({ id: 'report-1' } as never);
  mockedReports.listReports.mockResolvedValue({
    items: [],
    nextCursor: null,
    hasNextPage: false,
  } as never);
  mockedReports.getReport.mockResolvedValue({ id: 'report-1' } as never);
  mockedReports.claimReport.mockResolvedValue({ id: 'report-1' } as never);
  mockedReports.resolveReport.mockResolvedValue({ id: 'report-1' } as never);
  mockedReports.dismissReport.mockResolvedValue({ id: 'report-1' } as never);

  mockedModeration.getOverview.mockResolvedValue({ queue: {} } as never);
  mockedModeration.getHistory.mockResolvedValue({
    items: [],
    nextCursor: null,
    hasNextPage: false,
  } as never);
  mockedModeration.getUserModeration.mockResolvedValue({ user: {} } as never);
  mockedModeration.getContentModeration.mockResolvedValue({ target: {} } as never);
  mockedModeration.hideBlog.mockResolvedValue({ id: 'blog-1' } as never);
  mockedModeration.restoreBlog.mockResolvedValue({ id: 'blog-1' } as never);
  mockedModeration.deleteBlog.mockResolvedValue({ id: 'blog-1' } as never);
  mockedModeration.hideComment.mockResolvedValue({ id: 'comment-1' } as never);
  mockedModeration.restoreComment.mockResolvedValue({ id: 'comment-1' } as never);
  mockedModeration.deleteComment.mockResolvedValue({ id: 'comment-1' } as never);
  mockedModeration.suspendUser.mockResolvedValue({ id: 'target-1' } as never);
  mockedModeration.unsuspendUser.mockResolvedValue({ id: 'target-1' } as never);
});

// method, path, allowed-for-moderator?
const ADMIN_ROUTES: [string, string, boolean][] = [
  ['get', '/api/v1/admin/moderation/overview', true],
  ['get', '/api/v1/admin/moderation/reports', true],
  ['get', '/api/v1/admin/moderation/reports/report-1', true],
  ['get', '/api/v1/admin/moderation/history', true],
  ['get', '/api/v1/admin/moderation/users/target-1', true],
  ['get', '/api/v1/admin/moderation/content/BLOG/blog-1', true],
  ['post', '/api/v1/admin/moderation/reports/report-1/claim', true],
  ['post', '/api/v1/admin/moderation/reports/report-1/resolve', true],
  ['post', '/api/v1/admin/moderation/reports/report-1/dismiss', true],
  ['post', '/api/v1/admin/moderation/blogs/blog-1/hide', true],
  ['post', '/api/v1/admin/moderation/blogs/blog-1/restore', true],
  ['post', '/api/v1/admin/moderation/comments/comment-1/hide', true],
  ['post', '/api/v1/admin/moderation/comments/comment-1/restore', true],
  ['post', '/api/v1/admin/moderation/users/target-1/suspend', true],
  ['post', '/api/v1/admin/moderation/users/target-1/unsuspend', true],
  // Administrator-only: irreversible removal.
  ['post', '/api/v1/admin/moderation/blogs/blog-1/remove', false],
  ['post', '/api/v1/admin/moderation/comments/comment-1/remove', false],
];

const call = (method: string, path: string, auth?: string) => {
  const req = (request(app) as any)[method](path);
  return auth ? req.set('Authorization', auth) : req;
};

describe('anonymous access', () => {
  it.each(ADMIN_ROUTES)('%s %s is rejected without a token', async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('cannot file a report either', async () => {
    const res = await request(app).post('/api/v1/reports').send({});
    expect(res.status).toBe(401);
  });
});

describe('a regular user', () => {
  it.each(ADMIN_ROUTES)('%s %s is forbidden', async (method, path) => {
    const res = await call(method, path, USER);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('reaches no service at all when refused', async () => {
    await call('post', '/api/v1/admin/moderation/users/target-1/suspend', USER);
    expect(mockedModeration.suspendUser).not.toHaveBeenCalled();
  });

  it('CAN see their own (empty) permission set', async () => {
    const res = await request(app).get('/api/v1/admin/me').set('Authorization', USER);

    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual([]);
    expect(res.body.data.role).toBe('USER');
  });
});

describe('a moderator', () => {
  const allowed = ADMIN_ROUTES.filter(([, , modAllowed]) => modAllowed);
  const forbidden = ADMIN_ROUTES.filter(([, , modAllowed]) => !modAllowed);

  it.each(allowed)('%s %s is allowed', async (method, path) => {
    const res = await call(method, path, MODERATOR);
    expect(res.status).toBeLessThan(400);
  });

  it.each(forbidden)('%s %s is forbidden (administrator only)', async (method, path) => {
    const res = await call(method, path, MODERATOR);
    expect(res.status).toBe(403);
  });

  it('is listed the permissions it actually holds', async () => {
    const res = await request(app).get('/api/v1/admin/me').set('Authorization', MODERATOR);

    expect(res.body.data.permissions).toEqual(expect.arrayContaining(['content:hide']));
    expect(res.body.data.permissions).not.toContain('content:delete');
  });
});

describe('an administrator', () => {
  it.each(ADMIN_ROUTES)('%s %s is allowed', async (method, path) => {
    const res = await call(method, path, ADMIN);
    expect(res.status).toBeLessThan(400);
  });
});

describe('actor identity', () => {
  it('takes the actor from the token, never from the body', async () => {
    await request(app)
      .post('/api/v1/admin/moderation/blogs/blog-1/hide')
      .set('Authorization', MODERATOR)
      .send({ reason: 'spam', actorId: 'someone-else', userId: 'someone-else' });

    expect(mockedModeration.hideBlog).toHaveBeenCalledWith(
      { userId: 'mod-1', role: 'MODERATOR' },
      'blog-1',
      // The spoofed fields are stripped by the schema and never reach the service.
      { reason: 'spam' }
    );
  });

  it('takes the reporter from the token too', async () => {
    await request(app)
      .post('/api/v1/reports')
      .set('Authorization', USER)
      .send({
        targetType: 'BLOG',
        targetId: 'blog-1',
        reason: 'SPAM',
        reporterId: 'somebody-else',
      });

    expect(mockedReports.createReport).toHaveBeenCalledWith('user-1', {
      targetType: 'BLOG',
      targetId: 'blog-1',
      reason: 'SPAM',
    });
  });

  it('ignores a role claimed in the body', async () => {
    const res = await request(app)
      .post('/api/v1/admin/moderation/blogs/blog-1/remove')
      .set('Authorization', MODERATOR)
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(403);
  });
});

describe('validation', () => {
  it('rejects an unknown report reason', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', USER)
      .send({ targetType: 'BLOG', targetId: 'blog-1', reason: 'I_JUST_DISAGREE' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unsupported target type', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', USER)
      .send({ targetType: 'BOOKMARK', targetId: 'x1', reason: 'SPAM' });

    expect(res.status).toBe(400);
  });

  it.each([
    ['an empty id', ''],
    ['a path traversal', '../../etc/passwd'],
    ['a SQL fragment', "1' OR '1'='1"],
    ['an absurdly long id', 'a'.repeat(500)],
  ])('rejects %s as a target', async (_label, targetId) => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', USER)
      .send({ targetType: 'BLOG', targetId, reason: 'SPAM' });

    expect(res.status).toBe(400);
    expect(mockedReports.createReport).not.toHaveBeenCalled();
  });

  it('bounds the queue page size', async () => {
    const res = await request(app)
      .get('/api/v1/admin/moderation/reports?limit=5000')
      .set('Authorization', MODERATOR);

    expect(res.status).toBe(400);
  });

  it('rejects an unknown status filter rather than silently ignoring it', async () => {
    const res = await request(app)
      .get('/api/v1/admin/moderation/reports?status=PENDING,NONSENSE')
      .set('Authorization', MODERATOR);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('NONSENSE');
  });

  it('rejects a backwards date range', async () => {
    const res = await request(app)
      .get('/api/v1/admin/moderation/reports?from=2026-08-20&to=2026-08-01')
      .set('Authorization', MODERATOR);

    expect(res.status).toBe(400);
  });

  it('parses filters into the service call', async () => {
    await request(app)
      .get(
        '/api/v1/admin/moderation/reports?status=RESOLVED&targetType=COMMENT&reason=HARASSMENT&sort=newest&limit=10'
      )
      .set('Authorization', MODERATOR);

    expect(mockedReports.listReports).toHaveBeenCalledWith(
      { userId: 'mod-1', role: 'MODERATOR' },
      expect.objectContaining({
        status: ['RESOLVED'],
        targetType: 'COMMENT',
        reason: 'HARASSMENT',
        sort: 'desc',
        limit: 10,
      })
    );
  });
});

describe('response envelope', () => {
  it('wraps a filed report in the standard success shape', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', USER)
      .send({ targetType: 'BLOG', targetId: 'blog-1', reason: 'SPAM' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      data: { report: { id: 'report-1' } },
      meta: { message: expect.any(String) },
    });
  });

  it('returns pagination state in meta, not in the payload', async () => {
    mockedReports.listReports.mockResolvedValue({
      items: [],
      nextCursor: 'next',
      hasNextPage: true,
    } as never);

    const res = await request(app)
      .get('/api/v1/admin/moderation/reports')
      .set('Authorization', MODERATOR);

    expect(res.body.data.reports).toEqual([]);
    expect(res.body.meta).toMatchObject({ nextCursor: 'next', hasNextPage: true });
  });
});

describe('error propagation', () => {
  it('surfaces a service conflict as its own status', async () => {
    const conflict = Object.assign(new Error('This report is already being reviewed'), {
      statusCode: 409,
      errorCode: 'REPORT_NOT_PENDING',
      isOperational: true,
    });
    Object.setPrototypeOf(conflict, require('../../../core/exceptions/AppError').AppError.prototype);
    mockedReports.claimReport.mockRejectedValue(conflict);

    const res = await request(app)
      .post('/api/v1/admin/moderation/reports/report-1/claim')
      .set('Authorization', MODERATOR);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPORT_NOT_PENDING');
  });
});
