import request from 'supertest';
import app from '../../../app';
import { prisma } from '../../../core/database/prisma';
import { eventBus } from '../../../core/events/eventBus';
import { redis } from '../../../core/providers/redis';
import { accountStatusService } from '../../auth/accountStatus.service';
import { registerAuthSubscribers, resetAuthSubscriberRegistration } from '../../auth/subscribers';
import { tokensService } from '../../auth/tokens.service';
import {
  registerNotificationSubscribers,
  resetSubscriberRegistration,
} from '../../notification/subscribers';
import { disconnectDb, makeBlog, makeComment, makeUser, resetDb } from '../../../test/db';

/**
 * The whole moderation stack, end to end: real HTTP, real services, real
 * Postgres, real Redis, real events.
 *
 * The other suites each hold one variable still. This one holds none, because
 * the properties that matter most here live BETWEEN the layers:
 *
 *   a hide in the admin API has to make the blog 404 on its public URL,
 *   a suspension has to stop a token that was minted before it,
 *   an action has to leave an audit row AND a notification for its subject,
 *   and none of it may be reachable by someone without the permission.
 *
 * Subscribers are registered explicitly. In production `server.ts` does it; here
 * it is what makes the notification and session-revocation halves of the flow
 * observable, and `eventBus.settled()` is what makes them observable WITHOUT a
 * sleep (in tests the bus dispatches inline — see eventBus.ts).
 */

let author: { id: string };
let reporter: { id: string };
let moderator: { id: string };
let admin: { id: string };

let authorToken: string;
let reporterToken: string;
let moderatorToken: string;
let adminToken: string;

