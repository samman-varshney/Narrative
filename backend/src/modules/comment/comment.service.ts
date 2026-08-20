import {
  commentRepository,
  CommentRow,
  ReceivedCommentRow,
} from './comment.repository';
import { blogRepository } from '../blog/blog.repository';
import {
  CreateCommentInput,
  ReplyCommentInput,
  UpdateCommentInput,
  CommentListQuery,
  RepliesQuery,
  MAX_COMMENT_DEPTH,
  MAX_COMMENT_LENGTH,
  MIN_COMMENT_LENGTH,
} from './comment.validator';
import { AppError } from '../../core/exceptions/AppError';
import { assertPermission } from '../auth/permissions';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { buildCursorPage } from '../../core/utils/pagination';
import { sanitizePlainText } from '../../core/utils/sanitizeText';
import { collectPaged } from '../../core/utils/collectPaged';
import { EXPORT_MAX_ROWS_PER_COLLECTION, EXPORT_PAGE_SIZE } from '../export/export.config';

/** Public author fields embedded in a comment (mirrors `blogAuthorSelect`). */
export interface CommentAuthorDTO {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  bio: string | null;
  isVerified: boolean;
}

/**
 * A comment as returned to clients. `content` is replaced with a tombstone
 * string when the comment is deleted or hidden (children still render).
 * `replies` is present only in tree/detail responses; `replyCount` is the
 * number of direct children.
 */
export interface CommentDTO {
  id: string;
  content: string;
  blogId: string;
  authorId: string;
  parentId: string | null;
  depth: number;
  author: CommentAuthorDTO;
  isEdited: boolean;
  editedAt: Date | null;
  isDeleted: boolean;
  isHidden: boolean;
  createdAt: Date;
  updatedAt: Date;
  replyCount: number;
  replies?: CommentDTO[];
}

/** A cursor page of comments. */
export interface CommentListResult {
  items: CommentDTO[];
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
}

/**
 * A comment on the author's own blog, carrying the blog it belongs to.
 *
 * The extra `blog` is what makes this usable in a list that spans blogs: an
 * activity row has to say what was commented on, and without it the consumer
 * would have to look up each blog by id — a per-row query on a list whose whole
 * point is to be cheap.
 */
export interface ReceivedCommentDTO extends CommentDTO {
  blog: { id: string; title: string; slug: string };
}

/**
 * The authenticated moderator performing an administrative action. Built from
 * the request's token by the caller; no method here takes an actor id from
 * anywhere else.
 */
export interface ModerationActor {
  userId: string;
  role: string;
}

const DELETED_PLACEHOLDER = 'This comment has been deleted.';
const HIDDEN_PLACEHOLDER = 'This comment has been hidden by a moderator.';

/**
 * Maps a comment row to its DTO, applying tombstone content for deleted/hidden
 * comments. Pure (module-level) so the tree builder and tests can use it
 * directly. `replies`, when provided, is attached and drives `replyCount`.
 */
export function toCommentDTO(
  row: CommentRow,
  replies?: CommentDTO[],
  replyCount?: number
): CommentDTO {
  const isDeleted = row.deletedAt !== null;
  const content = isDeleted
    ? DELETED_PLACEHOLDER
    : row.isHidden
      ? HIDDEN_PLACEHOLDER
      : row.content;

  return {
    id: row.id,
    content,
    blogId: row.blogId,
    authorId: row.authorId,
    parentId: row.parentId,
    depth: row.depth,
    author: row.author,
    isEdited: row.isEdited,
    editedAt: row.editedAt,
    isDeleted,
    isHidden: row.isHidden,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    replyCount: replyCount ?? replies?.length ?? 0,
    ...(replies !== undefined && { replies }),
  };
}

/**
 * Assembles a nested comment forest from a flat set of rows. `rootIds` names the
 * roots (top-level page ids, or a single id for a detail view); every other row
 * is attached to its parent by `parentId`. Ordering follows the row order
 * (repositories return oldest-first). Pure + O(n) — unit-testable in isolation.
 */
