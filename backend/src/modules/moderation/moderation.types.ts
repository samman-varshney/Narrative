import type {
  ModerationActionType,
  ModerationTargetType,
  ReportReason,
  ReportSource,
  ReportStatus,
  ReportTargetType,
  Role,
  UserStatus,
} from '@prisma/client';

/**
 * The Moderation module's wire contract.
 *
 * Every administrative endpoint returns these shapes, never a Prisma model.
 * That is not ceremony: a Prisma row would put `passwordHash` one careless
 * `include` away from an admin response, it would leak column renames to
 * clients, and it would make the polymorphic target (which is assembled from
 * three different modules) impossible to type at all.
 */

/** The authenticated actor. Always derived from the access token. */
export interface ModerationActor {
  userId: string;
  role: string;
}

/**
 * The minimum identity needed to render a person in an administrative list.
 *
 * Deliberately the PUBLIC profile fields and nothing more. A moderator judging a
 * report does not need the reporter's email, and an admin surface is exactly
 * where an over-wide DTO does the most damage.
 */
export interface UserCardDTO {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  role: Role;
  status: UserStatus;
  isVerified: boolean;
}

/** A blog as an administrative surface renders it. */
export interface BlogTargetDTO {
  kind: 'BLOG';
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  /** Bounded plain-text prefix of the body — never the content JSON. */
  excerpt: string;
  status: string;
  visibility: string;
  isHidden: boolean;
  hiddenAt: Date | null;
  author: UserCardDTO | null;
  publishedAt: Date | null;
  createdAt: Date;
}

/** A comment as an administrative surface renders it. */
export interface CommentTargetDTO {
  kind: 'COMMENT';
  id: string;
  blogId: string;
  /** The RAW text, not the reader-facing tombstone: moderators judge what was written. */
  content: string;
  isHidden: boolean;
  hiddenAt: Date | null;
  isDeleted: boolean;
  author: UserCardDTO | null;
  createdAt: Date;
}

/** A reported account. */
export interface UserTargetDTO {
  kind: 'USER';
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  role: Role;
  status: UserStatus;
  isVerified: boolean;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  createdAt: Date;
  counts: { blogs: number; comments: number; followers: number };
}

/**
 * A target that no longer resolves.
 *
 * The polymorphic `targetId` carries no foreign key (see the schema notes), so a
 * hard-deleted target is possible. Rendering it as an explicit "unavailable"
 * shape is what keeps a report detail page a 200 with a clear message rather
 * than a 500 or a silently blank panel.
 */
export interface MissingTargetDTO {
  kind: 'MISSING';
  id: string;
  targetType: ReportTargetType;
}

export type ReportTargetDTO =
  | BlogTargetDTO
  | CommentTargetDTO
  | UserTargetDTO
  | MissingTargetDTO;

/** A report as it appears in the queue: no target body, so a page stays cheap. */
export interface ReportListItemDTO {
  id: string;
  source: ReportSource;
  status: ReportStatus;
  reason: ReportReason;
  description: string | null;
  targetType: ReportTargetType;
  targetId: string;
  targetOwner: UserCardDTO | null;
  reporter: UserCardDTO | null;
  assignedTo: UserCardDTO | null;
  assignedAt: Date | null;
  resolvedBy: UserCardDTO | null;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  /** Provider signals for AUTOMATED reports; null for human ones. */
  signals: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A report opened for review: the queue row, plus everything needed to decide. */
export interface ReportDetailDTO extends ReportListItemDTO {
  target: ReportTargetDTO;
  /** Other OPEN reports about the same target — the "is this a pile-on" signal. */
  relatedOpenReports: number;
  /** What has already been done about this report. */
  history: ModerationActionDTO[];
}

/** One row of the append-only audit log. */
export interface ModerationActionDTO {
  id: string;
  action: ModerationActionType;
  targetType: ModerationTargetType;
  targetId: string;
  actor: UserCardDTO | null;
  subjectUserId: string | null;
  reportId: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/** A cursor page of administrative rows. */
export interface ModerationPage<T> {
  items: T[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

/** The administrative landing payload. */
export interface ModerationOverviewDTO {
  queue: {
    pending: number;
    reviewing: number;
    /** Oldest still-open report, so "how far behind are we" is answerable. */
    oldestOpenAt: Date | null;
  };
  /** Open reports grouped by reason — what the platform is being flagged for. */
  openByReason: { reason: ReportReason; count: number }[];
  /** Open reports grouped by what was reported. */
  openByTargetType: { targetType: ReportTargetType; count: number }[];
  /** Moderator throughput over the configured window, by action. */
  activity: { action: ModerationActionType; count: number }[];
  activityWindowDays: number;
  recentActions: ModerationActionDTO[];
}

/** What a moderation-facing view of one user answers. */
export interface UserModerationDTO {
  user: UserTargetDTO;
  /** Open reports about this account or anything it owns. */
  openReports: number;
  history: ModerationActionDTO[];
}

/** What a moderation-facing view of one piece of content answers. */
export interface ContentModerationDTO {
  target: ReportTargetDTO;
  openReports: number;
  history: ModerationActionDTO[];
}
