import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import type { CursorPagination } from '../../core/utils/pagination';
import { blogAuthorSelect } from '../blog/blog.repository';

/**
 * Canonical projection for a single comment row. Embeds the shared public-author
 * projection so the author loads in the SAME query (no N+1 across a page/tree).
 */
export const commentSelect = {
  id: true,
  content: true,
  blogId: true,
  authorId: true,
  parentId: true,
  depth: true,
  path: true,
  isEdited: true,
  editedAt: true,
  deletedAt: true,
  isHidden: true,
  hiddenAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: blogAuthorSelect },
} satisfies Prisma.CommentSelect;

export type CommentRow = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;

/**
 * `commentSelect` plus the blog the comment sits on.
 *
 * Exists for the author-scoped read below, whose consumers (the author's
 * dashboard) need a deep link to the blog that was commented on. Kept as a
 * separate projection rather than widening `commentSelect`, so the thread and
 * feed paths — which already know their blog — do not start joining `Blog` on
 * every row they load.
 */
export const receivedCommentSelect = {
  ...commentSelect,
  blog: { select: { id: true, title: true, slug: true } },
} satisfies Prisma.CommentSelect;

export type ReceivedCommentRow = Prisma.CommentGetPayload<{
  select: typeof receivedCommentSelect;
}>;

/** Options for the author-scoped read. */
export interface ReceivedCommentsQuery {
  /** Hard cap on rows returned. Bounded by the caller. */
  limit: number;
  /**
   * Oldest `createdAt` to consider. REQUIRED, not optional: it is what keeps
   * the query's cost proportional to recent activity instead of to the
   * author's entire comment history. See `dashboard_indexes.sql`.
   */
  since: Date;
}

/** Write payload for a new comment. `depth`/`parentPath` are computed by the service. */
export interface CreateCommentData {
  blogId: string;
  authorId: string;
  content: string;
  parentId: string | null;
  depth: number;
  /** Materialized path of the parent (empty for top-level); the new id is appended. */
  parentPath: string;
}

export class CommentRepository {
  // ---- Writes ----