export function buildCommentTree(rows: CommentRow[], rootIds: string[]): CommentDTO[] {
  const byParent = new Map<string, CommentRow[]>();
  const byId = new Map<string, CommentRow>();
  for (const row of rows) {
    byId.set(row.id, row);
    if (row.parentId) {
      const siblings = byParent.get(row.parentId);
      if (siblings) siblings.push(row);
      else byParent.set(row.parentId, [row]);
    }
  }

  const build = (row: CommentRow): CommentDTO => {
    const children = byParent.get(row.id) ?? [];
    const replies = children.map(build);
    return toCommentDTO(row, replies, children.length);
  };

  return rootIds
    .map((id) => byId.get(id))
    .filter((row): row is CommentRow => row !== undefined)
    .map(build);
}

export class CommentService {
  // ---- Create / reply ----

  /**
   * Creates a comment on a blog. When `input.parentId` is set the create is a
   * reply (identical to `reply(...)`). The author is always the authenticated
   * caller.
   */
  async createComment(
    authorId: string,
    blogId: string,
    input: CreateCommentInput
  ): Promise<CommentDTO> {
    const content = this.sanitize(input.content);
    const blog = await this.assertCommentableBlog(blogId);

    const parent = input.parentId
      ? await this.loadParentInBlog(input.parentId, blogId)
      : null;

    return this.persist(authorId, blogId, parent, content, blog.authorId);
  }

  /** Replies to a comment; the blog is inferred from the parent. */
  async reply(
    authorId: string,
    parentId: string,
    input: ReplyCommentInput
  ): Promise<CommentDTO> {
    const content = this.sanitize(input.content);
    const parent = await this.load(parentId);
    const blog = await this.assertCommentableBlog(parent.blogId);
    return this.persist(authorId, parent.blogId, parent, content, blog.authorId);
  }

  /**
   * Persists a new comment, computing depth + materialized path from the parent
   * and enforcing the max-depth cap. When the parent is already at the deepest
   * allowed level, the new comment attaches to the parent's parent (the deepest
   * allowed parent) instead of nesting further. Cycles are impossible: a new
   * node can never be an ancestor of an existing one, and `parentId` is never
   * mutated afterward.
   */
  private async persist(
    authorId: string,
    blogId: string,
    parent: CommentRow | null,
    content: string,
    blogAuthorId: string
  ): Promise<CommentDTO> {
    let parentId: string | null = null;
    let depth = 0;
    let parentPath = '';

    if (parent) {
      if (parent.depth >= MAX_COMMENT_DEPTH) {
        // Clamp: re-parent to the parent's parent (guaranteed to exist because
        // depth >= MAX_COMMENT_DEPTH >= 1), keeping the new comment at the cap.
        parentId = parent.parentId;
        depth = parent.depth;
        parentPath = stripLastSegment(parent.path);
      } else {
        parentId = parent.id;
        depth = parent.depth + 1;
        parentPath = parent.path;
      }
    }

    const created = await commentRepository.create({
      blogId,
      authorId,
      content,
      parentId,
      depth,
      parentPath,
    });

    eventBus.emit(EVENTS.COMMENT_CREATED, {
      commentId: created.id,
      blogId,
      authorId,
      // The blog owner — the notification recipient for a top-level comment.
      // Carried on the event so subscribers need no extra blog lookup.
      blogAuthorId,
      parentId: created.parentId,
    });
    if (parent) {
      // `parentId`/`parentAuthorId` reference the comment actually replied-to
      // (the notification target), even when structurally clamped to an ancestor.
      eventBus.emit(EVENTS.COMMENT_REPLIED, {
        commentId: created.id,
        blogId,
        authorId,
        parentId: parent.id,
        parentAuthorId: parent.authorId,
        // Carried so the reply subscriber can also reach the blog owner without
        // a second lookup: COMMENT_CREATED skips every reply, so without this
        // an owner learns nothing about replies on their own post.
        blogAuthorId,
      });
    }

    return toCommentDTO(created, undefined, 0);
  }

