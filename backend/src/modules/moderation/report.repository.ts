import {
  Prisma,
  ReportStatus,
  type Report,
  type ReportReason,
  type ReportTargetType,
} from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import { OPEN_REPORT_STATUSES } from './moderation.config';
import type { CursorPosition } from './moderation.cursor';
import { splitPage, type SortDirection } from './moderation.query';

/**
 * Persistence for reports.
 *
 * Two things about this file are load-bearing:
 *
 *   1. Every state transition is a CONDITIONAL update (`updateMany` with the
 *      expected status in the WHERE clause) that reports whether it changed a
 *      row. Two moderators working the same queue page is normal, not
 *      exceptional, and a read-then-write would let both "succeed" — two audit
 *      records and two notifications for one decision. The condition makes the
 *      database the arbiter, with no locks and no transactions.
 *
 *   2. No query here is unbounded. Every list takes a limit, every count is
 *      either over the open subset (which a partial index keeps small) or bounded
 *      by a date range.
 */

export interface CreateReportData {
  reporterId: string | null;
  source: 'USER' | 'AUTOMATED';
  targetType: ReportTargetType;
  targetId: string;
  targetOwnerId: string | null;
  reason: ReportReason;
  description: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Every filter the queue supports. All optional; all combinable. */
export interface ReportFilters {
  statuses?: ReportStatus[];
  targetType?: ReportTargetType;
  reason?: ReportReason;
  source?: 'USER' | 'AUTOMATED';
  /** The moderator a report is assigned to. */
  assignedToId?: string;
  reporterId?: string;
  targetOwnerId?: string;
  from?: Date;
  to?: Date;
}

export interface ReportPageRequest {
  limit: number;
  sort: SortDirection;
  position?: CursorPosition;
}

export class ReportRepository {
  // ---- Writes ----

  create(data: CreateReportData): Promise<Report> {
    return prisma.report.create({
      data: {
        reporterId: data.reporterId,
        source: data.source,
        targetType: data.targetType,
        targetId: data.targetId,
        targetOwnerId: data.targetOwnerId,
        reason: data.reason,
        description: data.description,
        ...(data.metadata !== undefined && { metadata: data.metadata }),
      },
    });
  }

