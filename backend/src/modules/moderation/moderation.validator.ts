import { z } from 'zod';
import {
  ModerationActionType,
  ModerationTargetType,
  ReportReason,
  ReportSource,
  ReportStatus,
  ReportTargetType,
} from '@prisma/client';
import {
  DEFAULT_QUEUE_LIMIT,
  MAX_QUEUE_LIMIT,
  MAX_REASON_LENGTH,
} from './moderation.config';

/**
 * Zod schemas for the Moderation module.
 *
 * Body schemas go through the shared `validateRequest` middleware; query
 * schemas are parsed in the controller with a local helper, because Express 5
 * makes `req.query` a read-only getter and a parse-and-assign middleware cannot
 * work on it. Every other list-serving module in this codebase does the same.
 *
 * Two things this file is deliberately strict about:
 *
 *   TARGET IDS   are pattern-checked, not merely non-empty. A `targetId` is
 *                carried in a polymorphic column with no foreign key behind it,
 *                so nothing downstream would reject a 4KB string or a shell
 *                fragment — it would simply be stored and later handed to
 *                another module. Bounding it here is the only place it happens.
 *
 *   ENUMS        are the Prisma enums themselves, never re-declared string
 *                unions. A hand-copied list is a list that silently disagrees
 *                with the database the first time either side gains a value.
 */

/**
 * An entity id as this platform mints them (cuid). Bounded and charset-limited:
 * the pattern admits every cuid the database produces and nothing that looks
 * like an injection payload or a denial-of-service-by-length attempt.
 */
const entityId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');

const freeText = z.string().trim().min(1).max(MAX_REASON_LENGTH);

/**
 * A comma-separated list of enum values (`?status=PENDING,REVIEWING`).
 *
 * Repeated query keys are avoided for the reason the Dashboard module documents:
 * Express parses one value as a string and two as an array, so every consumer
 * would need to normalize, and a one-element request would take a different
 * code path from a two-element one.
 *
 * An unknown value is a 400 rather than a silent drop — a client asking for a
 * status that does not exist has a bug, and answering with a filtered list that
 * quietly ignores part of the request turns that bug into a mystery.
 */
function csvEnum<T extends string>(allowed: readonly T[], label: string) {
  const permitted = new Set<string>(allowed);

  return z.string().transform((raw, ctx): T[] => {
    const values = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    if (values.length === 0) {
      ctx.addIssue({ code: 'custom', message: `${label} must name at least one value` });
      return z.NEVER;
    }

    const unknown = values.filter((value) => !permitted.has(value));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          `Unknown ${label}: ${unknown.join(', ')}. ` +
          `Expected one of: ${allowed.join(', ')}`,
      });
      return z.NEVER;
    }

    // Deduped so `?status=PENDING,PENDING` produces the same filter — and the
    // same cursor fingerprint — as `?status=PENDING`.
    return [...new Set(values)] as T[];
  });
}

/**
 * Sort direction, expressed in the queue's vocabulary rather than SQL's.
 *
 * `oldest` is the default because this is a WORK queue: the report that has
 * waited longest is the one that most needs a decision, and a newest-first
 * default quietly starves the backlog.
 */
const sortSchema = z
  .enum(['oldest', 'newest'])
  .default('oldest')
  .transform((value) => (value === 'oldest' ? ('asc' as const) : ('desc' as const)));

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_QUEUE_LIMIT)
  .default(DEFAULT_QUEUE_LIMIT);

const cursorSchema = z.string().min(1).max(512).optional();

/** A date range, validated as a range rather than as two independent dates. */
const dateRange = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

const assertRangeOrder = (
  data: { from?: Date; to?: Date },
  ctx: z.RefinementCtx
): void => {
  if (data.from && data.to && data.from > data.to) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: '`from` must not be after `to`' });
  }
};

// ---------------------------------------------------------------------------
// Reporting (user-facing)
// ---------------------------------------------------------------------------

/**
 * A report submission.
 *
 * There is no `reporterId` field, and there never will be: the reporter is the
 * authenticated caller. A schema that accepted one would be a schema that lets a
 * client file reports in someone else's name.
 */
export const createReportSchema = z.object({
  targetType: z.enum(ReportTargetType),
  targetId: entityId,
  reason: z.enum(ReportReason),
  description: freeText.optional(),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

// ---------------------------------------------------------------------------
// Queue (moderator-facing)
// ---------------------------------------------------------------------------

export const reportQuerySchema = z
  .object({
    status: csvEnum(Object.values(ReportStatus), 'status').optional(),
    targetType: z.enum(ReportTargetType).optional(),
    reason: z.enum(ReportReason).optional(),
    source: z.enum(ReportSource).optional(),
    /** Filter to one moderator's claimed reports. */
    assignedTo: entityId.optional(),
    /** Filter to everything reported about one account's content. */
    targetOwner: entityId.optional(),
    ...dateRange,
    sort: sortSchema,
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .superRefine(assertRangeOrder);
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/**
 * The note attached when a report is closed.
 *
 * Optional, and deliberately so: requiring a rationale on every dismissal
 * sounds rigorous but produces a queue full of "n/a". The audit row records WHO
 * closed it and WHEN regardless, which is the part that has to be true.
 */
export const resolveReportSchema = z.object({
  reason: freeText.optional(),
});
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;

// ---------------------------------------------------------------------------
// Actions (moderator-facing)
// ---------------------------------------------------------------------------

/**
 * The body of a moderation action.
 *
 * `reportId` links the action to the report that prompted it: the action is
 * performed, audited, and then that report is closed — one round trip for what
 * is conceptually one decision. Omitted, the action is a direct one a moderator
 * took without a report behind it, which is equally legitimate and equally
 * audited.
 */
export const moderationActionSchema = z.object({
  reason: freeText.optional(),
  reportId: entityId.optional(),
});
export type ModerationActionInput = z.infer<typeof moderationActionSchema>;

// ---------------------------------------------------------------------------
// History (admin-facing)
// ---------------------------------------------------------------------------

export const auditQuerySchema = z
  .object({
    action: z.enum(ModerationActionType).optional(),
    actorId: entityId.optional(),
    targetType: z.enum(ModerationTargetType).optional(),
    targetId: entityId.optional(),
    subjectUserId: entityId.optional(),
    reportId: entityId.optional(),
    ...dateRange,
    // History reads newest-first: unlike the queue, nobody is working through
    // it front to back — they are asking "what just happened".
    sort: z
      .enum(['oldest', 'newest'])
      .default('newest')
      .transform((value) => (value === 'oldest' ? ('asc' as const) : ('desc' as const))),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .superRefine(assertRangeOrder);
export type AuditQuery = z.infer<typeof auditQuerySchema>;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const idParamSchema = z.object({ id: entityId });
export type IdParam = z.infer<typeof idParamSchema>;

/**
 * A content target named in a URL (`/content/:targetType/:targetId`).
 *
 * Only the CONTENT types: an account's moderation view has its own endpoint,
 * because what it shows (suspension state, counts, history across everything
 * they own) has almost nothing in common with a blog's.
 */
export const contentTargetParamSchema = z.object({
  targetType: z.enum(['BLOG', 'COMMENT']),
  targetId: entityId,
});
export type ContentTargetParam = z.infer<typeof contentTargetParamSchema>;