let blog: { id: string; slug: string };
let comment: { id: string };

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Feed and search cache the pages these assertions read; both are cleared. */
async function clearDiscoveryCaches(): Promise<void> {
  for (const pattern of ['feed:v1:*', 'search:v1:*', 'moderation:v1:*', 'auth:status:v1:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

beforeAll(async () => {
  await resetDb();
  await clearDiscoveryCaches();

  eventBus.clearHandlers();
  resetSubscriberRegistration();
  resetAuthSubscriberRegistration();
  registerNotificationSubscribers();
  registerAuthSubscribers();

  author = await makeUser({ username: 'e2e-author', name: 'Author' });
  reporter = await makeUser({ username: 'e2e-reporter', name: 'Reporter' });
  moderator = await makeUser({ username: 'e2e-mod', name: 'Mod', role: 'MODERATOR' });
  admin = await makeUser({ username: 'e2e-admin', name: 'Admin', role: 'ADMIN' });

  authorToken = tokensService.generateAccessToken({ userId: author.id, role: 'USER' });
  reporterToken = tokensService.generateAccessToken({ userId: reporter.id, role: 'USER' });
  moderatorToken = tokensService.generateAccessToken({ userId: moderator.id, role: 'MODERATOR' });
  adminToken = tokensService.generateAccessToken({ userId: admin.id, role: 'ADMIN' });

  blog = await makeBlog(author.id, { title: 'A Published Post', slug: 'a-published-post' });
  comment = await makeComment(blog.id, reporter.id, { content: 'a comment' });
});

afterAll(async () => {
  eventBus.clearHandlers();
  await clearDiscoveryCaches();
  await resetDb();
  await disconnectDb();
});

beforeEach(async () => {
  // The account-status cache is primed by the auth subscriber on suspension.
  // Cleared between tests so each one reads PostgreSQL rather than a decision
  // made by an earlier test.
  await clearDiscoveryCaches();
});

// ---------------------------------------------------------------------------
// The complete report → review → action → restore workflow
// ---------------------------------------------------------------------------

describe('the full moderation workflow', () => {
  let reportId: string;

  it('1. a reader files a report', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set(auth(reporterToken))
      .send({
        targetType: 'BLOG',
        targetId: blog.id,
        reason: 'SPAM',
        description: 'Nothing but affiliate links',
      });

    expect(res.status).toBe(201);
    reportId = res.body.data.report.id;

    const stored = await prisma.report.findUnique({ where: { id: reportId } });
    expect(stored).toMatchObject({
      status: 'PENDING',
      source: 'USER',
      reporterId: reporter.id,
      // Denormalized at filing time, so the queue never joins per row.
      targetOwnerId: author.id,
    });
  });

  it('2. filing it again while it is open is refused', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set(auth(reporterToken))
      .send({ targetType: 'BLOG', targetId: blog.id, reason: 'HARASSMENT' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_REPORT');
  });

  it('3. the report changed nothing — the blog is still public', async () => {
    const res = await request(app).get(`/api/v1/blogs/${blog.slug}`);
    expect(res.status).toBe(200);
  });

  it('4. it appears in the moderator queue, hydrated', async () => {
    const res = await request(app)
      .get('/api/v1/admin/moderation/reports')
      .set(auth(moderatorToken));

    expect(res.status).toBe(200);
    const found = res.body.data.reports.find((r: any) => r.id === reportId);
    expect(found).toMatchObject({
      status: 'PENDING',
      reason: 'SPAM',
      reporter: { username: 'e2e-reporter' },
      targetOwner: { username: 'e2e-author' },
    });
  });

  it('5. the report detail carries the live target and its history', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/moderation/reports/${reportId}`)
      .set(auth(moderatorToken));

    expect(res.status).toBe(200);
    expect(res.body.data.report.target).toMatchObject({
      kind: 'BLOG',
      id: blog.id,
      title: 'A Published Post',
      isHidden: false,
      author: { username: 'e2e-author' },
    });
    expect(res.body.data.report.history).toEqual([]);
  });

  it('6. a moderator claims it, and the claim is audited', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/reports/${reportId}/claim`)
      .set(auth(moderatorToken));

    expect(res.status).toBe(200);
    expect(res.body.data.report).toMatchObject({
      status: 'REVIEWING',
      assignedTo: { username: 'e2e-mod' },
    });

    const audit = await prisma.moderationAction.findFirst({
      where: { reportId, action: 'REPORT_CLAIMED' },
    });
    expect(audit?.actorId).toBe(moderator.id);
  });

  it('7. a second moderator cannot claim the same report', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/reports/${reportId}/claim`)
      .set(auth(adminToken));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPORT_NOT_PENDING');
  });

  it('8. hiding the blog from the report resolves it and notifies the author', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${blog.id}/hide`)
      .set(auth(moderatorToken))
      .send({ reason: 'Affiliate spam', reportId });

    expect(res.status).toBe(200);
    await eventBus.settled();

    const stored = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(stored?.isHidden).toBe(true);
    expect(stored?.hiddenAt).toBeInstanceOf(Date);

    const report = await prisma.report.findUnique({ where: { id: reportId } });
    expect(report).toMatchObject({ status: 'RESOLVED', resolvedById: moderator.id });

    const actions = await prisma.moderationAction.findMany({ where: { reportId } });
    expect(actions.map((a) => a.action).sort()).toEqual([
      'CONTENT_HIDDEN',
      'REPORT_CLAIMED',
      'REPORT_RESOLVED',
    ]);

    const notification = await prisma.notification.findFirst({
      where: { recipientId: author.id, type: 'SYSTEM' },
    });
    expect(notification).not.toBeNull();
    expect((notification!.metadata as any).moderationAction).toBe('HIDDEN');
    // The moderator is NOT named to the author — only in the audit log.
    expect(notification!.actorId).toBeNull();
  });

  it('9. the hidden blog is gone from its public URL', async () => {
    const anonymous = await request(app).get(`/api/v1/blogs/${blog.slug}`);
    expect(anonymous.status).toBe(404);

    // Not even for its own author: they learn about it from their listings and
    // the notification, not by continuing to serve the content.
    const asAuthor = await request(app)
      .get(`/api/v1/blogs/${blog.slug}`)
      .set(auth(authorToken));
    expect(asAuthor.status).toBe(404);
  });

  it('10. the hidden blog is gone from discovery', async () => {
    const feed = await request(app).get('/api/v1/feed/latest');
    expect(feed.status).toBe(200);
    expect(feed.body.data.items.map((i: any) => i.id)).not.toContain(blog.id);

    const search = await request(app).get('/api/v1/search/blogs?q=published');
    expect(search.status).toBe(200);
    expect(
      (search.body.data.results ?? search.body.data.items ?? []).map((i: any) => i.id)
    ).not.toContain(blog.id);
  });

  it('11. the author cannot edit, republish or delete their way out of the hide', async () => {
    const edit = await request(app)
      .patch(`/api/v1/blogs/${blog.id}`)
      .set(auth(authorToken))
      .send({ title: 'Something Else Entirely' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('CONTENT_MODERATED');

    const unpublish = await request(app)
      .post(`/api/v1/blogs/${blog.id}/unpublish`)
      .set(auth(authorToken));
    expect(unpublish.status).toBe(409);

    const remove = await request(app)
      .delete(`/api/v1/blogs/${blog.id}`)
      .set(auth(authorToken));
    expect(remove.status).toBe(409);
  });

  it('12. the author CAN still see their own post in their listings, flagged', async () => {
    const res = await request(app).get('/api/v1/blogs/me').set(auth(authorToken));

    expect(res.status).toBe(200);
    const mine = res.body.data.items.find((b: any) => b.id === blog.id);
    expect(mine).toMatchObject({ isHidden: true });
  });

  it('13. the moderation history records who did what', async () => {
    const res = await request(app)
      .get('/api/v1/admin/moderation/history?action=CONTENT_HIDDEN')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data.actions[0]).toMatchObject({
      action: 'CONTENT_HIDDEN',
      targetId: blog.id,
      actor: { username: 'e2e-mod' },
      reason: 'Affiliate spam',
    });
  });

  it('14. restoring puts it back, and tells the author', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${blog.id}/restore`)
      .set(auth(moderatorToken))
      .send({ reason: 'Reviewed — the links were disclosed' });

    expect(res.status).toBe(200);
    await eventBus.settled();

    const public_ = await request(app).get(`/api/v1/blogs/${blog.slug}`);
    expect(public_.status).toBe(200);

    const notifications = await prisma.notification.findMany({
      where: { recipientId: author.id, type: 'SYSTEM' },
    });
    expect(
      notifications.some((n) => (n.metadata as any).moderationAction === 'RESTORED')
    ).toBe(true);
  });

  it('15. a re-report is possible now that the first one is closed', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set(auth(reporterToken))
      .send({ targetType: 'BLOG', targetId: blog.id, reason: 'SPAM' });

    // The Redis guard has been cleared by beforeEach; PostgreSQL is what decides,
    // and its partial unique index only covers OPEN reports.
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe('comment moderation', () => {
  it('hides a comment and replaces it with a tombstone for readers', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/comments/${comment.id}/hide`)
      .set(auth(moderatorToken))
      .send({ reason: 'Abuse' });

    expect(res.status).toBe(200);
    await eventBus.settled();

    const thread = await request(app).get(`/api/v1/blogs/${blog.id}/comments`);
    const hidden = thread.body.data.items.find((c: any) => c.id === comment.id);

    expect(hidden.isHidden).toBe(true);
    expect(hidden.content).toBe('This comment has been hidden by a moderator.');
  });

  it('shows a moderator the RAW text, not the tombstone', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/moderation/content/COMMENT/${comment.id}`)
      .set(auth(moderatorToken));

    expect(res.status).toBe(200);
    expect(res.body.data.target.content).toBe('a comment');
  });

  it('refuses removal to a moderator and allows it to an administrator', async () => {
    const denied = await request(app)
      .post(`/api/v1/admin/moderation/comments/${comment.id}/remove`)
      .set(auth(moderatorToken))
      .send({ reason: 'irrecoverable' });
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .post(`/api/v1/admin/moderation/comments/${comment.id}/remove`)
      .set(auth(adminToken))
      .send({ reason: 'irrecoverable' });
    expect(allowed.status).toBe(200);

    const stored = await prisma.comment.findUnique({ where: { id: comment.id } });
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Recovering a removal
// ---------------------------------------------------------------------------

describe('recovering content removed by mistake', () => {
  let removed: { id: string; slug: string };

  beforeAll(async () => {
    removed = await makeBlog(author.id, {
      title: 'Removed By Mistake',
      slug: 'removed-by-mistake',
    });
    await clearDiscoveryCaches();
  });

  it('a removal hides the post as well as deleting it', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${removed.id}/remove`)
      .set(auth(adminToken))
      .send({ reason: 'Acted on the wrong report' });

    expect(res.status).toBe(200);
    await eventBus.settled();

    const stored = await prisma.blog.findUnique({ where: { id: removed.id } });
    expect(stored).toMatchObject({ status: 'DELETED', isHidden: true });

    const anonymous = await request(app).get(`/api/v1/blogs/${removed.slug}`);
    expect(anonymous.status).toBe(404);

    await clearDiscoveryCaches();
    const feed = await request(app).get('/api/v1/feed/latest');
    expect(feed.body.data.items.map((i: any) => i.id)).not.toContain(removed.id);
  });

  it('the author cannot undo it through their own lifecycle', async () => {
    // DELETED -> DRAFT is a legal author transition. What stops it here is the
    // hide flag the removal set: without it, the person the removal was aimed
    // at could reverse it, and nothing would record that they had.
    const res = await request(app)
      .post(`/api/v1/blogs/${removed.id}/restore`)
      .set(auth(authorToken));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTENT_MODERATED');
  });

  it('nor can a moderator, who could not have removed it in the first place', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${removed.id}/restore`)
      .set(auth(moderatorToken))
      .send({ reason: 'looks fine to me' });

    expect(res.status).toBe(403);

    const stored = await prisma.blog.findUnique({ where: { id: removed.id } });
    expect(stored?.status).toBe('DELETED');
  });

  it('an administrator revives it into DRAFT, audited once, and the author is told', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${removed.id}/restore`)
      .set(auth(adminToken))
      .send({ reason: 'Removed in error' });

    expect(res.status).toBe(200);
    await eventBus.settled();

    // Back under the author's control, but NOT republished on their behalf.
    const stored = await prisma.blog.findUnique({ where: { id: removed.id } });
    expect(stored).toMatchObject({ status: 'DRAFT', isHidden: false, hiddenAt: null });

    const actions = await prisma.moderationAction.findMany({
      where: { targetId: removed.id, action: 'CONTENT_RESTORED' },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      actorId: admin.id,
      targetType: 'BLOG',
      subjectUserId: author.id,
      reason: 'Removed in error',
    });

    const notifications = await prisma.notification.findMany({
      where: { recipientId: author.id, entityId: removed.id, type: 'SYSTEM' },
    });
    const restored = notifications.find(
      (n) => (n.metadata as any).moderationAction === 'RESTORED'
    );
    // The copy has to match the state the post came back in.
    expect((restored!.metadata as any).body).toContain('draft');
    expect(restored!.actorId).toBeNull();
  });

  it('the author publishes it again themselves, and it is public and findable', async () => {
    const published = await request(app)
      .post(`/api/v1/blogs/${removed.id}/publish`)
      .set(auth(authorToken));
    expect(published.status).toBe(200);
    await eventBus.settled();
    await clearDiscoveryCaches();

    const anonymous = await request(app).get(`/api/v1/blogs/${removed.slug}`);
    expect(anonymous.status).toBe(200);

    // Feed and Search dropped it on CONTENT_MODERATED and picked it back up on
    // CONTENT_RESTORED + BLOG_PUBLISHED, through their own eligibility
    // predicates — neither knows the Moderation module exists.
    const feed = await request(app).get('/api/v1/feed/latest');
    expect(feed.body.data.items.map((i: any) => i.id)).toContain(removed.id);

    const search = await request(app).get('/api/v1/search/blogs?q=mistake');
    expect(
      (search.body.data.results ?? search.body.data.items ?? []).map((i: any) => i.id)
    ).toContain(removed.id);
  });

  it('restoring again is refused rather than silently doing nothing', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${removed.id}/restore`)
      .set(auth(adminToken));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_HIDDEN');

    // And no second audit row for an action that did not happen.
    const actions = await prisma.moderationAction.count({
      where: { targetId: removed.id, action: 'CONTENT_RESTORED' },
    });
    expect(actions).toBe(1);
  });

  it('refuses to resurrect a post its author deleted themselves', async () => {
    const mine = await makeBlog(author.id, { title: 'My Own Deletion', slug: 'my-own-deletion' });
    await request(app).delete(`/api/v1/blogs/${mine.id}`).set(auth(authorToken));

    const res = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${mine.id}/restore`)
      .set(auth(adminToken));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_HIDDEN');

    const stored = await prisma.blog.findUnique({ where: { id: mine.id } });
    expect(stored?.status).toBe('DELETED');
  });

  it('brings a removed COMMENT back into its thread, audited once', async () => {
    // `comment` was hidden and then removed by the administrator above.
    const denied = await request(app)
      .post(`/api/v1/admin/moderation/comments/${comment.id}/restore`)
      .set(auth(moderatorToken));
    expect(denied.status).toBe(403);

    const res = await request(app)
      .post(`/api/v1/admin/moderation/comments/${comment.id}/restore`)
      .set(auth(adminToken))
      .send({ reason: 'Removed in error' });

    expect(res.status).toBe(200);
    await eventBus.settled();

    const stored = await prisma.comment.findUnique({ where: { id: comment.id } });
    expect(stored).toMatchObject({ deletedAt: null, isHidden: false, hiddenAt: null });

    const thread = await request(app).get(`/api/v1/blogs/${blog.id}/comments`);
    const back = thread.body.data.items.find((c: any) => c.id === comment.id);
    expect(back).toMatchObject({ isDeleted: false, isHidden: false, content: 'a comment' });

    const actions = await prisma.moderationAction.count({
      where: { targetId: comment.id, action: 'CONTENT_RESTORED' },
    });
    expect(actions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------

describe('account suspension', () => {
  let spammer: { id: string };
  let spammerToken: string;
  let spammerBlog: { id: string; slug: string };

  beforeAll(async () => {
    spammer = await makeUser({ username: 'e2e-spammer' });
    spammerToken = tokensService.generateAccessToken({ userId: spammer.id, role: 'USER' });
    spammerBlog = await makeBlog(spammer.id, { title: 'Spam Post', slug: 'spam-post' });

    // A live session, so revocation is observable.
    await prisma.session.create({
      data: {
        userId: spammer.id,
        refreshTokenHash: 'hash-for-suspension-test',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  });

  it('suspends through the User module and audits it', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/users/${spammer.id}/suspend`)
      .set(auth(moderatorToken))
      .send({ reason: 'Posting affiliate spam' });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ status: 'SUSPENDED' });
    await eventBus.settled();

    const stored = await prisma.user.findUnique({ where: { id: spammer.id } });
    expect(stored?.status).toBe('SUSPENDED');
    expect(stored?.suspendedAt).toBeInstanceOf(Date);
    expect(stored?.suspendedReason).toBe('Posting affiliate spam');

    const action = await prisma.moderationAction.findFirst({
      where: { action: 'USER_SUSPENDED', targetId: spammer.id },
    });
    expect(action?.actorId).toBe(moderator.id);
  });

  it('revokes their sessions', async () => {
    const sessions = await prisma.session.findMany({ where: { userId: spammer.id } });
    expect(sessions).toHaveLength(0);
  });

  it('stops the access token they already hold, on the very next write', async () => {
    // The token is still cryptographically valid and unexpired. This is the
    // whole reason `requireActiveAccount` exists.
    const res = await request(app)
      .post('/api/v1/blogs')
      .set(auth(spammerToken))
      .send({ title: 'More spam' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('stops them commenting, following and reporting too', async () => {
    const comment = await request(app)
      .post(`/api/v1/blogs/${blog.id}/comments`)
      .set(auth(spammerToken))
      .send({ content: 'still here' });
    expect(comment.status).toBe(403);

    const follow = await request(app)
      .post(`/api/v1/users/${author.id}/follow`)
      .set(auth(spammerToken));
    expect(follow.status).toBe(403);

    const report = await request(app)
      .post('/api/v1/reports')
      .set(auth(spammerToken))
      .send({ targetType: 'BLOG', targetId: blog.id, reason: 'SPAM' });
    expect(report.status).toBe(403);
  });

  it('still lets them read, including their own account', async () => {
    const profile = await request(app)
      .get('/api/v1/users/me/profile')
      .set(auth(spammerToken));

    expect(profile.status).toBe(200);
  });

  it('takes their content out of discovery without touching a single blog row', async () => {
    const before = await prisma.blog.findUnique({ where: { id: spammerBlog.id } });
    expect(before?.isHidden).toBe(false);
    expect(before?.status).toBe('PUBLISHED');

    const feed = await request(app).get('/api/v1/feed/latest');
    expect(feed.body.data.items.map((i: any) => i.id)).not.toContain(spammerBlog.id);
  });

  it('refuses a second suspension rather than double-acting', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/users/${spammer.id}/suspend`)
      .set(auth(adminToken))
      .send({ reason: 'again' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUSPENDED');
  });

  it('lifts the suspension and lets them act again', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/moderation/users/${spammer.id}/unsuspend`)
      .set(auth(adminToken))
      .send({ reason: 'Appeal upheld' });

    expect(res.status).toBe(200);
    await eventBus.settled();
    await accountStatusService.invalidate(spammer.id);

    const stored = await prisma.user.findUnique({ where: { id: spammer.id } });
    expect(stored).toMatchObject({ status: 'ACTIVE', suspendedAt: null, suspendedReason: null });

    const comment = await request(app)
      .post(`/api/v1/blogs/${blog.id}/comments`)
      .set(auth(spammerToken))
      .send({ content: 'back again' });
    expect(comment.status).toBe(201);
  });

  it('refuses to let a moderator suspend themselves or another moderator', async () => {
    const self = await request(app)
      .post(`/api/v1/admin/moderation/users/${moderator.id}/suspend`)
      .set(auth(moderatorToken))
      .send({ reason: 'oops' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CANNOT_MODERATE_SELF');

    const peer = await request(app)
      .post(`/api/v1/admin/moderation/users/${admin.id}/suspend`)
      .set(auth(moderatorToken))
      .send({ reason: 'disagreement' });
    expect(peer.status).toBe(403);

    // An administrator CAN act on a moderator — someone has to be able to stop
    // a compromised staff account.
    const byAdmin = await request(app)
      .post(`/api/v1/admin/moderation/users/${moderator.id}/suspend`)
      .set(auth(adminToken))
      .send({ reason: 'compromised account' });
    expect(byAdmin.status).toBe(200);
    await eventBus.settled();

    // ...and their moderation powers stop immediately, on the token they are
    // already holding. Without this, suspending a compromised staff account
    // would leave it able to moderate for the rest of that token's lifetime —
    // the window someone who just lost their privileges would use.
    const stillModerating = await request(app)
      .post(`/api/v1/admin/moderation/blogs/${blog.id}/hide`)
      .set(auth(moderatorToken))
      .send({ reason: 'retaliation' });
    expect(stillModerating.status).toBe(403);
    expect(stillModerating.body.error.code).toBe('ACCOUNT_SUSPENDED');

    const stillReading = await request(app)
      .get('/api/v1/admin/moderation/reports')
      .set(auth(moderatorToken));
    expect(stillReading.status).toBe(403);

    await request(app)
      .post(`/api/v1/admin/moderation/users/${moderator.id}/unsuspend`)
      .set(auth(adminToken))
      .send({});
    await eventBus.settled();
    await accountStatusService.invalidate(moderator.id);

    const restored = await request(app)
      .get('/api/v1/admin/moderation/reports')
      .set(auth(moderatorToken));
    expect(restored.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Investigation surfaces
// ---------------------------------------------------------------------------

describe('investigation', () => {
  it("gathers an account's whole record", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/moderation/users/${author.id}`)
      .set(auth(moderatorToken));

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ username: 'e2e-author', kind: 'USER' });
    expect(res.body.data.history.some((a: any) => a.action === 'CONTENT_HIDDEN')).toBe(true);
    expect(res.body.data.openReports).toBeGreaterThanOrEqual(1);
  });

  it('summarises the queue without any unbounded count', async () => {
    const res = await request(app)
      .get('/api/v1/admin/moderation/overview')
      .set(auth(moderatorToken));

    expect(res.status).toBe(200);
    expect(res.body.data.overview).toMatchObject({
      queue: { pending: expect.any(Number), reviewing: expect.any(Number) },
      activityWindowDays: expect.any(Number),
    });
    expect(Array.isArray(res.body.data.overview.recentActions)).toBe(true);
  });

  it('does not leak private account data into an administrative view', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/moderation/users/${author.id}`)
      .set(auth(moderatorToken));

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('@test.local'); // the email
  });
});
