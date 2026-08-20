import type { ExportStatus } from '@prisma/client';

/**
 * The export document — the shape of the JSON a user downloads.
 *
 * Every section is produced by the module that OWNS that data, through a
 * `collectForExport` method on its service. This module composes; it does not
 * query another module's tables. That is what keeps "what does Blog own" a
 * question with one answer, and it is why adding a new section here means
 * adding a method there rather than a join in this module.
 */
export interface ExportDocument {
  meta: ExportMeta;
  account: unknown;
  blogs: unknown;
  comments: unknown;
  bookmarks: unknown;
  follows: unknown;
  notifications: unknown;
  media: unknown;
  analytics: unknown;
  sessions: unknown;
}

export interface ExportMeta {
  /** Schema version of this document. */
  formatVersion: number;
  exportId: string;
  userId: string;
  generatedAt: string;
  /**
   * Collections that hit `EXPORT_MAX_ROWS_PER_COLLECTION`, named so a reader can
   * tell a genuinely empty section from a capped one. Empty in the normal case.
   */
  truncated: string[];
  /**
   * What this export deliberately does NOT contain, in plain language. Present
   * so the absence of a section reads as a decision rather than a bug.
   */
  excluded: string[];
}

/** The request as the API reports it. Never carries the artifact bytes. */
export interface ExportRequestDTO {
  id: string;
  status: ExportStatus;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  downloadCount: number;
  error: string | null;
  /** Convenience for clients: READY, and not yet past `expiresAt`. */
  downloadable: boolean;
}

/** The payload carried on the export queue. */
export interface ExportJobData {
  exportId: string;
  userId: string;
}
