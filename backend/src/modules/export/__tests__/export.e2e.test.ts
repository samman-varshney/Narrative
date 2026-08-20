import { gunzipSync } from 'zlib';
import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../core/database/prisma';
import { eventBus } from '../../../core/events/eventBus';
import { exportQueue } from '../../../core/providers/queue';
import { tokensService } from '../../auth/tokens.service';
import { exportService } from '../export.service';
import { EXPORT_COOLDOWN_HOURS } from '../export.config';
import {
  disconnectDb,
  makeBlog,
  makeComment,
  makeUser,
  resetDb,
} from '../../../test/db';

/**
 * The export, end to end: real HTTP, real Postgres, the real builder composing
 * real sibling services, and a real gzip artifact that is unzipped and read
 * back.
 *
 * The queue is the one thing stubbed. `exportService.process` is invoked
 * directly instead, because a live BullMQ worker would make every assertion race
 * a background poll — and what is worth testing here is the BUILD, not BullMQ's
 * delivery. The worker's own job is two lines of dispatch.
 *
 * What this covers that the unit tests cannot:
 *
 *   the document actually contains this user's blogs and comments and NOT
 *   another user's — the composition is real, so a collector wired to the wrong
 *   id shows up here and nowhere else,
 *
 *   the artifact round-trips: gzip in the column, gunzip out of the endpoint,
 *   parses as JSON,
 *
 *   the credential exclusions hold on a real record rather than a fixture,
 *
 *   and the download endpoint enforces ownership against a real second account.
 */

jest.mock('../../../core/providers/queue', () => {
  const actual = jest.requireActual('../../../core/providers/queue');
  return { ...actual, exportQueue: { ...actual.exportQueue, add: jest.fn() } };
});

let owner: { id: string; email: string; username: string };
let stranger: { id: string };
let ownerToken: string;
let strangerToken: string;
let exportId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await resetDb();
  eventBus.clearHandlers();

  owner = await makeUser({ username: 'export-owner', name: 'Export Owner' });
  stranger = await makeUser({ username: 'export-stranger', name: 'Stranger' });

  ownerToken = tokensService.generateAccessToken({ userId: owner.id, role: 'USER' });
  strangerToken = tokensService.generateAccessToken({ userId: stranger.id, role: 'USER' });

  const blog = await makeBlog(owner.id, { title: 'Mine To Export', slug: 'mine-to-export' });
  await makeComment(blog.id, owner.id, { content: 'my own comment' });

  // A second account's content, to prove the builder scopes by user.
  const otherBlog = await makeBlog(stranger.id, {
    title: 'Not Yours',
    slug: 'not-yours',
  });
  await makeComment(otherBlog.id, stranger.id, { content: 'someone else' });

  (exportQueue.add as jest.Mock).mockResolvedValue({ id: 'job-1' });
});

afterAll(async () => {
  eventBus.clearHandlers();
  await resetDb();
  await disconnectDb();
});

describe('requesting an export', () => {
  it('accepts with 202 and a PENDING request', async () => {
    const res = await request(app).post('/api/v1/export').set(auth(ownerToken));

    expect(res.status).toBe(202);
    expect(res.body.data.request.status).toBe('PENDING');
    expect(res.body.data.request.downloadable).toBe(false);
    exportId = res.body.data.request.id;

    expect(exportQueue.add).toHaveBeenCalledWith('build-export', {
      exportId,
      userId: owner.id,
    });
  });

  it('refuses a second request while the first is still in flight', async () => {
    const res = await request(app).post('/api/v1/export').set(auth(ownerToken));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXPORT_IN_PROGRESS');
  });

  it('is not downloadable before the build runs', async () => {
    const res = await request(app)
      .get(`/api/v1/export/${exportId}/download`)
      .set(auth(ownerToken));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXPORT_NOT_READY');
  });
});

describe('building the artifact', () => {
  it('builds and stores it', async () => {
    await exportService.process(exportId, owner.id);

    const row = await prisma.exportRequest.findUnique({
      where: { id: exportId },
      select: { status: true, sizeBytes: true, checksum: true, expiresAt: true },
    });

    expect(row?.status).toBe('READY');
    expect(row?.sizeBytes).toBeGreaterThan(0);
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.expiresAt).toBeInstanceOf(Date);
  });
});

