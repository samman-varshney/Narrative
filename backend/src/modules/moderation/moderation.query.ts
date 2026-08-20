import type { Prisma } from '@prisma/client';
import type { CursorPosition } from './moderation.cursor';

/**
 * Keyset primitives shared by the two administrative lists.
 *
 * Both the report queue and the audit log are ordered by `(createdAt, id)` and
 * paged the same way, so the predicate that expresses "strictly after this
 * position" is written once. Two hand-rolled copies of a compound keyset is how
 * one of them ends up with `>` where the other has `>=` and starts repeating a
 * row per page — the kind of bug that only shows up when two rows share a
 * timestamp.
 */

export type SortDirection = 'asc' | 'desc';

/**
 * The compound comparison `(createdAt, id) > (t, i)` — or `<` for descending —
 * expressed the way Prisma can build it.
 *
 * Written as an OR of two clauses rather than Prisma's tuple `cursor`, because
 * `cursor` seeks by primary key and would need `skip: 1`, which is correct only
 * while the row it names still exists. A report can be deleted (a reporter's
 * account is erased and the row cascades) between two pages, and then the cursor
 * row is gone and the page silently restarts from the top. A value comparison
 * has no such dependency: it describes a position, not a row.
 */
export function keysetWhere(
  position: CursorPosition,
  direction: SortDirection
): Prisma.ReportWhereInput & Prisma.ModerationActionWhereInput {
  const op = direction === 'asc' ? 'gt' : 'lt';
  return {
    OR: [
      { createdAt: { [op]: position.createdAt } },
      { createdAt: position.createdAt, id: { [op]: position.id } },
    ],
  } as Prisma.ReportWhereInput & Prisma.ModerationActionWhereInput;
}

/** `ORDER BY createdAt <dir>, id <dir>` — total, so the keyset above is exact. */
export function keysetOrderBy(direction: SortDirection) {
  return [{ createdAt: direction }, { id: direction }] as const;
}

/**
 * Splits a `limit + 1` row fetch into a page and its continuation.
 *
 * The extra row is how "is there more" is answered without a second COUNT — the
 * same technique `core/utils/pagination` uses. Not reusing that helper because
 * its cursor is a bare row id, and these lists need the `(createdAt, id)` pair.
 */
export function splitPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number
): { items: T[]; hasNextPage: boolean; last: T | null } {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  return { items, hasNextPage, last: items.length > 0 ? items[items.length - 1]! : null };
}
