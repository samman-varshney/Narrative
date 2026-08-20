import { Prisma, type Report, type ReportTargetType } from '@prisma/client';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { logger } from '../../core/utils/logger';
import { assertPermission } from '../auth/permissions';
import { auditRepository } from './audit.repository';
import {
  claimReportSlot,
  releaseReportSlot,
} from './moderation.cache';
import { OPEN_REPORT_STATUSES } from './moderation.config';
import { cursorFingerprint, decodeCursor, encodeCursor } from './moderation.cursor';
import { loadTarget, loadUserCards, resolveTargetOwner } from './moderation.hydration';
import {
  toModerationActionDTO,
  toReportListItem,
  userIdsOfActions,
  userIdsOfReports,
} from './moderation.mappers';
import { runModerationTransaction } from './moderation.transaction';
import type {
  ModerationActor,
  ModerationPage,
  ReportDetailDTO,
  ReportListItemDTO,
} from './moderation.types';
import { reportRepository, type ReportFilters } from './report.repository';
import type {
  CreateReportInput,
  ReportQuery,
  ResolveReportInput,
} from './moderation.validator';

/** How many audit rows a report detail page carries. */
const REPORT_HISTORY_LIMIT = 20;

/**
 * The report lifecycle: filing, triage, and closure.
 *
 * ── A report changes nothing ────────────────────────────────────────────────
 * Filing a report has no effect on what anyone can see. That is the single most
 * important property of this file: if a report could hide content, then reports
 * would be the platform's censorship API and a brigade would be its user
 * interface. Content only moves when a moderator acts — see
 * `moderation.service.ts`, and note that nothing there takes a report as its
 * authority, only as its context.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * Two moderators opening the same queue page is the normal case, not the edge
 * one. Every transition here is a conditional UPDATE that reports whether it
 * changed a row; the loser gets a 409 describing what actually happened, not a
 * silent overwrite of a colleague's decision.
 */
export class ReportService {
  // ---- Filing ------------------------------------------------------------

  /**
   * Files a report from an authenticated user.
   *
   * `reporterId` comes from the token — there is no parameter for it — so a
   * report can never be attributed to someone else.
   */
  async createReport(
    reporterId: string,
    input: CreateReportInput
  ): Promise<ReportListItemDTO> {
    const { targetType, targetId } = input;

    // Cheapest rejection first: reporting yourself is either a mistake or an
    // attempt to pollute the queue, and it is decidable without any I/O.
    if (targetType === 'USER' && targetId === reporterId) {
      throw new AppError('You cannot report your own account', 400, 'INVALID_TARGET');
    }

    // The Redis guard is claimed BEFORE the database work so a burst is absorbed
    // without touching Postgres at all. Released on every path that does not end
    // in a stored report, or a rejected submission would lock the reporter out
    // of reporting that target for hours.
    const slot = await claimReportSlot(reporterId, targetType, targetId);
    if (!slot) {
      throw new AppError(
        'You have already reported this recently',
        409,
        'DUPLICATE_REPORT'
      );
    }

    let report: Report;
    try {
      const owner = await resolveTargetOwner(targetType, targetId);
      if (!owner) {
        throw new AppError('The reported content no longer exists', 404, 'TARGET_NOT_FOUND');
      }

      if (owner.ownerId === reporterId) {
        throw new AppError(
          'You cannot report your own content',
          400,
          'INVALID_TARGET'
        );
      }

      const existing = await reportRepository.findOpenByReporterForTarget(
        reporterId,
        targetType,
        targetId
      );
      if (existing) {
        throw new AppError(
          'You have already reported this and it is still being reviewed',
          409,
          'DUPLICATE_REPORT'
        );
      }

      report = await reportRepository.create({
        reporterId,
        source: 'USER',
        targetType,
        targetId,
        targetOwnerId: owner.ownerId,
        reason: input.reason,
        description: input.description ?? null,
      });
    } catch (err) {
      // The pre-check above and this INSERT are not atomic, so two simultaneous
      // submissions can both pass it. The partial unique index settles that, and
      // P2002 here is that outcome — surfaced as the same 409 the pre-check
      // gives, because from the reporter's side it is the same situation.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(
          'You have already reported this and it is still being reviewed',
          409,
          'DUPLICATE_REPORT'
        );
      }