describe('downloading it', () => {
  let document: any;

  it('serves it to the owner with the right headers', async () => {
    const res = await request(app)
      .get(`/api/v1/export/${exportId}/download`)
      .set(auth(ownerToken))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-disposition']).toContain('.json.gz');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-checksum-sha256']).toMatch(/^[0-9a-f]{64}$/);

    // superagent honours Content-Encoding and decompresses on the way in, so
    // this body is already plain JSON. That the bytes on the wire really were
    // gzip is asserted against the stored column below, which is the stronger
    // claim anyway.
    document = JSON.parse((res.body as Buffer).toString('utf8'));
  });

  it('stores the artifact gzipped, not as raw JSON', async () => {
    const row = await prisma.exportRequest.findUnique({
      where: { id: exportId },
      select: { artifact: true },
    });

    const stored = Buffer.from(row!.artifact!);
    // gzip magic number — the column holds compressed bytes, not a JSON string.
    expect(stored[0]).toBe(0x1f);
    expect(stored[1]).toBe(0x8b);
    expect(JSON.parse(gunzipSync(stored).toString('utf8'))).toEqual(document);
  });

  it('contains this user’s content and not anyone else’s', () => {
    expect(document.blogs.map((b: any) => b.slug)).toEqual(['mine-to-export']);
    expect(document.comments.map((c: any) => c.content)).toEqual(['my own comment']);
    expect(JSON.stringify(document)).not.toContain('not-yours');
    expect(JSON.stringify(document)).not.toContain('someone else');
  });

  /**
   * The exclusion that matters most. An export lands in email and cloud storage;
   * a working credential must never travel with it.
   */
  it('carries no credentials anywhere in the document', () => {
    const serialized = JSON.stringify(document);

    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('refreshTokenHash');
    expect(document.account.passwordHash).toBeUndefined();
  });

  it('declares its format version and its exclusions', () => {
    expect(document.meta.formatVersion).toBe(1);
    expect(document.meta.userId).toBe(owner.id);
    expect(document.meta.truncated).toEqual([]);
    expect(document.meta.excluded.join(' ')).toContain('Password hash');
  });

  it('includes every section, even the empty ones', () => {
    // An absent key and an empty section are different messages to a reader.
    for (const key of [
      'account',
      'blogs',
      'comments',
      'bookmarks',
      'follows',
      'notifications',
      'media',
      'analytics',
      'sessions',
    ]) {
      expect(document).toHaveProperty(key);
    }
  });

  it('refuses a stranger, as a 404 rather than a 403', async () => {
    const res = await request(app)
      .get(`/api/v1/export/${exportId}/download`)
      .set(auth(strangerToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EXPORT_NOT_FOUND');
  });

  it('counts the owner’s downloads', async () => {
    const row = await prisma.exportRequest.findUnique({
      where: { id: exportId },
      select: { downloadCount: true },
    });
    expect(row?.downloadCount).toBeGreaterThanOrEqual(1);
  });
});

describe('the cooldown', () => {
  it('blocks another request now that one has completed', async () => {
    const res = await request(app).post('/api/v1/export').set(auth(ownerToken));

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('EXPORT_COOLDOWN');
  });

  it('allows one once the window has passed', async () => {
    await prisma.exportRequest.update({
      where: { id: exportId },
      data: {
        requestedAt: new Date(Date.now() - (EXPORT_COOLDOWN_HOURS + 1) * 60 * 60 * 1000),
      },
    });

    const res = await request(app).post('/api/v1/export').set(auth(ownerToken));
    expect(res.status).toBe(202);

    // Clean up the second request so the expiry test below has one READY row.
    await prisma.exportRequest.delete({ where: { id: res.body.data.request.id } });
  });
});

describe('expiry', () => {
  it('refuses a lapsed artifact before the sweep has run', async () => {
    await prisma.exportRequest.update({
      where: { id: exportId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .get(`/api/v1/export/${exportId}/download`)
      .set(auth(ownerToken));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXPORT_EXPIRED');
  });

  it('the sweep drops the bytes but keeps the row', async () => {
    const dropped = await exportService.sweepExpired();
    expect(dropped).toBeGreaterThanOrEqual(1);

    const row = await prisma.exportRequest.findUnique({
      where: { id: exportId },
      select: { status: true, artifact: true, sizeBytes: true },
    });

    expect(row?.status).toBe('EXPIRED');
    expect(row?.artifact).toBeNull();
    // Retained after the bytes go, so an expired request can still say how big
    // it was.
    expect(row?.sizeBytes).toBeGreaterThan(0);
  });
});
