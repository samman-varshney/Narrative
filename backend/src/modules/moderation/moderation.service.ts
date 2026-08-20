import type { ModerationActionType, ModerationTargetType, Prisma } from '@prisma/client';
import { AppError } from '../../core/exceptions/AppError';
import { logger } from '../../core/utils/logger';
import { assertPermission } from '../auth/permissions';
import { blogService } from '../blog/blog.service';
import { commentService } from '../comment/comment.service';
import { userService } from '../user/user.service';
import { auditRepository, type AuditFilters } from './audit.repository';
import {
  OVERVIEW_ACTIVITY_DAYS,
  OVERVIEW_RECENT_ACTIONS,
} from './moderation.config';
import { cursorFingerprint, decodeCursor, encodeCursor } from './moderation.cursor';
import { loadTarget, loadUserCards } from './moderation.hydration';
import { toModerationActionDTO, userIdsOfActions } from './moderation.mappers';
import type {
  ContentModerationDTO,
  ModerationActionDTO,
  ModerationActor,
  ModerationOverviewDTO,
  ModerationPage,
  UserModerationDTO,
  UserTargetDTO,
} from './moderation.types';
import type { AuditQuery, ModerationActionInput } from './moderation.validator';
import { reportRepository } from './report.repository';
import { reportService } from './report.service';

/** Audit rows carried by a per-target or per-user moderation view. */
const TARGET_HISTORY_LIMIT = 25;

/**
 * Administrative actions, and the read surfaces that support them.
 *
 * ── What this module does and does not own ──────────────────────────────────
 * It owns the DECISION and the RECORD. It does not own the data the decision
 * changes: hiding a blog is `blogService.hideForModeration`, suspending an
 * account is `userService.suspend`. Every method here is the same three steps —
 * authorize, ask the owning module to act, write the audit row — and the reason
 * it looks repetitive is that the repetition is the boundary.
 *
 * Nothing in this file writes to another module's table, and nothing in it
 * reimplements another module's rules. What "hidden" means to a feed, what a
 * suspended account may still do, whether a comment tombstone keeps its replies
 * — none of that is decided here, which is why adding a moderation action never
 * changes how content behaves.
 *
 * ── Ordering: act first, then record ────────────────────────────────────────
 * The audit row is written AFTER the action succeeds, not before. Recording an
 * intention that then fails would put actions in the log that never happened —
 * and a log that contains things that did not happen is worse than one that is
 * occasionally missing something, because nothing in it can be trusted.
 *
 * The residual risk (the audit write fails, or the process dies, after the
 * action has committed) is accepted and documented rather than papered over:
 * closing it would mean running another module's write inside this module's
 * transaction, which is the coupling the whole architecture is arranged to
 * avoid. It is a FOUNDATION-LEVEL limitation of a modular monolith without a
 * shared outbox, not a bug in this module, and it is bounded on three sides:
 *
 *  - the action's domain event is durable (BullMQ) and carries the actor, so
 *    the trace survives even when the row does not;
 *  - `audit()` logs the entire entry at ERROR under the stable key
 *    `moderation.audit_write_failed`, which is enough to reconstruct the row
 *    and is the thing to alert on;
 *  - the window is one INSERT wide, into a table with no foreign keys and no
 *    unique constraints to violate, so in practice it opens only when Postgres
 *    itself is unavailable — at which point the action would rarely have
 *    committed either.
 *
 * What is NOT acceptable is the inverse, and the ordering above is what rules it
 * out: an audit log that claims actions which never happened.
 */
export class ModerationService {
  // ---- Content actions ---------------------------------------------------

  async hideBlog(actor: ModerationActor, blogId: string, input: ModerationActionInput) {
    assertPermission(actor.role, 'content:hide');
    const snapshot = await blogService.hideForModeration(blogId, actor, input.reason);

    await this.audit(actor, {
      action: 'CONTENT_HIDDEN',
      targetType: 'BLOG',
      targetId: blogId,
      subjectUserId: snapshot?.authorId ?? null,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
      metadata: { title: snapshot?.title ?? null, slug: snapshot?.slug ?? null },
    });

    await this.closeReportIfLinked(actor, input);
    return snapshot;
  }