  // ---- Edit / lifecycle / moderation ----

  /** Edits a comment's content. Author or ADMIN only; deleted comments can't be edited. */
  async edit(
    id: string,
    userId: string,
    role: string,
    input: UpdateCommentInput
  ): Promise<CommentDTO> {
    const comment = await this.load(id);
    this.assertOwnership(comment.authorId, userId, role);
    if (comment.deletedAt) {
      throw new AppError('Cannot edit a deleted comment', 409, 'COMMENT_DELETED');
    }
    // A hidden comment cannot be edited, by its author or by an admin. Otherwise
    // the moderated text could simply be replaced while the hide stays in place,
    // and the record a moderator acted on would no longer be the text they saw.
    if (comment.isHidden) {
      throw new AppError(
        'This comment has been hidden by moderation and cannot be modified',
        409,
        'CONTENT_MODERATED'
      );
    }

    const content = this.sanitize(input.content);
    const updated = await commentRepository.update(id, content);

    eventBus.emit(EVENTS.COMMENT_UPDATED, {
      commentId: id,
      blogId: comment.blogId,
      authorId: comment.authorId,
    });
    return toCommentDTO(updated, undefined, await commentRepository.countReplies(id));
  }

  /** Soft-deletes a comment (tombstone kept in tree). Author or ADMIN. Idempotent. */
  async softDelete(id: string, userId: string, role: string): Promise<CommentDTO> {
    const comment = await this.load(id);
    this.assertOwnership(comment.authorId, userId, role);
    // A hidden comment cannot be deleted through the author path, for the same
    // reason it cannot be edited: the state a moderator acted on must not move
    // underneath the decision. It also keeps "tombstoned AND hidden" meaning
    // exactly one thing — moderation removed this — which is what
    // `restoreFromModeration` reads to decide whether it may revive the row.
    // An administrator who wants it gone uses the removal endpoint, which is
    // audited; the author's own copy is already withheld from every reader.
    if (comment.isHidden) {
      throw new AppError(
        'This comment has been hidden by moderation and cannot be modified',
        409,
        'CONTENT_MODERATED'
      );
    }
    if (comment.deletedAt) {
      return toCommentDTO(comment, undefined, await commentRepository.countReplies(id));
    }

    const updated = await commentRepository.softDelete(id);
    eventBus.emit(EVENTS.COMMENT_DELETED, {
      commentId: id,
      blogId: comment.blogId,
      authorId: comment.authorId,
    });
    return toCommentDTO(updated, undefined, await commentRepository.countReplies(id));
  }

  /**
   * Restores a soft-deleted comment (clears the tombstone).
   *
   * Distinct from `restoreFromModeration` below, which lifts a HIDE. The two
   * flags mean different things — deleted is "this text is gone", hidden is
   * "this text is withheld" — and a comment can be in either state
   * independently, so one method could not correctly serve both.
   */
  async restore(id: string, actor: ModerationActor): Promise<CommentDTO> {
    assertPermission(actor.role, 'content:restore');
    const comment = await this.load(id);
    // A moderation REMOVAL carries the hide flag too, and undoing one is not
    // this method's job: it is administrator-level and it has to leave an audit
    // record, both of which `restoreFromModeration` handles. Without this guard
    // that endpoint's `content:delete` check would be trivially side-stepped by
    // calling the cheaper one next door.
    if (comment.isHidden) {
      throw new AppError(
        'This comment was removed by moderation; restore it through the moderation endpoint',
        409,
        'CONTENT_MODERATED'
      );
    }
    const updated = await commentRepository.restore(id);

    eventBus.emit(EVENTS.COMMENT_RESTORED, {
      commentId: id,
      blogId: comment.blogId,
      authorId: comment.authorId,
    });
    return toCommentDTO(updated, undefined, await commentRepository.countReplies(id));
  }

