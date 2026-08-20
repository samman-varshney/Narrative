import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../core/database/prisma';
import { eventBus } from '../../../core/events/eventBus';
import { redis } from '../../../core/providers/redis';
import { passwordService } from '../../auth/password.service';
import {
  registerAuthSubscribers,
  resetAuthSubscriberRegistration,
} from '../../auth/subscribers';
import { tokensService } from '../../auth/tokens.service';
import { disconnectDb, makeBlog, makeUser, resetDb } from '../../../test/db';

/**
 * Self-service deactivation, end to end: real HTTP, real Postgres, real Redis,
 * real events.
 *
 * The properties worth this much machinery are the ones that live BETWEEN the
 * layers, and every one of them is a place where a cheaper test would pass
 * while the feature was broken:
 *
 *   deactivating has to take the account's whole catalogue out of public view
 *   without touching a blog row — the point of routing it through `status`,
 *
 *   the access token minted BEFORE the deactivation has to stop working, which
 *   is the status cache doing its job rather than the 15-minute token TTL,
 *
 *   logging back in has to restore all of it and hand back working tokens,
 *   with no restore step for the content — one UPDATE, and the catalogue is
 *   discoverable again,
 *
 *   and a suspended account must not be able to launder itself back to ACTIVE
 *   through a feature built for someone else.
 */

const PASSWORD = 'DeactivateMe123';

