import {
  Prisma,
  type ModerationAction,
  type ModerationActionType,
  type ModerationTargetType,
} from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import type { CursorPosition } from './moderation.cursor';
import { keysetOrderBy, keysetWhere, splitPage, type SortDirection } from './moderation.query';

/**
 * Persistence for the moderation audit log.
 *
 * Notice what is NOT here: no update, no delete, no upsert. That is the design
 * — and it is backed by a database trigger that refuses UPDATE and DELETE on
 * this table outright (see prisma/sql/moderation_indexes.sql), so the guarantee
 * survives a future caller who never read this comment.
 *
 * `record` optionally takes a transaction client. When the change being recorded
 * is local to this module (claiming a report, resolving one), the audit row and
 * the change are written in ONE transaction so a crash cannot leave a decision
 * with no record or a record with no decision. When the change belongs to
 * another module's service — hiding a blog, suspending a user — it cannot be:
 * that write has already committed behind its own service boundary. See
 * MODERATION_MODULE.md § Audit logging for what that means in practice.
 */

export interface RecordActionData {
  actorId: string;
  action: ModerationActionType;
  targetType: ModerationTargetType;
  targetId: string;
  subjectUserId?: string | null;
  reportId?: string | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface AuditFilters {
  action?: ModerationActionType;
  actorId?: string;
  targetType?: ModerationTargetType;
  targetId?: string;
  subjectUserId?: string;
  reportId?: string;
  from?: Date;
  to?: Date;
}

export interface AuditPageRequest {
  limit: number;
  sort: SortDirection;
  position?: CursorPosition;
}

export class AuditRepository {
  /** Appends one action. The only write this table has. */
  record(
    data: RecordActionData,
    tx: Prisma.TransactionClient | typeof prisma = prisma
  ): Promise<ModerationAction> {
    return tx.moderationAction.create({
      data: {
        actorId: data.actorId,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId,
        subjectUserId: data.subjectUserId ?? null,
        reportId: data.reportId ?? null,
        reason: data.reason ?? null,
        ...(data.metadata !== undefined && { metadata: data.metadata }),
      },
    });
  }

  /** A cursor page of history. Same keyset shape as the report queue. */
  list(filters: AuditFilters, page: AuditPageRequest): Promise<ModerationAction[]> {
    return prisma.moderationAction.findMany({
      where: {
        ...this.whereFrom(filters),
        ...(page.position ? keysetWhere(page.position, page.sort) : {}),
      },
      orderBy: [...keysetOrderBy(page.sort)],
      take: page.limit + 1,
    });
  }

  /**
   * Everything ever done to one thing, newest first.
   *
   * Bounded by `limit` — this is the history strip on a detail page, not an
   * export. A target with thousands of actions is a target with a problem, and
   * the queue should not try to render all of it.
   */
  findForTarget(
    targetType: ModerationTargetType,
    targetId: string,
    limit: number
  ): Promise<ModerationAction[]> {
    return prisma.moderationAction.findMany({
      where: { targetType, targetId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  /** Everything done to one account and to the content it owns. */
  findForSubject(subjectUserId: string, limit: number): Promise<ModerationAction[]> {
    return prisma.moderationAction.findMany({
      where: { subjectUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  /** What has already been done about one report. */
  findForReport(reportId: string, limit: number): Promise<ModerationAction[]> {
    return prisma.moderationAction.findMany({
      where: { reportId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  /**
   * Action counts since an instant — moderator throughput for the overview.
   *
   * Date-bounded rather than lifetime, so the cost is a range scan on
   * `(action, createdAt)` that stays flat as history accumulates.
   */
  async countByActionSince(
    since: Date
  ): Promise<{ action: ModerationActionType; count: number }[]> {
    const rows = await prisma.moderationAction.groupBy({
      by: ['action'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    return rows.map((row) => ({ action: row.action, count: row._count._all }));
  }

  /** The newest actions across the whole platform. */
  recent(limit: number): Promise<ModerationAction[]> {
    return prisma.moderationAction.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  page(rows: ModerationAction[], limit: number) {
    return splitPage(rows, limit);
  }

  private whereFrom(filters: AuditFilters): Prisma.ModerationActionWhereInput {
    const where: Prisma.ModerationActionWhereInput = {};

    if (filters.action) where.action = filters.action;
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.targetType) where.targetType = filters.targetType;
    if (filters.targetId) where.targetId = filters.targetId;
    if (filters.subjectUserId) where.subjectUserId = filters.subjectUserId;
    if (filters.reportId) where.reportId = filters.reportId;

    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from && { gte: filters.from }),
        ...(filters.to && { lte: filters.to }),
      };
    }

    return where;
  }
}

export const auditRepository = new AuditRepository();