  // ---- Moderation seam -----------------------------------------------------
  //
  // Comment owns `isHidden`, so moderation acts through these rather than
  // writing the column. Each authorizes, writes conditionally, and emits the
  // fact; the caller writes the audit record. Mirrors the Blog module's seam
  // deliberately — a moderator's two most common actions should not have two
  // different shapes behind them.

  /** Withholds a comment from public view. The tombstone keeps replies readable. */
  async hideForModeration(id: string, actor: ModerationActor, reason?: string) {
    assertPermission(actor.role, 'content:hide');

    const comment = await this.load(id);
    const changed = await commentRepository.setModerationHidden(id, true);
    if (!changed) {
      throw new AppError('This comment is already hidden', 409, 'ALREADY_HIDDEN');
    }

    eventBus.emit(EVENTS.CONTENT_MODERATED, {
      targetType: 'COMMENT',
      targetId: id,
      ownerId: comment.authorId,
      actorId: actor.userId,
      action: 'HIDDEN',
      reason: reason ?? null,
      blogId: comment.blogId,
    });

    return this.getModerationSnapshot(id);
  }

  /**
   * Lifts a moderation hide, and revives a moderation removal.
   *
   * Which one it is comes from the row: a comment that is tombstoned *and*
   * hidden was removed by moderation, since the author's own delete is refused
   * while the hide flag is set. A comment that is merely tombstoned was deleted
   * by its author and stays deleted — `restore` above is the path for that one,
   * and it exists precisely so this method never has to guess.
   *
   * Reviving costs `content:delete`, the permission that performed the removal.
   * See `blogService.restoreFromModeration` for why undoing an
   * administrator-only action cannot be a moderator-level act.
   */
  async restoreFromModeration(id: string, actor: ModerationActor) {
    assertPermission(actor.role, 'content:restore');

    const comment = await this.load(id);

    if (!comment.isHidden) {
      throw new AppError(
        comment.deletedAt
          ? 'This comment was deleted by its author, not by moderation'
          : 'This comment is not hidden',
        409,
        'NOT_HIDDEN'
      );
    }

    const revive = comment.deletedAt !== null;
    if (revive) assertPermission(actor.role, 'content:delete');

    const changed = await commentRepository.moderationRestore(id, { revive });
    if (!changed) {
      // Lost the race to another moderator; the conditional write is the arbiter.
      throw new AppError('This comment is not hidden', 409, 'NOT_HIDDEN');
    }

    eventBus.emit(EVENTS.CONTENT_RESTORED, {
      targetType: 'COMMENT',
      targetId: id,
      ownerId: comment.authorId,
      actorId: actor.userId,
      blogId: comment.blogId,
      // Unlike a blog, a revived comment IS visible again the moment its
      // tombstone clears — there is no draft state to come back to. Carried
      // anyway so consumers can read the field without checking the target type.
      revived: revive,
    });

    return this.getModerationSnapshot(id);
  }

  /**
   * Removes a comment outright (soft delete — the tombstone stays so replies
   * keep their place in the thread). Administrator-only; see the permission
   * catalogue for why `content:delete` is not delegated to moderators.
   */
  async deleteForModeration(id: string, actor: ModerationActor, reason?: string) {
    assertPermission(actor.role, 'content:delete');

    const comment = await this.load(id);
    const changed = await commentRepository.moderationDelete(id);
    if (!changed) {
      throw new AppError('This comment is already deleted', 409, 'ALREADY_DELETED');
    }

    eventBus.emit(EVENTS.CONTENT_MODERATED, {
      targetType: 'COMMENT',
      targetId: id,
      ownerId: comment.authorId,
      actorId: actor.userId,
      action: 'DELETED',
      reason: reason ?? null,
      blogId: comment.blogId,
    });

    return this.getModerationSnapshot(id);
  }

