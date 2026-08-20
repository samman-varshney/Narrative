import request from 'supertest';
import app from '../../../app';
import { AppError } from '../../../core/exceptions/AppError';
import { tokensService } from '../../auth/tokens.service';
import { dashboardService } from '../dashboard.service';
import { DASHBOARD_SECTIONS, MAX_SECTION_LIMIT } from '../dashboard.config';

/**
 * Route-level tests with the service mocked, so what is under test is the HTTP
 * contract: auth wiring, query validation, the response envelope, and — the one
 * that matters most for this module — the fact that the dashboard's identity
 * can only ever come from the token.
 *
 * Composition lives in `dashboard.service.test.ts`; behaviour against real SQL
 * in `dashboard.db.test.ts`; the whole stack end to end in
 * `dashboard.e2e.test.ts`.
 */

jest.mock('../dashboard.service');

const mocked = dashboardService as jest.Mocked<typeof dashboardService>;

const ALICE = tokensService.generateAccessToken({ userId: 'alice', role: 'USER' });
const BOB = tokensService.generateAccessToken({ userId: 'bob', role: 'USER' });
const ADMIN = tokensService.generateAccessToken({ userId: 'admin', role: 'ADMIN' });

const RANGE = {
  preset: '30d',
  startDate: '2026-07-22',
  endDate: '2026-08-20',
  granularity: 'day',
};

beforeEach(() => {
  jest.clearAllMocks();

  mocked.getOverview.mockResolvedValue({
    overview: { range: RANGE, stats: null },
    range: RANGE,
    sections: [...DASHBOARD_SECTIONS],
    degradedSections: [],
  } as never);

  mocked.getStats.mockResolvedValue({ stats: { content: {} }, range: RANGE } as never);
  mocked.getCharts.mockResolvedValue({ range: RANGE, views: { points: [] } } as never);
  mocked.getTopContent.mockResolvedValue({
    range: RANGE,
    metric: 'views',
    items: [],
    nextCursor: null,
    hasNextPage: false,
  } as never);
  mocked.getDrafts.mockResolvedValue({
    items: [],
    nextCursor: null,
    hasNextPage: false,
    totalCount: 0,
  } as never);
  mocked.getActivity.mockResolvedValue({ items: [] } as never);
});

const ROUTES = [
  '/api/v1/dashboard/overview',
  '/api/v1/dashboard/stats',
  '/api/v1/dashboard/charts',
  '/api/v1/dashboard/top-content',
  '/api/v1/dashboard/drafts',
  '/api/v1/dashboard/activity',
];

describe('authentication', () => {
  it.each(ROUTES)('rejects %s without a token', async (route) => {
    const res = await request(app).get(route);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.each(ROUTES)('rejects %s with a malformed token', async (route) => {
    const res = await request(app).get(route).set('Authorization', 'Bearer nonsense');
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)('accepts %s with a valid token', async (route) => {
    const res = await request(app).get(route).set('Authorization', `Bearer ${ALICE}`);
    expect(res.status).toBe(200);
  });
});

describe('user isolation', () => {
  it('takes the user from the token, never from the query string', async () => {
    await request(app)
      .get('/api/v1/dashboard/overview?userId=bob&user=bob&authorId=bob')
      .set('Authorization', `Bearer ${ALICE}`);

    const [requester] = mocked.getOverview.mock.calls[0]!;
    expect(requester).toEqual({ userId: 'alice', role: 'USER' });
  });

  it('gives two users two different requesters', async () => {
    await request(app)
      .get('/api/v1/dashboard/stats')
      .set('Authorization', `Bearer ${ALICE}`);
    await request(app).get('/api/v1/dashboard/stats').set('Authorization', `Bearer ${BOB}`);

    expect(mocked.getStats.mock.calls[0]![0]).toEqual({ userId: 'alice', role: 'USER' });
    expect(mocked.getStats.mock.calls[1]![0]).toEqual({ userId: 'bob', role: 'USER' });
  });

  it('gives an admin their OWN dashboard, with no way to ask for another', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/overview?userId=alice')
      .set('Authorization', `Bearer ${ADMIN}`);

    expect(res.status).toBe(200);
    // Platform-wide insight is a different feature, not a parameter on this one.
    expect(mocked.getOverview.mock.calls[0]![0]).toEqual({
      userId: 'admin',
      role: 'ADMIN',
    });
  });
});

describe('validation', () => {
  it('rejects an unknown range preset', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/overview?range=5d')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each(['7d', '30d', '90d', 'all'])('accepts range=%s', async (range) => {
    const res = await request(app)
      .get(`/api/v1/dashboard/overview?range=${range}`)
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(200);
    expect(mocked.getOverview.mock.calls[0]![1]).toMatchObject({ range });
  });

  it('rejects an unknown section rather than silently dropping it', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/overview?sections=stats,notARealSection')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/notARealSection/);
  });

  it('parses a comma-separated section list', async () => {
    await request(app)
      .get('/api/v1/dashboard/overview?sections=stats,drafts')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(mocked.getOverview.mock.calls[0]![1].sections).toEqual(['stats', 'drafts']);
  });

  it('defaults to every section', async () => {
    await request(app)
      .get('/api/v1/dashboard/overview')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(mocked.getOverview.mock.calls[0]![1].sections).toEqual([
      ...DASHBOARD_SECTIONS,
    ]);
  });

  it('rejects an unknown chart series', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/charts?series=views,revenue')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(400);
  });

  it('rejects a limit above the cap', async () => {
    const res = await request(app)
      .get(`/api/v1/dashboard/drafts?limit=${MAX_SECTION_LIMIT + 1}`)
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric limit', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/activity?limit=lots')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(400);
  });

  it('coerces a numeric limit from the query string', async () => {
    await request(app)
      .get('/api/v1/dashboard/drafts?limit=5')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(mocked.getDrafts.mock.calls[0]![1]).toMatchObject({ limit: 5 });
  });

  it('rejects an unknown ranking metric', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/top-content?metric=vibes')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(400);
  });
});