let user: { id: string; email: string };
let suspended: { id: string; email: string };
let token: string;
let suspendedToken: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** The caches these assertions read through. */
async function clearCaches(): Promise<void> {
  for (const pattern of ['feed:v1:*', 'search:v1:*', 'auth:status:v1:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

const statusOf = async (id: string) =>
  prisma.user.findUnique({ where: { id }, select: { status: true, deactivatedAt: true } });

const slugsIn = (res: request.Response): string[] =>
  (res.body.data.items as Array<{ slug: string }>).map((item) => item.slug);

beforeAll(async () => {
  await resetDb();
  await clearCaches();

  eventBus.clearHandlers();
  resetAuthSubscriberRegistration();
  registerAuthSubscribers();

  const passwordHash = await passwordService.hash(PASSWORD);

  user = await makeUser({ username: 'deact-user', name: 'Deactivating User' });
  suspended = await makeUser({ username: 'deact-suspended', name: 'Suspended User' });

  // `makeUser` writes a placeholder hash; login needs a real one.
  await prisma.user.updateMany({
    where: { id: { in: [user.id, suspended.id] } },
    data: { passwordHash },
  });
  await prisma.user.update({
    where: { id: suspended.id },
    data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendedReason: 'spam' },
  });

  token = tokensService.generateAccessToken({ userId: user.id, role: 'USER' });
  suspendedToken = tokensService.generateAccessToken({ userId: suspended.id, role: 'USER' });

  await makeBlog(user.id, { title: 'Still Mine', slug: 'still-mine' });
});

afterAll(async () => {
  eventBus.clearHandlers();
  await clearCaches();
  await resetDb();
  await disconnectDb();
});

beforeEach(async () => {
  await clearCaches();
});

describe('the deactivate → reactivate round trip', () => {
  it('1. the account is publicly visible to begin with', async () => {
    const res = await request(app).get('/api/v1/users/deact-user');

    expect(res.status).toBe(200);
    expect(res.body.data.profile.username).toBe('deact-user');
  });

  it('2. deactivating succeeds and stamps the row', async () => {
    const res = await request(app).post('/api/v1/users/me/deactivate').set(auth(token));

    expect(res.status).toBe(200);

    const row = await statusOf(user.id);
    expect(row?.status).toBe('DEACTIVATED');
    expect(row?.deactivatedAt).toBeInstanceOf(Date);
  });

  it('3. the public profile is gone', async () => {
    const res = await request(app).get('/api/v1/users/deact-user');
    expect(res.status).toBe(404);
  });

  it('4. every session is revoked, so no new access token can be minted', async () => {
    await eventBus.settled();

    const sessions = await prisma.session.count({ where: { userId: user.id } });
    expect(sessions).toBe(0);
  });

  it('5. the access token minted BEFORE the deactivation stops working', async () => {
    await eventBus.settled();

    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(auth(token))
      .send({ name: 'Sneaky Rename' });

    expect(res.status).toBe(403);
    // A distinct code from a suspension and from a deleted account: this is the
    // one status the client can offer a way out of.
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('6. their published post leaves the public feed', async () => {
    const res = await request(app).get('/api/v1/feed/latest');

    expect(res.status).toBe(200);
    expect(slugsIn(res)).not.toContain('still-mine');
  });

  it('7. ...without a single blog row having been touched', async () => {
    const blog = await prisma.blog.findUnique({ where: { slug: 'still-mine' } });

    // Still PUBLISHED, still PUBLIC, still not hidden. Invisible purely because
    // the discovery predicate joins on `u."status" = 'ACTIVE'` — which is what
    // makes reactivation one UPDATE rather than a catalogue-wide restore.
    expect(blog).not.toBeNull();
    expect(blog?.status).toBe('PUBLISHED');
    expect(blog?.visibility).toBe('PUBLIC');
    expect(blog?.isHidden).toBe(false);
  });

  it('8. a wrong password does NOT reactivate the account', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'WrongPassword123' });

    expect(res.status).toBe(401);
    expect((await statusOf(user.id))?.status).toBe('DEACTIVATED');
  });

  it('9. the correct password reactivates it and returns working tokens', async () => {
    // Warm the status cache to DEACTIVATED first, so the write below reads
    // through a populated key rather than an empty Redis.
    const stale = await request(app)
      .patch('/api/v1/users/me')
      .set(auth(token))
      .send({ name: 'Still Blocked' });
    expect(stale.status).toBe(403);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.reactivated).toBe(true);
    expect(res.body.data.user.status).toBe('ACTIVE');

    const row = await statusOf(user.id);
    expect(row?.status).toBe('ACTIVE');
    expect(row?.deactivatedAt).toBeNull();

    /**
     * The tokens login just issued must work on the very next request.
     *
     * Note what this does NOT prove. Under NODE_ENV=test the bus dispatches
     * INLINE, so the USER_REACTIVATED subscriber has already repaired the cache
     * by the time this runs — deleting the synchronous prime in `login` leaves
     * this assertion green. In production `emit` enqueues and the subscriber
     * runs whenever the worker gets to it, which is the window the prime exists
     * to close. The test that actually holds that line is the mocked
     * `primes the account status cache synchronously` case in
     * auth.service.test.ts; this one covers the round trip, not the race.
     */
    const fresh = res.body.data.accessToken;
    const write = await request(app)
      .patch('/api/v1/users/me')
      .set(auth(fresh))
      .send({ name: 'Back Again' });

    expect(write.status).toBe(200);
  });

  it('10. the public profile is back', async () => {
    const res = await request(app).get('/api/v1/users/deact-user');

    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe('Back Again');
  });

  it('11. ...and so is the whole catalogue, with no restore step', async () => {
    const res = await request(app).get('/api/v1/feed/latest');

    expect(res.status).toBe(200);
    expect(slugsIn(res)).toContain('still-mine');
  });
});

describe('deactivation is not an escape hatch from moderation', () => {
  it('a suspended account cannot deactivate itself', async () => {
    const res = await request(app)
      .post('/api/v1/users/me/deactivate')
      .set(auth(suspendedToken));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await statusOf(suspended.id))?.status).toBe('SUSPENDED');
  });

  it('and logging in still refuses it rather than reactivating anything', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: suspended.email, password: PASSWORD });

    expect(res.status).toBe(403);
    expect((await statusOf(suspended.id))?.status).toBe('SUSPENDED');
  });
});