  async restoreBlog(actor: ModerationActor, blogId: string, input: ModerationActionInput) {
    assertPermission(actor.role, 'content:restore');
    const snapshot = await blogService.restoreFromModeration(blogId, actor);

    await this.audit(actor, {
      action: 'CONTENT_RESTORED',
      targetType: 'BLOG',
      targetId: blogId,
      subjectUserId: snapshot?.authorId ?? null,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
      metadata: { title: snapshot?.title ?? null, slug: snapshot?.slug ?? null },
    });

    await this.closeReportIfLinked(actor, input);
    return snapshot;
  }

  async deleteBlog(actor: ModerationActor, blogId: string, input: ModerationActionInput) {
    assertPermission(actor.role, 'content:delete');
    const snapshot = await blogService.deleteForModeration(blogId, actor, input.reason);

    await this.audit(actor, {
      action: 'CONTENT_DELETED',
      targetType: 'BLOG',
      targetId: blogId,
      subjectUserId: snapshot?.authorId ?? null,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
      metadata: { title: snapshot?.title ?? null, slug: snapshot?.slug ?? null },
    });

    await this.closeReportIfLinked(actor, input);
    return snapshot;
  }

  async hideComment(
    actor: ModerationActor,
    commentId: string,
    input: ModerationActionInput
  ) {
    assertPermission(actor.role, 'content:hide');
    const snapshot = await commentService.hideForModeration(commentId, actor, input.reason);

    await this.audit(actor, {
      action: 'CONTENT_HIDDEN',
      targetType: 'COMMENT',
      targetId: commentId,
      subjectUserId: snapshot?.authorId ?? null,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
      metadata: { blogId: snapshot?.blogId ?? null },
    });

    await this.closeReportIfLinked(actor, input);
    return snapshot;
  }

  async restoreComment(
    actor: ModerationActor,
    commentId: string,
    input: ModerationActionInput
  ) {
    assertPermission(actor.role, 'content:restore');
    const snapshot = await commentService.restoreFromModeration(commentId, actor);

    await this.audit(actor, {
      action: 'CONTENT_RESTORED',
      targetType: 'COMMENT',
      targetId: commentId,
      subjectUserId: snapshot?.authorId ?? null,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
      metadata: { blogId: snapshot?.blogId ?? null },
    });

    await this.closeReportIfLinked(actor, input);
    return snapshot;
  }

  async deleteComment(
    actor: ModerationActor,
    commentId: string,
    input: ModerationActionInput
  ) {
    assertPermission(actor.role, 'content:delete');
    const snapshot = await commentService.deleteForModeration(
      commentId,
      actor,
      input.reason
    );

    await this.audit(actor, {
      action: 'CONTENT_DELETED',
      targetType: 'COMMENT',
      targetId: commentId,
      subjectUserId: snapshot?.authorId ?? null,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
      metadata: { blogId: snapshot?.blogId ?? null },
    });

    await this.closeReportIfLinked(actor, input);
    return snapshot;
  }

  // ---- Account actions ---------------------------------------------------

  async suspendUser(
    actor: ModerationActor,
    userId: string,
    input: ModerationActionInput
  ): Promise<UserTargetDTO> {
    assertPermission(actor.role, 'users:suspend');
    const user = await userService.suspend(userId, actor, input.reason);

    await this.audit(actor, {
      action: 'USER_SUSPENDED',
      targetType: 'USER',
      targetId: userId,
      subjectUserId: userId,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
    });

    await this.closeReportIfLinked(actor, input);
    return this.toUserTarget(user);
  }

  async unsuspendUser(
    actor: ModerationActor,
    userId: string,
    input: ModerationActionInput
  ): Promise<UserTargetDTO> {
    assertPermission(actor.role, 'users:unsuspend');
    const user = await userService.unsuspend(userId, actor);

    await this.audit(actor, {
      action: 'USER_UNSUSPENDED',
      targetType: 'USER',
      targetId: userId,
      subjectUserId: userId,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
    });

    await this.closeReportIfLinked(actor, input);
    return this.toUserTarget(user);
  }

