import { Prisma, DeliveryChannel, DeliveryStatus } from '@prisma/client';
import { prisma } from '../../core/database/prisma';

/**
 * Delivery tracking for external channels only (email today; push/SMS reserved).
 * In-app has no delivery semantics — it IS the Notification row — so tracking it
 * would double the write volume of every fan-out for no signal.
 */
export class NotificationDeliveryRepository {
  /**
   * Creates the PENDING record a channel attaches to before enqueueing, and
   * reports whether THIS call created it.
   *
   * `created` is what makes sending exactly-once: the unique index on
   * (notificationId, channel) means only one caller can win, so only that caller
   * enqueues the send. A replayed fan-out batch or a retried dispatch reaches an
   * existing row, gets `created: false`, and enqueues nothing — no duplicate email.
   */
  async create(
    notificationId: string,
    channel: DeliveryChannel,
    provider?: string
  ): Promise<{ id: string; created: boolean }> {
    try {
      const row = await prisma.notificationDelivery.create({
        data: { notificationId, channel, provider: provider ?? null },
        select: { id: true },
      });
      return { id: row.id, created: true };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await prisma.notificationDelivery.findUnique({
          where: { notificationId_channel: { notificationId, channel } },
          select: { id: true },
        });
        return { id: existing!.id, created: false };
      }
      throw err;
    }
  }

  /**
   * Bulk PENDING inserts for fan-out. `skipDuplicates` leans on the unique
   * (notificationId, channel) index, so a replayed batch is a no-op.
   *
   * Unlike `create`, this CANNOT report which rows were new — `createMany`
   * returns only a count. Callers therefore must not use "did I insert it?" as
   * their send-once guard; they enqueue with a deterministic job id instead, so
   * a duplicate enqueue collapses into one job. See EmailNotificationChannel.
   */
  async createManyPending(
    notificationIds: string[],
    channel: DeliveryChannel,
    provider?: string
  ): Promise<number> {
    if (notificationIds.length === 0) return 0;
    const result = await prisma.notificationDelivery.createMany({
      data: notificationIds.map((notificationId) => ({
        notificationId,
        channel,
        provider: provider ?? null,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /**
   * Resolves delivery rows for a set of notifications in ONE query. Fan-out
   * needs the ids `createMany` does not return, and `status` so rows already
   * sent are never re-queued.
   */
  async findByNotificationIds(
    notificationIds: string[],
    channel: DeliveryChannel
  ): Promise<{ id: string; notificationId: string; status: DeliveryStatus }[]> {
    if (notificationIds.length === 0) return [];
    return prisma.notificationDelivery.findMany({
      where: { notificationId: { in: notificationIds }, channel },
      select: { id: true, notificationId: true, status: true },
    });
  }

  /**
   * Removes a delivery row. Used to roll back a PENDING row whose enqueue
   * failed: the row's existence is what makes `create` report `created: false`,
   * so an orphaned one would block every future retry from re-queueing the send.
   */
  async delete(id: string): Promise<void> {
    await prisma.notificationDelivery.delete({ where: { id } });
  }

  async updateStatus(
    id: string,
    status: DeliveryStatus,
    details: {
      provider?: string;
      providerMessageId?: string;
      error?: string;
    } = {}
  ): Promise<void> {
    const now = new Date();
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        status,
        ...(details.provider && { provider: details.provider }),
        ...(details.providerMessageId && {
          providerMessageId: details.providerMessageId,
        }),
        // Truncated: a provider stack trace can be unbounded, and this column is
        // read by humans debugging, not parsed.
        ...(details.error && { error: details.error.slice(0, 2000) }),
        ...(status === 'SENT' && { sentAt: now, error: null }),
        ...(status === 'FAILED' && { failedAt: now }),
      },
    });
  }

  /** Atomic increment — two concurrent attempts must not clobber each other. */
  async incrementAttempts(id: string): Promise<number> {
    const row = await prisma.notificationDelivery.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return row.attempts;
  }

  async findById(id: string) {
    return prisma.notificationDelivery.findUnique({ where: { id } });
  }

  /**
   * Deliveries stuck in PENDING past `olderThan` — enqueued but never processed,
   * or rolled back and never retried. Nothing sweeps these yet; the query exists
   * so "are we silently dropping mail?" is answerable before a sweep is built.
   */
  async findStuckPending(olderThan: Date, limit = 100) {
    return prisma.notificationDelivery.findMany({
      where: { status: 'PENDING', createdAt: { lt: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /** Operational view: recent failures, for a dashboard or a retry sweep. */
  async findFailed(since: Date, limit = 100) {
    return prisma.notificationDelivery.findMany({
      where: { status: 'FAILED', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

export const notificationDeliveryRepository = new NotificationDeliveryRepository();

export type { DeliveryChannel, DeliveryStatus, Prisma };