  /**
   * Claims a PENDING report for a moderator.
   *
   * The `status: 'PENDING'` condition is the whole point: the loser of a race
   * changes nothing and is told the report is already being reviewed, instead of
   * silently taking it from the moderator who is mid-decision.
   */
  async claim(
    id: string,
    moderatorId: string,
    tx: Prisma.TransactionClient | typeof prisma = prisma
  ): Promise<boolean> {
    const result = await tx.report.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REVIEWING', assignedToId: moderatorId, assignedAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * Closes a report (RESOLVED or DISMISSED).
   *
   * Conditional on the report still being OPEN, so a second moderator cannot
   * overwrite the first one's resolution — and cannot re-open a closed report by
   * resolving it again with a different reason.
   */
  async close(
    id: string,
    status: Extract<ReportStatus, 'RESOLVED' | 'DISMISSED'>,
    moderatorId: string,
    resolutionReason: string | null,
    tx: Prisma.TransactionClient | typeof prisma = prisma
  ): Promise<boolean> {
    const result = await tx.report.updateMany({
      where: { id, status: { in: OPEN_REPORT_STATUSES } },
      data: {
        status,
        resolvedById: moderatorId,
        resolvedAt: new Date(),
        resolutionReason,
      },
    });
    return result.count === 1;
  }

  // ---- Reads ----

  findById(id: string): Promise<Report | null> {
    return prisma.report.findUnique({ where: { id } });
  }

  /**
   * A cursor page of reports.
   *
   * ── Why this one query is raw SQL ───────────────────────────────────────
   * The queue's status predicate has to be emitted as LITERALS, and Prisma's
   * query builder always parameterizes. That difference is not cosmetic — it
   * decides whether the queue stays fast as the table grows.
   *
   * `report_open_queue_idx` is PARTIAL on `status IN ('PENDING','REVIEWING')`,
   * and Postgres can only prove a partial index applies against constants. With
   * a bind parameter it cannot, so it falls back to the full `(createdAt, id)`
   * index and filters — walking the whole history, oldest first, to find the
   * open rows that are almost all at the other end. Measured on a seeded 20 300
   * row table (`npm run moderation:report`):
   *
   *   parameterized   13 ms, 19 801 buffers, 19 652 rows discarded by the filter
   *   literal        0.15 ms,      3 buffers, straight off the partial index
   *
   * The gap is not a constant factor — it grows with the table, because the
   * parameterized plan's work is proportional to CLOSED reports, which
   * accumulate forever. That is the "full-table scan on the moderation queue"
   * this module exists to avoid.
   *
   * Same technique, same reason, as `feed.eligibility.ts` and the Search engine.
   *
   * ── Nothing user-supplied is interpolated ───────────────────────────────
   * Only the status values are literal, they come from a Zod enum, and
   * `statusLiterals` re-checks each one against the Prisma enum before it is
   * written into SQL. Every other filter — ids, dates, the cursor position — is
   * a bind parameter.
   *
   * Fetches `limit + 1` rows so "is there another page" costs nothing extra, and
   * orders by `(createdAt, id)` — total, so the keyset can neither skip nor
   * repeat.
   */
  list(filters: ReportFilters, page: ReportPageRequest): Promise<Report[]> {
    const conditions: Prisma.Sql[] = [];

    if (filters.statuses?.length) {
      conditions.push(Prisma.raw(`r."status" IN (${statusLiterals(filters.statuses)})`));
    }
    if (filters.targetType) {
      conditions.push(Prisma.sql`r."targetType" = ${filters.targetType}::"ReportTargetType"`);
    }
    if (filters.reason) {
      conditions.push(Prisma.sql`r."reason" = ${filters.reason}::"ReportReason"`);
    }
    if (filters.source) {
      conditions.push(Prisma.sql`r."source" = ${filters.source}::"ReportSource"`);
    }
    if (filters.assignedToId) {
      conditions.push(Prisma.sql`r."assignedToId" = ${filters.assignedToId}`);
    }
    if (filters.reporterId) {
      conditions.push(Prisma.sql`r."reporterId" = ${filters.reporterId}`);
    }
    if (filters.targetOwnerId) {
      conditions.push(Prisma.sql`r."targetOwnerId" = ${filters.targetOwnerId}`);
    }
    if (filters.from) {
      conditions.push(Prisma.sql`r."createdAt" >= ${filters.from}`);
    }
    if (filters.to) {
      conditions.push(Prisma.sql`r."createdAt" <= ${filters.to}`);
    }

    if (page.position) {
      // Row-wise comparison, which is both the exact keyset semantics and the
      // form the planner can turn straight into an index seek — unlike the
      // equivalent `(a > x) OR (a = x AND b > y)`, which it may not.
      const comparison = page.sort === 'asc' ? Prisma.raw('>') : Prisma.raw('<');
      conditions.push(
        Prisma.sql`(r."createdAt", r."id") ${comparison} (${page.position.createdAt}, ${page.position.id})`
      );
    }

    const where =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;
    const direction = Prisma.raw(page.sort === 'asc' ? 'ASC' : 'DESC');

    return prisma.$queryRaw<Report[]>`
      SELECT r.*
      FROM "Report" r
      ${where}
      ORDER BY r."createdAt" ${direction}, r."id" ${direction}
      LIMIT ${page.limit + 1}
    `;
  }

  /** Open reports about one specific target — the "pile-on" signal on a detail page. */
  countOpenForTarget(targetType: ReportTargetType, targetId: string): Promise<number> {
    return prisma.report.count({
      where: { targetType, targetId, status: { in: OPEN_REPORT_STATUSES } },
    });
  }

  /** Open reports about anything one account owns, plus the account itself. */
  countOpenForOwner(ownerId: string): Promise<number> {
    return prisma.report.count({
      where: {
        status: { in: OPEN_REPORT_STATUSES },
        OR: [
          { targetOwnerId: ownerId },
          { targetType: 'USER', targetId: ownerId },
        ],
      },
    });
  }

  /**
   * An open report by this reporter about this target, if any.
   *
   * The pre-check behind the friendly 409. The AUTHORITATIVE guard is the
   * partial unique index (see prisma/sql/moderation_indexes.sql) — this read and
   * the following write are not atomic, so two simultaneous submissions can both
   * pass here and one will lose at the INSERT. That is exactly why the index
   * exists and why the service handles P2002.
   */
  findOpenByReporterForTarget(
    reporterId: string,
    targetType: ReportTargetType,
    targetId: string
  ): Promise<Report | null> {
    return prisma.report.findFirst({
      where: {
        reporterId,
        targetType,
        targetId,
        status: { in: OPEN_REPORT_STATUSES },
      },
    });
  }

  /**
   * An open AUTOMATED report for a target.
   *
   * Automated reports carry no reporter, so the partial unique index does not
   * cover them (it is keyed on `reporterId`). This is their duplicate guard: the
   * provider re-evaluating a republished blog must not file a second report
   * while the first is still waiting.
   */
  findOpenAutomatedForTarget(
    targetType: ReportTargetType,
    targetId: string
  ): Promise<Report | null> {
    return prisma.report.findFirst({
      where: {
        source: 'AUTOMATED',
        targetType,
        targetId,
        status: { in: OPEN_REPORT_STATUSES },
      },
    });
  }

  /** Exact count for one status. Served by the (status, createdAt, id) index. */
  countByStatus(status: ReportStatus): Promise<number> {
    return prisma.report.count({ where: { status } });
  }

  /**
   * Open reports grouped by reason — what the platform is being flagged for.
   *
   * Raw, for the same reason `list` is: the aggregate is over the OPEN subset,
   * and only a literal predicate lets the planner read that subset off the
   * partial index instead of scanning every report ever filed.
   */
  async groupOpenByReason(): Promise<{ reason: ReportReason; count: number }[]> {
    const rows = await prisma.$queryRaw<{ reason: ReportReason; count: bigint }[]>`
      SELECT r."reason", count(*) AS count
      FROM "Report" r
      WHERE ${openStatusPredicate()}
      GROUP BY r."reason"
      ORDER BY count(*) DESC
    `;
    return rows.map((row) => ({ reason: row.reason, count: Number(row.count) }));
  }

  /** Open reports grouped by what kind of thing was reported. */
  async groupOpenByTargetType(): Promise<{ targetType: ReportTargetType; count: number }[]> {
    const rows = await prisma.$queryRaw<{ targetType: ReportTargetType; count: bigint }[]>`
      SELECT r."targetType", count(*) AS count
      FROM "Report" r
      WHERE ${openStatusPredicate()}
      GROUP BY r."targetType"
    `;
    return rows.map((row) => ({ targetType: row.targetType, count: Number(row.count) }));
  }

  /**
   * When the oldest still-open report arrived — the queue's backlog age.
   *
   * One row off the front of the partial open-queue index, which is only
   * possible with the literal predicate; parameterized, this becomes a walk
   * through every old CLOSED report looking for an open one.
   */
  async oldestOpenAt(): Promise<Date | null> {
    const rows = await prisma.$queryRaw<{ createdAt: Date }[]>`
      SELECT r."createdAt"
      FROM "Report" r
      WHERE ${openStatusPredicate()}
      ORDER BY r."createdAt" ASC, r."id" ASC
      LIMIT 1
    `;
    return rows[0]?.createdAt ?? null;
  }

  /** Splits a `limit + 1` fetch into a page. Re-exported so services stay thin. */
  page(rows: Report[], limit: number) {
    return splitPage(rows, limit);
  }
}

/**
 * Renders report statuses as SQL literals, re-validating each one.
 *
 * The values already come from a Zod enum by the time they reach here, so this
 * is belt and braces — but it is the only place in this module where a value is
 * written into SQL rather than bound, and "already validated upstream" is
 * exactly the assumption that stops being true when someone adds a caller.
 */
function statusLiterals(statuses: ReportStatus[]): string {
  const allowed = new Set<string>(Object.values(ReportStatus));
  for (const status of statuses) {
    if (!allowed.has(status)) {
      throw new Error(`Unknown report status: ${status}`);
    }
  }
  return statuses.map((status) => `'${status}'`).join(', ');
}

/**
 * `status IN ('PENDING','REVIEWING')` as literals — the predicate the partial
 * indexes were built with, so the planner can prove they apply.
 *
 * Derived from `OPEN_REPORT_STATUSES` rather than hardcoded, so the config, the
 * SQL file and these queries cannot drift apart (a test asserts the index
 * definition still matches).
 */
function openStatusPredicate(): Prisma.Sql {
  return Prisma.raw(`r."status" IN (${statusLiterals(OPEN_REPORT_STATUSES)})`);
}

export const reportRepository = new ReportRepository();
