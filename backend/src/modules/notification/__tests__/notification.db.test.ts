import { prisma } from '../../../core/database/prisma';
import { notificationRepository } from '../notification.repository';
import { notificationDeliveryRepository } from '../notificationDelivery.repository';
import { notificationOrchestrator } from '../notification.orchestrator';
import { notificationService } from '../notification.service';
import { onUserFollowed } from '../subscribers/follow.subscriber';
import { onCommentCreated, onCommentReplied } from '../subscribers/comment.subscriber';
import { resetDb, disconnectDb, makeUser } from '../../../test/db';
import type { NotificationRequest } from '../notification.types';

jest.mock('../../../core/providers/queue', () => ({
  QUEUES: { EMAIL: 'email_queue', NOTIFICATION: 'notification_queue' },
  emailQueue: { add: jest.fn().mockResolvedValue(undefined) },
  notificationQueue: { add: jest.fn().mockResolvedValue(undefined) },
  createQueue: jest.fn(),
  createWorker: jest.fn(),
  closeWorkers: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { emailQueue } = require('../../../core/providers/queue');

const request = (over: Partial<NotificationRequest> = {}): NotificationRequest => ({
  recipientId: 'placeholder',
  actorId: null,
  type: 'FOLLOW',
  dedupeKey: `key-${Math.random()}`,
  ...over,
});

describe('Notification module (real database)', () => {
  let recipient: { id: string };
  let actor: { id: string };

  beforeEach(async () => {
    await resetDb();
    recipient = await makeUser();
    actor = await makeUser();
    jest.clearAllMocks();
  });

  afterAll(disconnectDb);

  describe('orchestrator', () => {
    it('persists an in-app notification and queues the email', async () => {
      const result = await notificationOrchestrator.dispatch(
        request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: 'k1' })
      );

      expect(result).toEqual({ created: true });

      const rows = await prisma.notification.findMany({
        where: { recipientId: recipient.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'FOLLOW', actorId: actor.id, isRead: false });

      // FOLLOW defaults to email: true
      expect(emailQueue.add).toHaveBeenCalledTimes(1);
      const deliveries = await prisma.notificationDelivery.findMany();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ channel: 'EMAIL', status: 'PENDING' });
    });

    it('never notifies an actor about their own action', async () => {
      const result = await notificationOrchestrator.dispatch(
        request({ recipientId: recipient.id, actorId: recipient.id, dedupeKey: 'self' })
      );

      expect(result).toEqual({ created: false });
      expect(await prisma.notification.count()).toBe(0);
    });

    it('is idempotent on dedupeKey — a replayed dispatch creates one row and one email', async () => {
      const req = request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: 'dup' });

      const first = await notificationOrchestrator.dispatch(req);
      const second = await notificationOrchestrator.dispatch(req);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(await prisma.notification.count()).toBe(1);
      // The critical property: a replay must not send a second email.
      expect(emailQueue.add).toHaveBeenCalledTimes(1);
    });

    it('survives a genuine race: concurrent dispatches yield one row and one email', async () => {
      const req = request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: 'race' });

      const results = await Promise.all([
        notificationOrchestrator.dispatch(req),
        notificationOrchestrator.dispatch(req),
        notificationOrchestrator.dispatch(req),
      ]);

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await prisma.notification.count()).toBe(1);
      expect(emailQueue.add).toHaveBeenCalledTimes(1);
    });

    describe('preferences', () => {
      it('skips the email when the type has email disabled', async () => {
        await prisma.userSettings.create({
          data: {
            userId: recipient.id,
            notificationPreferences: { FOLLOW: { inApp: true, email: false } },
          },
        });

        await notificationOrchestrator.dispatch(
          request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: 'no-email' })
        );

        expect(await prisma.notification.count()).toBe(1); // in-app still created
        expect(emailQueue.add).not.toHaveBeenCalled();
        expect(await prisma.notificationDelivery.count()).toBe(0);
      });

      it('creates nothing when in-app is disabled for the type', async () => {
        await prisma.userSettings.create({
          data: {
            userId: recipient.id,
            notificationPreferences: { FOLLOW: { inApp: false, email: false } },
          },
        });

        const result = await notificationOrchestrator.dispatch(
          request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: 'off' })
        );

        expect(result).toEqual({ created: false });
        expect(await prisma.notification.count()).toBe(0);
      });

      it('applies defaults when the user has no settings row at all', async () => {
        // Most users are in this state — the row is created lazily.
        expect(await prisma.userSettings.count({ where: { userId: recipient.id } })).toBe(0);

        await notificationOrchestrator.dispatch(
          request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: 'defaults' })
        );

        expect(await prisma.notification.count()).toBe(1);
        expect(emailQueue.add).toHaveBeenCalledTimes(1);
      });

      it('respects a partial override without resetting other types', async () => {
        await prisma.userSettings.create({
          data: {
            userId: recipient.id,
            notificationPreferences: { COMMENT: { email: true } },
          },
        });

        // COMMENT defaults to email:false; the override flips only that.
        await notificationOrchestrator.dispatch(
          request({
            recipientId: recipient.id,
            actorId: actor.id,
            type: 'COMMENT',
            dedupeKey: 'partial',
          })
        );

        expect(emailQueue.add).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('subscribers', () => {
    it('USER_FOLLOWED creates a FOLLOW notification for the followed user', async () => {
      await onUserFollowed({ followerId: actor.id, followingId: recipient.id });

      const rows = await prisma.notification.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        recipientId: recipient.id,
        actorId: actor.id,
        type: 'FOLLOW',
      });
    });

    it('COMMENT_CREATED notifies the blog owner', async () => {
      await onCommentCreated({
        commentId: 'c1',
        blogId: 'b1',
        authorId: actor.id,
        blogAuthorId: recipient.id,
        parentId: null,
      });

      const rows = await prisma.notification.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'COMMENT', recipientId: recipient.id });
    });

    it('COMMENT_CREATED is skipped for replies, so a reply notifies once not twice', async () => {
      // A reply emits BOTH events upstream; this is what prevents double-notify.
      await onCommentCreated({
        commentId: 'c2',
        blogId: 'b1',
        authorId: actor.id,
        blogAuthorId: recipient.id,
        parentId: 'parent-1',
      });

      expect(await prisma.notification.count()).toBe(0);
    });

    it('COMMENT_REPLIED notifies the parent comment author', async () => {
      // Blog owner IS the parent author here, so they get one REPLY, not a
      // REPLY plus a COMMENT for the same action.
      await onCommentReplied({
        commentId: 'c3',
        blogId: 'b1',
        authorId: actor.id,
        parentId: 'p1',
        parentAuthorId: recipient.id,
        blogAuthorId: recipient.id,
      });

      const rows = await prisma.notification.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'REPLY', recipientId: recipient.id });
    });

    it('COMMENT_REPLIED also notifies the blog owner when all three differ', async () => {
      // The gap this closes: COMMENT_CREATED skips every reply, so without a
      // second dispatch here the owner never hears about replies on their post.
      const owner = await makeUser();

      await onCommentReplied({
        commentId: 'c5',
        blogId: 'b1',
        authorId: actor.id,
        parentId: 'p1',
        parentAuthorId: recipient.id,
        blogAuthorId: owner.id,
      });

      const rows = await prisma.notification.findMany({ orderBy: { type: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(rows).toEqual([
        expect.objectContaining({ type: 'COMMENT', recipientId: owner.id }),
        expect.objectContaining({ type: 'REPLY', recipientId: recipient.id }),
      ]);
    });

    it('does not notify a blog owner who wrote the reply themselves', async () => {
      await onCommentReplied({
        commentId: 'c6',
        blogId: 'b1',
        authorId: actor.id,
        parentId: 'p1',
        parentAuthorId: recipient.id,
        blogAuthorId: actor.id,
      });

      const rows = await prisma.notification.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'REPLY', recipientId: recipient.id });
    });

    it('does not notify someone commenting on their own blog', async () => {
      await onCommentCreated({
        commentId: 'c4',
        blogId: 'b1',
        authorId: recipient.id,
        blogAuthorId: recipient.id,
        parentId: null,
      });

      expect(await prisma.notification.count()).toBe(0);
    });
  });

  describe('read state and pagination', () => {
    beforeEach(async () => {
      for (let i = 0; i < 5; i++) {
        await notificationRepository.create(
          request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: `n${i}` })
        );
      }
    });

    it('counts unread accurately', async () => {
      expect(await notificationRepository.unreadCount(recipient.id)).toBe(5);
    });

    it('marks one read and decrements the unread count', async () => {
      const [first] = await prisma.notification.findMany({ take: 1 });

      const result = await notificationService.markRead(recipient.id, first!.id);

      expect(result.unreadCount).toBe(4);
      const row = await prisma.notification.findUnique({ where: { id: first!.id } });
      expect(row!.isRead).toBe(true);
      expect(row!.readAt).not.toBeNull();
    });

    it("refuses to mark another user's notification read", async () => {
      const stranger = await makeUser();
      const [first] = await prisma.notification.findMany({ take: 1 });

      // 404 rather than 403, so this cannot be used to probe which ids exist.
      await expect(
        notificationService.markRead(stranger.id, first!.id)
      ).rejects.toMatchObject({ statusCode: 404, errorCode: 'NOTIFICATION_NOT_FOUND' });

      const row = await prisma.notification.findUnique({ where: { id: first!.id } });
      expect(row!.isRead).toBe(false); // untouched
    });

    it('marks all read', async () => {
      const result = await notificationService.markAllRead(recipient.id);

      expect(result.updated).toBe(5);
      expect(await notificationRepository.unreadCount(recipient.id)).toBe(0);
    });

    it('walks every notification exactly once via the cursor', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;

      for (let guard = 0; guard < 20; guard++) {
        const page = await notificationService.list(recipient.id, {
          limit: 2,
          sort: 'recent',
          cursor,
        });
        seen.push(...page.items.map((i) => i.id));
        if (!page.hasNextPage) break;
        cursor = page.nextCursor!;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it("scopes the list to its owner", async () => {
      const stranger = await makeUser();
      const page = await notificationService.list(stranger.id, { limit: 20, sort: 'recent' });

      expect(page.items).toHaveLength(0);
      expect(page.totalCount).toBe(0);
    });

    it('filters by read state', async () => {
      const [first] = await prisma.notification.findMany({ take: 1 });
      await notificationService.markRead(recipient.id, first!.id);

      const unread = await notificationService.list(recipient.id, {
        limit: 20,
        sort: 'recent',
        isRead: false,
      });

      expect(unread.items).toHaveLength(4);
      expect(unread.totalCount).toBe(4);
    });
  });

  describe('preferences API', () => {
    it('returns defaults for a user who has never set any', async () => {
      const prefs = await notificationService.getPreferences(recipient.id);

      expect(prefs.FOLLOW).toEqual({ inApp: true, email: true });
      expect(prefs.COMMENT).toEqual({ inApp: true, email: false });
    });

    it('merges a partial patch without resetting untouched types', async () => {
      await notificationService.updatePreferences(recipient.id, {
        FOLLOW: { email: false },
      });

      const prefs = await notificationService.getPreferences(recipient.id);
      expect(prefs.FOLLOW).toEqual({ inApp: true, email: false }); // patched
      expect(prefs.BLOG).toEqual({ inApp: true, email: true }); // untouched default
    });

    it('persists across two sequential patches', async () => {
      await notificationService.updatePreferences(recipient.id, { FOLLOW: { email: false } });
      await notificationService.updatePreferences(recipient.id, { BLOG: { inApp: false } });

      const prefs = await notificationService.getPreferences(recipient.id);
      expect(prefs.FOLLOW.email).toBe(false); // survived the second patch
      expect(prefs.BLOG.inApp).toBe(false);
    });
  });

  describe('delivery tracking', () => {
    it('records one delivery per channel and reports who created it', async () => {
      const { id } = await notificationRepository.create(
        request({ recipientId: recipient.id, dedupeKey: 'd1' })
      );

      const first = await notificationDeliveryRepository.create(id!, 'EMAIL');
      const second = await notificationDeliveryRepository.create(id!, 'EMAIL');

      expect(first.created).toBe(true);
      // Exactly-once send hinges on this being false for the loser.
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(await prisma.notificationDelivery.count()).toBe(1);
    });

    it('tracks status transitions and attempts', async () => {
      const { id } = await notificationRepository.create(
        request({ recipientId: recipient.id, dedupeKey: 'd2' })
      );
      const delivery = await notificationDeliveryRepository.create(id!, 'EMAIL');

      await notificationDeliveryRepository.incrementAttempts(delivery.id);
      await notificationDeliveryRepository.incrementAttempts(delivery.id);
      await notificationDeliveryRepository.updateStatus(delivery.id, 'FAILED', {
        error: 'provider exploded',
      });

      let row = await notificationDeliveryRepository.findById(delivery.id);
      expect(row).toMatchObject({ status: 'FAILED', attempts: 2, error: 'provider exploded' });
      expect(row!.failedAt).not.toBeNull();

      await notificationDeliveryRepository.updateStatus(delivery.id, 'SENT', {
        provider: 'log',
        providerMessageId: 'log-1',
      });

      row = await notificationDeliveryRepository.findById(delivery.id);
      expect(row).toMatchObject({ status: 'SENT', providerMessageId: 'log-1', error: null });
      expect(row!.sentAt).not.toBeNull();
    });

    it('cascades away with its notification', async () => {
      const { id } = await notificationRepository.create(
        request({ recipientId: recipient.id, dedupeKey: 'd3' })
      );
      await notificationDeliveryRepository.create(id!, 'EMAIL');

      await prisma.notification.delete({ where: { id: id! } });

      expect(await prisma.notificationDelivery.count()).toBe(0);
    });

    it('cascades away when the recipient is deleted', async () => {
      await notificationRepository.create(
        request({ recipientId: recipient.id, dedupeKey: 'd4' })
      );

      await prisma.user.delete({ where: { id: recipient.id } });

      expect(await prisma.notification.count()).toBe(0);
    });

    it('keeps the notification when the ACTOR is deleted, nulling the actor', async () => {
      await notificationRepository.create(
        request({ recipientId: recipient.id, actorId: actor.id, dedupeKey: 'd5' })
      );

      await prisma.user.delete({ where: { id: actor.id } });

      // SetNull, not Cascade — a deleted actor must not erase the recipient's history.
      const rows = await prisma.notification.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBeNull();
    });
  });
});
