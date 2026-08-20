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
  createdAt: true,
  updatedAt: true,
  author: { select: blogAuthorSelect },
} satisfies Prisma.CommentSelect;

export type CommentRow = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;

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

  /** Admin moderation — hide / unhide a comment (kept in the tree either way). */
  setHidden(id: string, isHidden: boolean): Promise<CommentRow> {
    return prisma.comment.update({
      where: { id },
      data: { isHidden },
      select: commentSelect,
    });
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
}

export const commentRepository = new CommentRepository();