  /**
   * Inserts a comment and finalizes its materialized `path` (which needs the
   * generated id). Done in one transaction so a row is never observable without
   * its path set.
   */
  async create(data: CreateCommentData): Promise<CommentRow> {
    return prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: {
          blogId: data.blogId,
          authorId: data.authorId,
          content: data.content,
          parentId: data.parentId,
          depth: data.depth,
        },
        select: { id: true },
      });
      const path = data.parentPath ? `${data.parentPath}/${created.id}` : created.id;
      return tx.comment.update({
        where: { id: created.id },
        data: { path },
        select: commentSelect,
      });
    });
  }

  /** Edits content, marking the comment as edited. */
  update(id: string, content: string): Promise<CommentRow> {
    return prisma.comment.update({
      where: { id },
      data: { content, isEdited: true, editedAt: new Date() },
      select: commentSelect,
    });
  }

  /** Soft delete — keeps the row (and its subtree) as a tombstone in the tree. */
  softDelete(id: string): Promise<CommentRow> {
    return prisma.comment.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: commentSelect,
    });
  }

  /** Admin restore — clears the soft-delete tombstone. */
  restore(id: string): Promise<CommentRow> {
    return prisma.comment.update({
      where: { id },
      data: { deletedAt: null },
      select: commentSelect,
    });
  }

  /**
   * Moderation hide / unhide, as a CONDITIONAL update (kept in the tree either
   * way — the tombstone keeps replies visible).
   *
   * Returns whether this call changed the row, so two moderators acting on the
   * same queue entry produce one hide, one audit record and one notification
   * rather than two of each. Same technique as `blogRepository.setModerationHidden`.
   */
  async setModerationHidden(id: string, hidden: boolean): Promise<boolean> {
    const result = await prisma.comment.updateMany({
      where: { id, isHidden: !hidden },
      data: { isHidden: hidden, hiddenAt: hidden ? new Date() : null },
    });
    return result.count === 1;
  }

  /**
   * Moderation delete: soft-deletes unless already deleted. Conditional, as above.
   *
   * Sets `isHidden` alongside the tombstone, exactly as `blogRepository`
   * .moderationDelete does and for the same two reasons: it is what stops the
   * author mutating a removed comment, and the pair `deletedAt AND isHidden` is
   * what marks the removal as MODERATION's rather than the author's — the only
   * thing a later restore has to go on, since no column records who deleted it.
   */
  async moderationDelete(id: string): Promise<boolean> {
    const result = await prisma.comment.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date(), isHidden: true, hiddenAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * Moderation restore: lifts the hide, and — when `revive` is set — clears a
   * moderation removal's tombstone in the same write.
   *
   * Conditional in both shapes, each naming the full state it expects, so a
   * restore that races another moderator's action loses cleanly (0 rows) rather
   * than clearing half of it. Mirrors `blogRepository.moderationRestore`.
   */
  async moderationRestore(id: string, opts: { revive: boolean }): Promise<boolean> {
    const result = await prisma.comment.updateMany({
      where: opts.revive
        ? { id, isHidden: true, deletedAt: { not: null } }
        : { id, isHidden: true, deletedAt: null },
      data: {
        isHidden: false,
        hiddenAt: null,
        ...(opts.revive && { deletedAt: null }),
      },
    });
    return result.count === 1;
  }

  // ---- Reads ----

  findById(id: string): Promise<CommentRow | null> {
    return prisma.comment.findUnique({ where: { id }, select: commentSelect });
  }

  /**
   * Cursor page of a blog's top-level comments (parentId IS NULL), oldest-first
   * for stable threaded ordering. Tombstones are included so their subtrees
   * still render. Fetches `limit + 1` to derive `hasNextPage`.
   */
  findTopLevel(blogId: string, { cursor, limit }: CursorPagination): Promise<CommentRow[]> {
    return prisma.comment.findMany({
      where: { blogId, parentId: null },
      select: commentSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  /**
   * All direct children of any of `parentIds`, in stable order. This is the
   * single query issued per BFS level when building a subtree — bounding total
   * queries to the max depth rather than the comment count (no N+1).
   */
  findChildrenByParentIds(parentIds: string[]): Promise<CommentRow[]> {
    if (parentIds.length === 0) return Promise.resolve([]);
    return prisma.comment.findMany({
      where: { parentId: { in: parentIds } },
      select: commentSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Cursor page of one comment's direct children (lazy `/replies` expansion). */
  findReplies(
    parentId: string,
    { cursor, limit }: CursorPagination
  ): Promise<CommentRow[]> {
    return prisma.comment.findMany({
      where: { parentId },
      select: commentSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  /** Number of direct replies to a comment. */
  countReplies(parentId: string): Promise<number> {
    return prisma.comment.count({ where: { parentId } });
  }

  /**
   * Direct-reply counts for many parents in ONE grouped query — used to annotate
   * a page of comments in lazy mode without a per-row count (no N+1).
   */
  async countRepliesFor(parentIds: string[]): Promise<Map<string, number>> {
    if (parentIds.length === 0) return new Map();
    const groups = await prisma.comment.groupBy({
      by: ['parentId'],
      where: { parentId: { in: parentIds } },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const g of groups) {
      if (g.parentId) counts.set(g.parentId, g._count._all);
    }
    return counts;
  }

  /** Total non-deleted comments on a blog (tombstones excluded from the tally). */
  countBlogComments(blogId: string): Promise<number> {
    return prisma.comment.count({ where: { blogId, deletedAt: null } });
  }

  /**
   * Non-deleted comment counts for many blogs in ONE grouped query.
   *
   * The batched sibling of `countBlogComments`, added for feed pages: a card
   * shows a comment count, and a page of fifty cards must not become fifty
   * counts. Blogs with no comments are ABSENT from the map — a caller reads
   * that as zero, which is what it means, and avoids materializing a row per
   * blog that nobody has commented on.
   */
  async countForBlogs(blogIds: string[]): Promise<Map<string, number>> {
    if (blogIds.length === 0) return new Map();
    const groups = await prisma.comment.groupBy({
      by: ['blogId'],
      where: { blogId: { in: blogIds }, deletedAt: null },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.blogId, g._count._all]));
  }

  /**
   * Comments other people left on blogs written by `authorId`, newest first.
   *
   * The author-facing counterpart to `findTopLevel`: that one answers "what was
   * said on this blog", this one answers "what was said to me". Replies are
   * included — a reply on the author's post is still audience engagement, and
   * the tree position is irrelevant to a notification-shaped list.
   *
   * Four filters, each load-bearing:
   *   - `b."authorId"` scopes ownership, joined in SQL rather than by fetching
   *     blog ids and sending them back in an `IN (...)` — an N+1 in two steps,
   *     and unbounded for a prolific author.
   *   - `c."authorId" <> $author` drops the author's own replies. Answering
   *     your own thread is participation, not audience activity — the same line
   *     the analytics `comments` counter draws.
   *   - `deletedAt` / `isHidden` drop tombstones. A thread view renders those so
   *     replies stay attached; a flat activity list has nothing to keep attached
   *     and would just be showing the author a moderator's work.
   *
   * ── Why LATERAL, and why raw SQL ─────────────────────────────────────────
   * The obvious Prisma version — filter by relation, order, limit — makes
   * Postgres materialize EVERY qualifying comment on every one of the author's
   * blogs and then top-N sort the lot. For a typical author that is 400 rows and
   * nobody notices. For a prolific one it is the whole corpus: measured at
   * 90,000 rows and **403 ms**, and no index can help, because an ordering
   * across many blogs cannot be read from a per-blog index without a merge the
   * planner will not perform under a nested loop.
   *
   * The LATERAL asks the right question instead: the newest `limit` comments
   * PER BLOG, then the newest `limit` of those. It cannot miss a row — a comment
   * outside its own blog's top `limit` cannot be in the global top `limit` — and
   * it caps the work at `blogs x limit` rows. Same measurement: **42 ms**, a
   * ~10x improvement, and it is what makes `comment_author_activity_idx` earn
   * its keep (the per-blog scan stops after `limit` index entries instead of
   * sorting the blog's entire history).
   *
   * Prisma cannot express LATERAL, hence raw SQL — the same reason the
   * Analytics, Search and Feed repositories carry it. Every value is BOUND, never
   * interpolated.
   *
   * ── Why two queries ──────────────────────────────────────────────────────
   * The raw query selects IDS only; the projection is a second, keyed Prisma
   * read. That keeps the part where the query PLAN matters in SQL and the part
   * where TYPES matter in Prisma, instead of hand-mapping a dozen columns and an
   * author join into an untyped row. The second query is a primary-key lookup of
   * at most `limit` ids — microseconds, and it cannot reintroduce an N+1.
   *
   * The `id` tiebreaker makes the ordering total, so two comments written in the
   * same millisecond cannot swap places between two reads.
   */
  async findReceivedByAuthor(
    authorId: string,
    { limit, since }: ReceivedCommentsQuery
  ): Promise<ReceivedCommentRow[]> {
    const ranked = await prisma.$queryRaw<{ id: string }[]>`
      SELECT x."id"
      FROM "Blog" b
      CROSS JOIN LATERAL (
        SELECT c."id", c."createdAt"
        FROM "Comment" c
        WHERE c."blogId" = b."id"
          AND c."deletedAt" IS NULL
          AND c."isHidden" = false
          AND c."authorId" <> ${authorId}
          AND c."createdAt" >= ${since}
        ORDER BY c."createdAt" DESC, c."id" DESC
        LIMIT ${limit}
      ) x
      WHERE b."authorId" = ${authorId}
      ORDER BY x."createdAt" DESC, x."id" DESC
      LIMIT ${limit}
    `;

    if (ranked.length === 0) return [];

    const rows = await prisma.comment.findMany({
      where: { id: { in: ranked.map((row) => row.id) } },
      select: receivedCommentSelect,
    });

    // `IN (...)` returns no defined order, so the ranking's order is reapplied
    // here rather than re-sorted: the ordering decision belongs to the query
    // that made it, and re-deriving it would be a second implementation of the
    // same rule.
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ranked
      .map((row) => byId.get(row.id))
      .filter((row): row is ReceivedCommentRow => row !== undefined);
  }
}

export const commentRepository = new CommentRepository();