describe('response envelope', () => {
  it('returns the overview in `data` and the range in `meta`', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/overview')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.body.success).toBe(true);
    expect(res.body.data.overview).toBeDefined();
    expect(res.body.meta.range).toEqual(RANGE);
    expect(res.body.meta.sections).toEqual([...DASHBOARD_SECTIONS]);
  });

  it('surfaces degraded sections in `meta`', async () => {
    mocked.getOverview.mockResolvedValue({
      overview: { range: RANGE, notifications: null },
      range: RANGE,
      sections: ['notifications'],
      degradedSections: ['notifications'],
    } as never);

    const res = await request(app)
      .get('/api/v1/dashboard/overview?sections=notifications')
      .set('Authorization', `Bearer ${ALICE}`);

    // Still a 200 — one subsystem being down is not a reason to show an error
    // page instead of the panels that loaded.
    expect(res.status).toBe(200);
    expect(res.body.meta.degradedSections).toEqual(['notifications']);
    expect(res.body.data.overview.notifications).toBeNull();
  });

  it('returns pagination for top content in `meta`', async () => {
    mocked.getTopContent.mockResolvedValue({
      range: RANGE,
      metric: 'views',
      items: [],
      nextCursor: 'CURSOR',
      hasNextPage: true,
    } as never);

    const res = await request(app)
      .get('/api/v1/dashboard/top-content')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.body.meta).toMatchObject({
      metric: 'views',
      nextCursor: 'CURSOR',
      hasNextPage: true,
    });
  });

  it('returns drafts pagination in `meta`', async () => {
    mocked.getDrafts.mockResolvedValue({
      items: [],
      nextCursor: 'C2',
      hasNextPage: true,
      totalCount: 12,
    } as never);

    const res = await request(app)
      .get('/api/v1/dashboard/drafts')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.body.data.items).toEqual([]);
    expect(res.body.meta).toMatchObject({
      nextCursor: 'C2',
      hasNextPage: true,
      totalCount: 12,
    });
  });
});

describe('error handling', () => {
  it('passes an AppError through with its status and code', async () => {
    mocked.getCharts.mockRejectedValue(
      new AppError('That range is too long', 400, 'RANGE_TOO_LARGE')
    );

    const res = await request(app)
      .get('/api/v1/dashboard/charts')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RANGE_TOO_LARGE');
  });

  it('turns an unexpected failure into a 500, not a hang', async () => {
    mocked.getOverview.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .get('/api/v1/dashboard/overview')
      .set('Authorization', `Bearer ${ALICE}`);

    expect(res.status).toBe(500);
  });
});

describe('write surface', () => {
  it.each(ROUTES)('does not expose a write verb on %s', async (route) => {
    // The module reads. Every mutation a user might launch from a dashboard
    // belongs to the module that owns it and already has an endpoint.
    const post = await request(app).post(route).set('Authorization', `Bearer ${ALICE}`);
    expect(post.status).toBe(404);
  });
});
