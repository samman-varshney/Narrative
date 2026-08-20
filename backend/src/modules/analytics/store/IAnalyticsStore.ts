import type { BlogDailyDelta, UserDailyDelta } from '../analytics.types';

/**
 * The durable write side of analytics.
 *
 * Separate from `AnalyticsRepository` (the read side) on purpose. The two have
 * nothing in common beyond the tables they touch: this one takes batches of
 * deltas from a background worker and must be idempotent and fast in bulk; that
 * one takes a date range from an HTTP request and must be selective and
 * indexed. Merging them produces a class where half the methods are unreachable
 * from either caller.
 *
 * It is also the seam that a warehouse migration replaces. Sending aggregates to
 * ClickHouse instead of PostgreSQL means one new implementation of this
 * interface; the flush worker above it does not change, and neither does
 * anything upstream of the flush worker.
 *
 * ── Contract ────────────────────────────────────────────────────────────────
 * `upsert*` MUST be additive for counters and MUST tolerate being called twice
 * with the same batch without corrupting a row beyond the double-count — the
 * flush's retry path depends on it. Implementations MAY throw; the caller is
 * a retrying job and handles it.
 */
export interface IAnalyticsStore {
  /**
   * Adds a batch of per-blog daily deltas.
   *
   * Every field is ADDED to the stored row except `uniqueViews`, which is a
   * day-to-date absolute from a HyperLogLog and is therefore taken as the
   * greater of stored and incoming. Adding it would multiply the number by the
   * count of flushes in the day.
   */
  upsertBlogDaily(rows: BlogDailyDelta[]): Promise<number>;

  /** Adds a batch of per-user daily deltas. All fields are additive. */
  upsertUserDaily(rows: UserDailyDelta[]): Promise<number>;

  /**
   * Deletes aggregate rows older than `before`. Returns rows removed.
   * Bounded per call so retention never issues an unbounded DELETE.
   */
  pruneBefore(before: Date, limit: number): Promise<{ blogRows: number; userRows: number }>;
}