  /**
   * What an administrative surface renders for a comment: the RAW text (not the
   * tombstone placeholder a reader gets — a moderator has to see what was
   * actually written), its author, and its moderation state.
   *
   * Returns null for an unknown id rather than throwing, so a report whose
   * target has since been hard-deleted renders as "content unavailable".
   */
  async getModerationSnapshot(id: string) {
    const comment = await commentRepository.findById(id);
    if (!comment) return null;

    return {
      id: comment.id,
      blogId: comment.blogId,
      authorId: comment.authorId,
      author: comment.author,
      content: comment.content,
      parentId: comment.parentId,
      depth: comment.depth,
      isHidden: comment.isHidden,
      hiddenAt: comment.hiddenAt,
      isDeleted: comment.deletedAt !== null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }

  // ---- Retrieval ----

  /**
   * Cursor page of a blog's top-level comments. In tree mode (default) each root
   * is returned with its full reply subtree, loaded with a bounded breadth-first
   * sweep (at most `MAX_COMMENT_DEPTH` queries regardless of comment count). In
   * lazy mode (`tree: false`) roots carry only a `replyCount`.
   */
  async getBlogComments(
    blogId: string,
    query: CommentListQuery
  ): Promise<CommentListResult> {
    await this.assertCommentableBlog(blogId);

    const [rows, totalCount] = await Promise.all([
      commentRepository.findTopLevel(blogId, query),
      commentRepository.countBlogComments(blogId),
    ]);

    const page = buildCursorPage(rows, query.limit, (r) => r.id);
    const rootIds = page.items.map((r) => r.id);

    let items: CommentDTO[];
    if (query.tree) {
      const descendants = await this.loadDescendants(rootIds);
      items = buildCommentTree([...page.items, ...descendants], rootIds);
    } else {
      const counts = await commentRepository.countRepliesFor(rootIds);
      items = page.items.map((r) => toCommentDTO(r, undefined, counts.get(r.id) ?? 0));
    }

    return {
      items,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      totalCount,
    };
  }

  /** A single comment with its full reply subtree. */
  async getById(id: string): Promise<CommentDTO> {
    const comment = await this.load(id);
    const descendants = await this.loadDescendants([id]);
    const [tree] = buildCommentTree([comment, ...descendants], [id]);
    return tree!;
  }

  /** Cursor page of one comment's direct replies (lazy expansion). */
  async getReplies(parentId: string, query: RepliesQuery): Promise<CommentListResult> {
    await this.load(parentId); // 404 if the parent doesn't exist

    const [rows, totalCount] = await Promise.all([
      commentRepository.findReplies(parentId, query),
      commentRepository.countReplies(parentId),
    ]);

    const page = buildCursorPage(rows, query.limit, (r) => r.id);
    const counts = await commentRepository.countRepliesFor(page.items.map((r) => r.id));
    const items = page.items.map((r) => toCommentDTO(r, undefined, counts.get(r.id) ?? 0));

    return {
      items,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      totalCount,
    };
  }

  /**
   * Loads every descendant of `rootIds` breadth-first, one query per depth level
   * (bounded by `MAX_COMMENT_DEPTH`). Because depth is capped on write, this
   * captures the entire subtree — no N+1, no unbounded recursion.
   */
  private async loadDescendants(rootIds: string[]): Promise<CommentRow[]> {
    const all: CommentRow[] = [];
    let frontier = rootIds;
    for (let level = 0; level < MAX_COMMENT_DEPTH && frontier.length > 0; level++) {
      const children = await commentRepository.findChildrenByParentIds(frontier);
      if (children.length === 0) break;
      all.push(...children);
      frontier = children.map((c) => c.id);
    }
    return all;
  }

  /**
   * Public comment counts for many blogs, keyed by blog id.
   *
   * The Comment module's contribution to other modules' list views — the Feed
   * module renders it on every card. A pass-through to the batched repository
   * query, so consumers depend on this service rather than on comment storage,
   * and so "which comments count" (tombstones excluded) stays defined in one
   * place.
   */
  getCommentCounts(blogIds: string[]): Promise<Map<string, number>> {
    return commentRepository.countForBlogs(blogIds);
  }

  /**
   * Comments other people left on `authorId`'s blogs, newest first.
   *
   * The Comment module's read surface for an author's own activity view. It
   * lives here — rather than in whatever module wants to display it — because
   * the rules for which comments "count" (not deleted, not hidden, not the
   * author's own) are comment policy, and a consumer reimplementing them would
   * drift from the thread view the first time one of them changed.
   *
   * `since` is required by the repository and passed straight through: an
   * unbounded "every comment I have ever received" scan is not a query this
   * module offers.
   */
  async getReceivedComments(
    authorId: string,
    options: { limit: number; since: Date }
  ): Promise<ReceivedCommentDTO[]> {
    const rows = await commentRepository.findReceivedByAuthor(authorId, options);
    return rows.map((row) => this.toReceivedDTO(row));
  }

  // ---- Helpers ----

  private sanitize(raw: string): string {
    const content = sanitizePlainText(raw);
    if (content.length < MIN_COMMENT_LENGTH) {
      throw new AppError('Comment cannot be empty', 400, 'INVALID_COMMENT');
    }
    if (content.length > MAX_COMMENT_LENGTH) {
      throw new AppError('Comment is too long', 400, 'INVALID_COMMENT');
    }
    return content;
  }

  private async load(id: string): Promise<CommentRow> {
    const comment = await commentRepository.findById(id);
    if (!comment) {
      throw new AppError('Comment not found', 404, 'COMMENT_NOT_FOUND');
    }
    return comment;
  }

  /** Loads a parent comment and ensures it belongs to the target blog. */
  private async loadParentInBlog(parentId: string, blogId: string): Promise<CommentRow> {
    const parent = await this.load(parentId);
    if (parent.blogId !== blogId) {
      throw new AppError(
        'Parent comment does not belong to this blog',
        400,
        'PARENT_BLOG_MISMATCH'
      );
    }
    return parent;
  }

  /** Verifies the blog exists and is not deleted. */
  /**
   * Verifies the blog exists and is not deleted, returning its author id — the
   * notification recipient for a top-level comment. The blog is already loaded
   * here, so surfacing `authorId` costs nothing; without it every COMMENT_CREATED
   * subscriber would have to re-fetch the blog just to learn who to notify.
   */
  private async assertCommentableBlog(blogId: string): Promise<{ authorId: string }> {
    const blog = await blogRepository.findById(blogId);
    if (!blog || blog.status === 'DELETED') {
      throw new AppError('Blog not found', 404, 'BLOG_NOT_FOUND');
    }
    return { authorId: blog.authorId };
  }

  /**
   * Maps a received-comment row to its DTO.
   *
   * Reuses `toCommentDTO` rather than building the shape by hand, so tombstone
   * handling, `replyCount` and every field name stay identical to the thread
   * view. The repository already excludes deleted and hidden rows, so the
   * tombstone branches never fire here — reusing the mapper is about not having
   * two definitions of a comment on the wire, not about the placeholders.
   */
  private toReceivedDTO(row: ReceivedCommentRow): ReceivedCommentDTO {
    const { blog, ...comment } = row;
    return { ...toCommentDTO(comment), blog };
  }

  private assertOwnership(authorId: string, userId: string, role: string): void {
    if (authorId !== userId && role !== 'ADMIN') {
      throw new AppError(
        'You do not have permission to modify this comment',
        403,
        'FORBIDDEN'
      );
    }
  }


  /**
   * Every comment this author wrote, for the data export. See the note on
   * `blogService.collectForExport` for why this lives in the owning module.
   */
  async collectForExport(authorId: string) {
    type Row = Awaited<ReturnType<typeof commentRepository.findAllByAuthorForExport>>[number];
    return collectPaged<Row>(
      (previous) =>
        commentRepository.findAllByAuthorForExport(authorId, EXPORT_PAGE_SIZE, previous?.id),
      EXPORT_PAGE_SIZE,
      EXPORT_MAX_ROWS_PER_COLLECTION
    );
  }
}

/** Removes the last `/segment` from a materialized path (`"a/b/c"` -> `"a/b"`). */
function stripLastSegment(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export const commentService = new CommentService();
