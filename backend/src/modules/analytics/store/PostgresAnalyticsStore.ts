import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma';
import type { BlogDailyDelta, UserDailyDelta } from '../analytics.types';
import type { IAnalyticsStore } from './IAnalyticsStore';

/**
 * PostgreSQL implementation of the analytics write store.
 *
 * ── One statement per batch ─────────────────────────────────────────────────
 * Both upserts build a single multi-row `INSERT ... ON CONFLICT DO UPDATE`. The
 * obvious alternative — `prisma.blogAnalyticsDaily.upsert()` in a loop — issues
 * one round trip per row and takes one lock per round trip, which is the
 * database contention this whole module was built to avoid: a 500-bucket flush
 * would hold the connection for 500 sequential statements while Express waits
 * behind it on the same pool.
 *
 * ── Why raw SQL and not Prisma's API ───────────────────────────────────────
 * Prisma cannot express `ON CONFLICT DO UPDATE SET col = table.col +
 * EXCLUDED.col` — `upsert` can increment, but only one row at a time, and
 * `createMany` with `skipDuplicates` DISCARDS the conflicting row instead of
 * folding it in, which would silently drop every flush after a bucket's first.
 * Parameters are still bound through `Prisma.sql`, so nothing here is
 * string-interpolated.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * These writes are additive, so they are NOT idempotent by themselves — running
 * the same batch twice doubles the counters. That property is provided one layer
 * up instead: a bucket is claimed atomically out of Redis by exactly one flush
 * (see `AnalyticsBuffer.drain`), so a batch can only be replayed if the same
 * worker retries it, and the retry path re-drains rather than re-sending. The
 * absolute `uniqueViews` column is idempotent by construction via `GREATEST`.
 */
export class PostgresAnalyticsStore implements IAnalyticsStore {
  async upsertBlogDaily(rows: BlogDailyDelta[]): Promise<number> {
    if (rows.length === 0) return 0;

    const values = Prisma.join(
      rows.map(
        (row) => Prisma.sql`(
          ${row.blogId},
          ${row.authorId},
          ${row.date}::date,
          ${row.views},
          ${row.uniqueViews},
          ${row.readStarts},
          ${row.readCompletions},
          ${row.totalReadingSeconds},
          ${row.bookmarks},
          ${row.unbookmarks},
          ${row.comments},
          NOW(),
          NOW()
        )`
      )
    );

    return prisma.$executeRaw`
      INSERT INTO "BlogAnalyticsDaily" (
        "blogId", "authorId", "date",
        "views", "uniqueViews", "readStarts", "readCompletions",
        "totalReadingSeconds", "bookmarks", "unbookmarks", "comments",
        "createdAt", "updatedAt"
      )
      VALUES ${values}
      ON CONFLICT ("blogId", "date") DO UPDATE SET
        "views"               = "BlogAnalyticsDaily"."views" + EXCLUDED."views",
        -- Absolute, not additive: see the class doc and BlogDailyDelta.
        "uniqueViews"         = GREATEST("BlogAnalyticsDaily"."uniqueViews", EXCLUDED."uniqueViews"),
        "readStarts"          = "BlogAnalyticsDaily"."readStarts" + EXCLUDED."readStarts",
        "readCompletions"     = "BlogAnalyticsDaily"."readCompletions" + EXCLUDED."readCompletions",
        "totalReadingSeconds" = "BlogAnalyticsDaily"."totalReadingSeconds" + EXCLUDED."totalReadingSeconds",
        "bookmarks"           = "BlogAnalyticsDaily"."bookmarks" + EXCLUDED."bookmarks",
        "unbookmarks"         = "BlogAnalyticsDaily"."unbookmarks" + EXCLUDED."unbookmarks",
        "comments"            = "BlogAnalyticsDaily"."comments" + EXCLUDED."comments",
        -- Re-asserted so a row written before an (impossible today) author
        -- change would still converge rather than keep a stale owner forever.
        "authorId"            = EXCLUDED."authorId",
        "updatedAt"           = NOW()
    `;
  }

  async upsertUserDaily(rows: UserDailyDelta[]): Promise<number> {
    if (rows.length === 0) return 0;

    const values = Prisma.join(
      rows.map(
        (row) => Prisma.sql`(
          ${row.userId},
          ${row.date}::date,
          ${row.followersGained},
          ${row.followersLost},
          ${row.blogsPublished},
          NOW(),
          NOW()
        )`
      )
    );

    return prisma.$executeRaw`
      INSERT INTO "UserAnalyticsDaily" (
        "userId", "date",
        "followersGained", "followersLost", "blogsPublished",
        "createdAt", "updatedAt"
      )
      VALUES ${values}
      ON CONFLICT ("userId", "date") DO UPDATE SET
        "followersGained" = "UserAnalyticsDaily"."followersGained" + EXCLUDED."followersGained",
        "followersLost"   = "UserAnalyticsDaily"."followersLost"   + EXCLUDED."followersLost",
        "blogsPublished"  = "UserAnalyticsDaily"."blogsPublished"  + EXCLUDED."blogsPublished",
        "updatedAt"       = NOW()
    `;
  }

  /**
   * Deletes aggregate rows older than `before`.
   *
   * Bounded by `limit` per table and per call. An unbounded `DELETE FROM ...
   * WHERE date < x` on a table holding years of rows takes a long transaction
   * and a lot of locks the first time it ever runs; chunking keeps each prune
   * short and lets the job simply run again to finish. The `ctid` subquery is
   * how a `LIMIT` is applied to a `DELETE` in PostgreSQL, which has no
   * `DELETE ... LIMIT`.
   *
   * The `date` predicate is REPEATED on the outer delete. It is redundant
   * logically — the subquery already selected only old rows — but not to the
   * planner: with the `ctid IN (...)` condition alone, the outer delete has no
   * indexable predicate and sequentially scans the whole table to find the rows
   * the subquery just identified. Repeating it lets both halves use
   * `@@index([date])`, which is the difference between a full scan and a range
   * scan every night, on the table that grows forever.
   */
  async pruneBefore(
    before: Date,
    limit: number
  ): Promise<{ blogRows: number; userRows: number }> {
    const cutoff = before.toISOString().slice(0, 10);

    const blogRows = await prisma.$executeRaw`
      DELETE FROM "BlogAnalyticsDaily"
      WHERE "date" < ${cutoff}::date
        AND ctid IN (
          SELECT ctid FROM "BlogAnalyticsDaily"
          WHERE "date" < ${cutoff}::date
          LIMIT ${limit}
        )
    `;

    const userRows = await prisma.$executeRaw`
      DELETE FROM "UserAnalyticsDaily"
      WHERE "date" < ${cutoff}::date
        AND ctid IN (
          SELECT ctid FROM "UserAnalyticsDaily"
          WHERE "date" < ${cutoff}::date
          LIMIT ${limit}
        )
    `;

    return { blogRows, userRows };
  }
}

export const analyticsStore: IAnalyticsStore = new PostgresAnalyticsStore();
