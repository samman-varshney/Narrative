import type { ModerationAction, Prisma, Report } from '@prisma/client';
import type {
  ModerationActionDTO,
  ReportListItemDTO,
  UserCardDTO,
} from './moderation.types';

/**
 * Row → DTO. Pure functions, no I/O.
 *
 * Every administrative response passes through here, which is what keeps a
 * Prisma model from reaching a client: the mapping is explicit, so a column
 * added to `Report` tomorrow does not silently appear on the wire, and a
 * relation someone `include`s does not either.
 *
 * The user cards arrive as a pre-loaded Map rather than being fetched per row —
 * see `moderation.hydration.ts` for why that boundary is where it is.
 */

/** Narrows Prisma's JSON type to the object shape the DTOs declare. */
function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toReportListItem(
  report: Report,
  users: Map<string, UserCardDTO>
): ReportListItemDTO {
  return {
    id: report.id,
    source: report.source,
    status: report.status,
    reason: report.reason,
    description: report.description,
    targetType: report.targetType,
    targetId: report.targetId,
    targetOwner: report.targetOwnerId ? (users.get(report.targetOwnerId) ?? null) : null,
    reporter: report.reporterId ? (users.get(report.reporterId) ?? null) : null,
    assignedTo: report.assignedToId ? (users.get(report.assignedToId) ?? null) : null,
    assignedAt: report.assignedAt,
    resolvedBy: report.resolvedById ? (users.get(report.resolvedById) ?? null) : null,
    resolvedAt: report.resolvedAt,
    resolutionReason: report.resolutionReason,
    signals: asRecord(report.metadata),
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

export function toModerationActionDTO(
  action: ModerationAction,
  users: Map<string, UserCardDTO>
): ModerationActionDTO {
  return {
    id: action.id,
    action: action.action,
    targetType: action.targetType,
    targetId: action.targetId,
    actor: users.get(action.actorId) ?? null,
    subjectUserId: action.subjectUserId,
    reportId: action.reportId,
    reason: action.reason,
    metadata: asRecord(action.metadata),
    createdAt: action.createdAt,
  };
}

/** Every user id a page of reports refers to, for one batched lookup. */
export function userIdsOfReports(reports: Report[]): string[] {
  const ids: string[] = [];
  for (const report of reports) {
    if (report.reporterId) ids.push(report.reporterId);
    if (report.targetOwnerId) ids.push(report.targetOwnerId);
    if (report.assignedToId) ids.push(report.assignedToId);
    if (report.resolvedById) ids.push(report.resolvedById);
  }
  return ids;
}

/** Every user id a page of audit rows refers to. */
export function userIdsOfActions(actions: ModerationAction[]): string[] {
  const ids: string[] = [];
  for (const action of actions) {
    ids.push(action.actorId);
    if (action.subjectUserId) ids.push(action.subjectUserId);
  }
  return ids;
}