  // ---- Read surfaces -----------------------------------------------------

  /**
   * The administrative landing payload.
   *
   * Every number here is bounded. There is deliberately no "total reports ever"
   * or "total actions ever": those are full-table counts that get slower every
   * day and that nobody acts on. What a moderation lead actually needs is the
   * open backlog, its shape, and recent throughput — all of which are served by
   * the partial open-queue index and a date-ranged scan of the audit log.
   */
  async getOverview(actor: ModerationActor): Promise<ModerationOverviewDTO> {
    assertPermission(actor.role, 'reports:view');

    const since = new Date(Date.now() - OVERVIEW_ACTIVITY_DAYS * 24 * 60 * 60 * 1000);

    const [pending, reviewing, oldestOpenAt, openByReason, openByTargetType, activity, recent] =
      await Promise.all([
        reportRepository.countByStatus('PENDING'),
        reportRepository.countByStatus('REVIEWING'),
        reportRepository.oldestOpenAt(),
        reportRepository.groupOpenByReason(),
        reportRepository.groupOpenByTargetType(),
        auditRepository.countByActionSince(since),
        auditRepository.recent(OVERVIEW_RECENT_ACTIONS),
      ]);

    const users = await loadUserCards(userIdsOfActions(recent));

    return {
      queue: { pending, reviewing, oldestOpenAt },
      openByReason,
      openByTargetType,
      activity,
      activityWindowDays: OVERVIEW_ACTIVITY_DAYS,
      recentActions: recent.map((action) => toModerationActionDTO(action, users)),
    };
  }

  /** Filtered, cursor-paged moderation history. */
  async getHistory(
    actor: ModerationActor,
    query: AuditQuery
  ): Promise<ModerationPage<ModerationActionDTO>> {
    assertPermission(actor.role, 'moderation:history:view');

    const filters: AuditFilters = {
      action: query.action,
      actorId: query.actorId,
      targetType: query.targetType,
      targetId: query.targetId,
      subjectUserId: query.subjectUserId,
      reportId: query.reportId,
      from: query.from,
      to: query.to,
    };

    const fingerprint = cursorFingerprint({ ...filters, sort: query.sort });
    const position = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;

    const rows = await auditRepository.list(filters, {
      limit: query.limit,
      sort: query.sort,
      position,
    });

    const { items, hasNextPage, last } = auditRepository.page(rows, query.limit);
    const users = await loadUserCards(userIdsOfActions(items));

    return {
      items: items.map((action) => toModerationActionDTO(action, users)),
      nextCursor: hasNextPage && last ? encodeCursor(last, fingerprint) : null,
      hasNextPage,
    };
  }

  /**
   * Everything a moderator needs to know about one account: its current state,
   * how many open reports touch it, and its full moderation record.
   *
   * `findForSubject` rather than `findForTarget`, so an account's record
   * includes actions taken against its BLOGS and COMMENTS — which is what
   * "does this person have a history" actually means.
   */
  async getUserModeration(
    actor: ModerationActor,
    userId: string
  ): Promise<UserModerationDTO> {
    assertPermission(actor.role, 'reports:view');

    const user = await userService.getModerationSummary(userId);
    const [openReports, history] = await Promise.all([
      reportRepository.countOpenForOwner(userId),
      auditRepository.findForSubject(userId, TARGET_HISTORY_LIMIT),
    ]);

    const users = await loadUserCards(userIdsOfActions(history));

    return {
      user: this.toUserTarget(user),
      openReports,
      history: history.map((action) => toModerationActionDTO(action, users)),
    };
  }

