import { ReportStatus } from '@prisma/client';

/**
 * Tuning constants for the Moderation module.
 *
 * Collected here rather than scattered across the services because every one of
 * them is an operational decision someone may want to revisit — a queue page
 * size, a duplicate-suppression window, a spam threshold — and none of them is
 * a business rule. Anything that encodes policy (who may do what, what happens
 * to a hidden blog) lives in the permission catalogue or the services instead.
 */

/** Bumped when a cursor's payload shape changes, so stale cursors 400 cleanly. */
export const CURSOR_VERSION = 1;

export const DEFAULT_QUEUE_LIMIT = 25;
export const MAX_QUEUE_LIMIT = 100;

/**
 * The statuses that mean "still needs a human".
 *
 * One definition, used by the queue's default filter, the duplicate check, the
 * overview counts and the partial indexes in `prisma/sql/moderation_indexes.sql`.
 * The SQL file's predicate must match this list — they are the same rule
 * expressed twice, and a test asserts they agree.
 */
export const OPEN_REPORT_STATUSES: ReportStatus[] = ['PENDING', 'REVIEWING'];

/** The terminal statuses. A report in one of these is never re-opened. */
export const CLOSED_REPORT_STATUSES: ReportStatus[] = ['RESOLVED', 'DISMISSED'];

/**
 * How long Redis remembers that a reporter already reported a target.
 *
 * This is a SHORTCUT, not the rule. The authoritative duplicate guard is a
 * partial unique index in PostgreSQL; this exists so a spam loop is answered
 * from memory instead of by a failed INSERT each time. Redis being down, cold
 * or wrong changes nothing about which reports actually get stored.
 *
 * Six hours: long enough to absorb an angry burst, short enough that it is
 * never the reason a legitimate re-report is refused (the database decides that,
 * and only while the first report is still open).
 */
export const DUPLICATE_GUARD_TTL_SECONDS = 6 * 60 * 60;

/**
 * How long an AUTOMATED evaluation is remembered per target.
 *
 * Automated reports have no reporter, so the partial unique index does not
 * cover them. This guard is what stops an edit-and-republish loop from filing a
 * report per republish. It is deliberately longer than the human one — nothing
 * is waiting on it, and the database check behind it (an open automated report
 * for the same target) is the real backstop.
 */
export const AUTOMATED_GUARD_TTL_SECONDS = 24 * 60 * 60;

/** Longest free-text a reporter or moderator may attach to a report/action. */
export const MAX_REASON_LENGTH = 1_000;

/** Rows returned by the overview's "latest actions" strip. */
export const OVERVIEW_RECENT_ACTIONS = 10;

/**
 * The window the overview's throughput figures cover.
 *
 * Bounded on purpose: "how many reports has this platform ever resolved" is a
 * full-table count that gets slower every day and answers nothing anyone acts
 * on. Recent throughput is both cheaper (an index range scan over the audit log)
 * and the number a moderation lead actually looks at.
 */
export const OVERVIEW_ACTIVITY_DAYS = 7;

/**
 * Score at or above which the rule-based provider's verdict becomes a report.
 *
 * Set high enough that an automated report is worth a moderator's attention:
 * every false positive costs queue time, and a queue nobody trusts is a queue
 * nobody works. The provider returns a score regardless; only this decides
 * whether a report is filed.
 */
export const AUTOMATED_REPORT_THRESHOLD = 0.75;

/** Most characters of a body the automated evaluator reads. */
export const AUTOMATED_SCAN_MAX_CHARS = 4_000;