      // Anything else: the report was not stored, so the guard must not behave
      // as though it was.
      await releaseReportSlot(reporterId, targetType, targetId);
      throw err;
    }

    eventBus.emit(EVENTS.REPORT_CREATED, {
      reportId: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      targetOwnerId: report.targetOwnerId,
      reporterId: report.reporterId,
      reason: report.reason,
      source: report.source,
    });

    const users = await loadUserCards(userIdsOfReports([report]));
    return toReportListItem(report, users);
  }

  /**
   * Files a report raised by the automated evaluator.
   *
   * Separate from `createReport` because almost none of its rules apply: there
   * is no reporter to attribute it to, no self-report to prevent, and no Redis
   * slot keyed on a person. What it shares is the destination — the same queue,
   * the same statuses, the same filters — so a moderator never has to work two
   * lists.
   *
   * Returns null when a report was not filed (one is already open for this
   * target), so the caller can log accurately instead of guessing.
   */
  async createAutomatedReport(params: {
    targetType: ReportTargetType;
    targetId: string;
    targetOwnerId: string | null;
    reason: CreateReportInput['reason'];
    description: string;
    metadata: Prisma.InputJsonValue;
  }): Promise<Report | null> {
    const open = await reportRepository.findOpenAutomatedForTarget(
      params.targetType,
      params.targetId
    );
    if (open) return null;

    const report = await reportRepository.create({
      reporterId: null,
      source: 'AUTOMATED',
      targetType: params.targetType,
      targetId: params.targetId,
      targetOwnerId: params.targetOwnerId,
      reason: params.reason,
      description: params.description,
      metadata: params.metadata,
    });

    eventBus.emit(EVENTS.REPORT_CREATED, {
      reportId: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      targetOwnerId: report.targetOwnerId,
      reporterId: null,
      reason: report.reason,
      source: report.source,
    });

    return report;
  }

  // ---- The queue ---------------------------------------------------------

  /**
   * A filtered, sorted, cursor-paged view of the queue.
   *
   * Defaults to OPEN reports, oldest first: a work queue drains front to back,
   * and the report that has waited longest is the one that most needs a
   * decision. Newest-first is available for the "what just came in" view.
   */
  async listReports(
    actor: ModerationActor,
    query: ReportQuery
  ): Promise<ModerationPage<ReportListItemDTO>> {
    assertPermission(actor.role, 'reports:view');

    const filters: ReportFilters = {
      statuses: query.status ?? OPEN_REPORT_STATUSES,
      targetType: query.targetType,
      reason: query.reason,
      source: query.source,
      assignedToId: query.assignedTo,
      targetOwnerId: query.targetOwner,
      from: query.from,
      to: query.to,
    };

    // The fingerprint covers everything that defines the ordering, so a cursor
    // cannot be replayed against a different filter set and produce a page that
    // looks plausible but is a position in another list.
    const fingerprint = cursorFingerprint({ ...filters, sort: query.sort });
    const position = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;

    const rows = await reportRepository.list(filters, {
      limit: query.limit,
      sort: query.sort,
      position,
    });

    const { items, hasNextPage, last } = reportRepository.page(rows, query.limit);
    const users = await loadUserCards(userIdsOfReports(items));

    return {
      items: items.map((report) => toReportListItem(report, users)),
      nextCursor: hasNextPage && last ? encodeCursor(last, fingerprint) : null,
      hasNextPage,
    };
  }

  /**
   * One report, with everything needed to decide it: the live target, how many
   * other people have reported the same thing, and what has already been done.
   */
  async getReport(actor: ModerationActor, reportId: string): Promise<ReportDetailDTO> {
    assertPermission(actor.role, 'reports:view');

    const report = await this.load(reportId);

    const [target, relatedOpenReports, history] = await Promise.all([
      loadTarget(report.targetType, report.targetId),
      reportRepository.countOpenForTarget(report.targetType, report.targetId),
      auditRepository.findForReport(reportId, REPORT_HISTORY_LIMIT),
    ]);

    const users = await loadUserCards([
      ...userIdsOfReports([report]),
      ...userIdsOfActions(history),
    ]);

    return {
      ...toReportListItem(report, users),
      target,
      // Excludes this report itself, so the number answers "how many OTHERS",
      // which is the question a moderator is actually asking.
      relatedOpenReports: Math.max(0, relatedOpenReports - (this.isOpen(report) ? 1 : 0)),
      history: history.map((action) => toModerationActionDTO(action, users)),
    };
  }

  // ---- Triage ------------------------------------------------------------

  /**
   * Takes a PENDING report for review.
   *
   * The claim and its audit record are written in ONE transaction: a claim
   * nobody can account for, or an audit row for a claim that never happened,
   * would each undermine the log's purpose.
   */
  async claimReport(actor: ModerationActor, reportId: string): Promise<ReportDetailDTO> {
    assertPermission(actor.role, 'reports:review');

    const report = await this.load(reportId);

    await runModerationTransaction(async (tx) => {
      const claimed = await reportRepository.claim(reportId, actor.userId, tx);
      if (!claimed) {
        // Either another moderator took it, or it is already closed. Both are
        // "you are not the one holding this", and the detail view shows which.
        throw new AppError(
          'This report is already being reviewed or has been closed',
          409,
          'REPORT_NOT_PENDING'
        );
      }

      await auditRepository.record(
        {
          actorId: actor.userId,
          action: 'REPORT_CLAIMED',
          targetType: 'REPORT',
          targetId: reportId,
          subjectUserId: report.targetOwnerId,
          reportId,
        },
        tx
      );
    });

    eventBus.emit(EVENTS.REPORT_ASSIGNED, {
      reportId,
      moderatorId: actor.userId,
      targetType: report.targetType,
      targetId: report.targetId,
    });

    return this.getReport(actor, reportId);
  }

  /** Closes a report as actioned. */
  resolveReport(
    actor: ModerationActor,
    reportId: string,
    input: ResolveReportInput
  ): Promise<ReportDetailDTO> {
    return this.close(actor, reportId, 'RESOLVED', input);
  }

  /** Closes a report as not actionable. */
  dismissReport(
    actor: ModerationActor,
    reportId: string,
    input: ResolveReportInput
  ): Promise<ReportDetailDTO> {
    return this.close(actor, reportId, 'DISMISSED', input);
  }

  /**
   * Attaches an already-performed moderation action to a report and closes it.
   *
   * Used by `moderation.service` when a moderator acts straight from a report —
   * the action is performed through the owning module first, then the report is
   * closed here so there is one path that writes a resolution.
   *
   * Best-effort by design: the content is already hidden, or the account already
   * suspended, and the audit record for that action is already written. Failing
   * the whole request because the report could not be closed would tell the
   * moderator their action failed when it did not. It is logged, and the report
   * stays in the queue for someone to close by hand.
   */
  async closeAfterAction(
    actor: ModerationActor,
    reportId: string,
    resolutionReason: string | null
  ): Promise<void> {
    try {
      const closed = await reportRepository.close(
        reportId,
        'RESOLVED',
        actor.userId,
        resolutionReason
      );
      if (!closed) {
        logger.info({ reportId }, 'moderation: report was already closed by someone else');
        return;
      }

      await auditRepository.record({
        actorId: actor.userId,
        action: 'REPORT_RESOLVED',
        targetType: 'REPORT',
        targetId: reportId,
        reportId,
        reason: resolutionReason,
      });

      eventBus.emit(EVENTS.REPORT_RESOLVED, {
        reportId,
        moderatorId: actor.userId,
        resolution: 'RESOLVED',
      });
    } catch (err) {
      logger.error({ err, reportId }, 'moderation: failed to close report after an action');
    }
  }

  private async close(
    actor: ModerationActor,
    reportId: string,
    status: 'RESOLVED' | 'DISMISSED',
    input: ResolveReportInput
  ): Promise<ReportDetailDTO> {
    assertPermission(actor.role, 'reports:resolve');

    const report = await this.load(reportId);
    const reason = input.reason ?? null;

    await runModerationTransaction(async (tx) => {
      const closed = await reportRepository.close(
        reportId,
        status,
        actor.userId,
        reason,
        tx
      );
      if (!closed) {
        throw new AppError(
          'This report has already been closed',
          409,
          'REPORT_ALREADY_CLOSED'
        );
      }

      await auditRepository.record(
        {
          actorId: actor.userId,
          action: status === 'RESOLVED' ? 'REPORT_RESOLVED' : 'REPORT_DISMISSED',
          targetType: 'REPORT',
          targetId: reportId,
          subjectUserId: report.targetOwnerId,
          reportId,
          reason,
        },
        tx
      );
    });

    eventBus.emit(
      status === 'RESOLVED' ? EVENTS.REPORT_RESOLVED : EVENTS.REPORT_DISMISSED,
      {
        reportId,
        moderatorId: actor.userId,
        targetType: report.targetType,
        targetId: report.targetId,
        resolution: status,
      }
    );

    return this.getReport(actor, reportId);
  }

  private async load(reportId: string): Promise<Report> {
    const report = await reportRepository.findById(reportId);
    if (!report) throw new AppError('Report not found', 404, 'REPORT_NOT_FOUND');
    return report;
  }

  private isOpen(report: Report): boolean {
    return OPEN_REPORT_STATUSES.includes(report.status);
  }
}

export const reportService = new ReportService();
