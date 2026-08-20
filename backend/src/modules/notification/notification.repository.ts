import { Prisma, NotificationType } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import type { NotificationRequest } from './notification.types';

/** Public actor fields embedded in a notification ("Alice followed you"). */
export const notificationActorSelect = {
  id: true,
  username: true,
  name: true,
  avatar: true,
  isVerified: true,
} satisfies Prisma.UserSelect;

export const notificationInclude = {
  actor: { select: notificationActorSelect },
} satisfies Prisma.NotificationInclude;

export type NotificationWithActor = Prisma.NotificationGetPayload<{
  include: typeof notificationInclude;
}>;

export interface NotificationListFilters {
  type?: NotificationType;
  isRead?: boolean;
}

export interface NotificationListQuery extends NotificationListFilters {
  cursor?: string;
  limit: number;
  sort: 'recent' | 'oldest';
}

export class NotificationRepository {
  /**
   * Idempotent create. `dedupeKey` is unique, so a retried job or a duplicated
   * event yields one row; P2002 is swallowed and reported as `created: false` so
   * the orchestrator knows not to re-queue external deliveries.
   */
  async create(
    request: NotificationRequest
  ): Promise<{ created: boolean; id: string | null }> {
    try {
      const row = await prisma.notification.create({
        data: this.toCreateData(request),
        select: { id: true },
      });
      return { created: true, id: row.id };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await prisma.notification.findUnique({
          where: { dedupeKey: request.dedupeKey },
          select: { id: true },
        });
        return { created: false, id: existing?.id ?? null };
      }
      throw err;
    }
  }

  /**
   * Bulk insert for fan-out. `skipDuplicates` leans on the dedupeKey unique
   * index so a retried fan-out batch is a no-op rather than a duplicate storm.
   * Returns how many rows were actually new.
   */
  async createMany(requests: NotificationRequest[]): Promise<number> {
    if (requests.length === 0) return 0;
    const result = await prisma.notification.createMany({
      data: requests.map((r) => this.toCreateData(r)),
      skipDuplicates: true,
    });
    return result.count;
  }

  /** Cursor page of a recipient's notifications, newest-first by default. */
  async findByRecipient(
    recipientId: string,
    query: NotificationListQuery
  ): Promise<NotificationWithActor[]> {
    const direction = query.sort === 'oldest' ? 'asc' : 'desc';
    return prisma.notification.findMany({
      where: this.buildWhere(recipientId, query),
      include: notificationInclude,
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    });
  }

  async countByRecipient(
    recipientId: string,
    filters: NotificationListFilters = {}
  ): Promise<number> {
    return prisma.notification.count({
      where: this.buildWhere(recipientId, filters),
    });
  }

  /** Served by the partial index in prisma/sql/notification_unread_idx.sql. */
  async unreadCount(recipientId: string): Promise<number> {
    return prisma.notification.count({ where: { recipientId, isRead: false } });
  }

  /**
   * Marks one notification read. Scoped by `recipientId` via updateMany rather
   * than `update({ where: { id } })` — that scoping is the authorization check,
   * so one user can never mark another's notification read.
   */
  async markRead(recipientId: string, id: string): Promise<{ count: number }> {
    const result = await prisma.notification.updateMany({
      where: { id, recipientId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { count: result.count };
  }

  async markAllRead(recipientId: string): Promise<{ count: number }> {
    const result = await prisma.notification.updateMany({
      where: { recipientId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { count: result.count };
  }

  /**
   * Resolves ids for a set of dedupeKeys in one query. `createMany` returns no
   * ids, so fan-out uses this to attach deliveries without a per-recipient
   * round trip.
   */
  async findIdsByDedupeKeys(
    dedupeKeys: string[]
  ): Promise<{ id: string; dedupeKey: string }[]> {
    if (dedupeKeys.length === 0) return [];
    return prisma.notification.findMany({
      where: { dedupeKey: { in: dedupeKeys } },
      select: { id: true, dedupeKey: true },
    });
  }

  async findById(id: string): Promise<NotificationWithActor | null> {
    return prisma.notification.findUnique({
      where: { id },
      include: notificationInclude,
    });
  }

  private toCreateData(r: NotificationRequest): Prisma.NotificationCreateManyInput {
    return {
      recipientId: r.recipientId,
      actorId: r.actorId ?? null,
      type: r.type,
      entityType: r.entityType ?? null,
      entityId: r.entityId ?? null,
      metadata: (r.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      dedupeKey: r.dedupeKey,
    };
  }

  /** Shared by the list and count queries so totals can never contradict a page. */
  private buildWhere(
    recipientId: string,
    filters: NotificationListFilters
  ): Prisma.NotificationWhereInput {
    return {
      recipientId,
      ...(filters.type && { type: filters.type }),
      ...(filters.isRead !== undefined && { isRead: filters.isRead }),
    };
  }

  /**
   * One page of this user's received notifications, for the data export.
   *
   * `metadata` is included because it holds the render inputs (blog title,
   * comment excerpt) — without it a notification row says only that something
   * happened. The ACTOR is reduced to their public identity: a notification is
   * the recipient's data, not a licence to export somebody else's.
   */
  async findAllByRecipientForExport(recipientId: string, take: number, cursorId?: string) {
    return prisma.notification.findMany({
      where: { recipientId },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        entityType: true,
        entityId: true,
        metadata: true,
        isRead: true,
        readAt: true,
        createdAt: true,
        actor: { select: { username: true, name: true } },
      },
    });
  }
}

export const notificationRepository = new NotificationRepository();