  /** The same view for one piece of content. */
  async getContentModeration(
    actor: ModerationActor,
    targetType: 'BLOG' | 'COMMENT',
    targetId: string
  ): Promise<ContentModerationDTO> {
    assertPermission(actor.role, 'reports:view');

    const target = await loadTarget(targetType, targetId);
    if (target.kind === 'MISSING') {
      throw new AppError('Content not found', 404, 'TARGET_NOT_FOUND');
    }

    const [openReports, history] = await Promise.all([
      reportRepository.countOpenForTarget(targetType, targetId),
      auditRepository.findForTarget(targetType as ModerationTargetType, targetId, TARGET_HISTORY_LIMIT),
    ]);

    const users = await loadUserCards(userIdsOfActions(history));

    return {
      target,
      openReports,
      history: history.map((action) => toModerationActionDTO(action, users)),
    };
  }

  // ---- Internals ---------------------------------------------------------

  /**
   * Writes the audit row for an action that has already happened.
   *
   * A failure here is logged and swallowed, and that is a deliberate, uneasy
   * choice: the action HAS taken effect, so throwing would report failure for
   * something that succeeded and invite the moderator to do it again. The log
   * line is the compensating control — it is an error, monitored as one, not a
   * shrug.
   */
  private async audit(
    actor: ModerationActor,
    entry: {
      action: ModerationActionType;
      targetType: ModerationTargetType;
      targetId: string;
      subjectUserId?: string | null;
      reportId?: string | null;
      reason?: string | null;
      metadata?: Prisma.InputJsonValue;
    }
  ): Promise<void> {
    try {
      await auditRepository.record({ actorId: actor.userId, ...entry });
    } catch (err) {
      // KNOWN FOUNDATION-LEVEL LIMITATION — see the class docblock, and
      // docs/MODERATION_MODULE.md § "Known limitations".
      //
      // The owning module's write has already committed in its own transaction.
      // This one failed. There is no way to undo the first from here without
      // reaching into another module's tables, which is the coupling the whole
      // architecture exists to avoid — so the action stands and the record is
      // missing, and the honest thing to do is make that loud rather than tidy.
      //
      // Deliberately NOT rethrown. Turning it into a 500 would tell the
      // moderator their action failed when it did not, and the retry they would
      // reasonably make would act a second time (a second suspension, a second
      // notification) — trading a missing row for a wrong one.
      //
      // The whole entry is logged, not a summary of it: this line is the only
      // surviving trace of the decision, so it has to carry enough to write the
      // row back by hand. `event` is a stable key to alert on — a non-zero rate
      // here means the audit log is no longer a complete record, which is an
      // operational incident, not a warning to scroll past.
      logger.error(
        {
          event: 'moderation.audit_write_failed',
          err,
          actorId: actor.userId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          subjectUserId: entry.subjectUserId ?? null,
          reportId: entry.reportId ?? null,
          reason: entry.reason ?? null,
          metadata: entry.metadata ?? null,
        },
        'moderation: ACTION PERFORMED BUT NOT AUDITED — audit log is incomplete'
      );
    }
  }

  /**
   * Closes the report an action was taken from, when the caller named one.
   *
   * Best-effort, and its own audit row: the action and the closure are two
   * decisions (what to do about the content, and whether the report is now
   * settled), and a moderator who acted but whose report failed to close should
   * be told their action worked — not handed a 500.
   */
  private async closeReportIfLinked(
    actor: ModerationActor,
    input: ModerationActionInput
  ): Promise<void> {
    if (!input.reportId) return;
    await reportService.closeAfterAction(actor, input.reportId, input.reason ?? null);
  }

  private toUserTarget(
    user: Awaited<ReturnType<typeof userService.getModerationSummary>>
  ): UserTargetDTO {
    return {
      kind: 'USER',
      id: user.id,
      username: user.username,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      status: user.status,
      isVerified: user.isVerified,
      suspendedAt: user.suspendedAt,
      suspendedReason: user.suspendedReason,
      createdAt: user.createdAt,
      counts: {
        blogs: user._count.blogs,
        comments: user._count.comments,
        followers: user._count.followers,
      },
    };
  }
}

export const moderationService = new ModerationService();
