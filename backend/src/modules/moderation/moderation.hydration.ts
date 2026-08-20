import type { ReportTargetType } from '@prisma/client';
import { logger } from '../../core/utils/logger';
import { blogService } from '../blog/blog.service';
import { commentService } from '../comment/comment.service';
import { userService } from '../user/user.service';
import type {
  ReportTargetDTO,
  UserCardDTO,
} from './moderation.types';

/**
 * Turning ids into things, across module boundaries.
 *
 * A report names a `targetType` and a `targetId` and nothing else — that is what
 * makes the table polymorphic and what lets a fifth reportable thing be added
 * without a migration. The cost is paid here: something has to ask the owning
 * module what that id actually is.
 *
 * Two rules this file exists to keep:
 *
 *   BATCHED   A queue page of 25 rows names up to 50 people (a reporter and an
 *             owner each). Resolving them one at a time is the N+1 that
 *             polymorphism invites, and it lands on the shared connection pool.
 *             Every user lookup here goes through one batched call.
 *
 *   THROUGH SERVICES  Blog, Comment and User are asked through their services,
 *             never their repositories or their tables. Moderation therefore has
 *             no idea how a blog is stored, and the rules those modules apply
 *             (what a moderation snapshot contains, what a comment's raw text
 *             is) stay theirs.
 */

/** Resolves many user ids to their public cards in ONE query. */
export async function loadUserCards(ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map<string, UserCardDTO>();

  const cards = await userService.getPublicUserCards(wanted);
  return cards as Map<string, UserCardDTO>;
}

/**
 * Loads the thing a report points at, in full.
 *
 * Returns a MISSING shape rather than throwing when the target no longer
 * resolves. A report outliving its target is normal — content gets hard-deleted,
 * accounts get erased — and a moderator opening that report should see "content
 * unavailable" with the report's own text still readable, not a 500.
 *
 * An error from the owning module is logged and treated the same way: one
 * unavailable panel is a better outcome than a failed page.
 */
export async function loadTarget(
  targetType: ReportTargetType,
  targetId: string
): Promise<ReportTargetDTO> {
  try {
    switch (targetType) {
      case 'BLOG':
        return await loadBlogTarget(targetId);
      case 'COMMENT':
        return await loadCommentTarget(targetId);
      case 'USER':
        return await loadUserTarget(targetId);
      default:
        return { kind: 'MISSING', id: targetId, targetType };
    }
  } catch (err) {
    logger.warn({ err, targetType, targetId }, 'moderation: failed to hydrate report target');
    return { kind: 'MISSING', id: targetId, targetType };
  }
}

async function loadBlogTarget(blogId: string): Promise<ReportTargetDTO> {
  const blog = await blogService.getModerationSnapshot(blogId);
  if (!blog) return { kind: 'MISSING', id: blogId, targetType: 'BLOG' };

  const authors = await loadUserCards([blog.authorId]);
  return {
    kind: 'BLOG',
    id: blog.id,
    title: blog.title,
    slug: blog.slug,
    subtitle: blog.subtitle,
    excerpt: blog.excerpt,
    status: blog.status,
    visibility: blog.visibility,
    isHidden: blog.isHidden,
    hiddenAt: blog.hiddenAt,
    author: authors.get(blog.authorId) ?? null,
    publishedAt: blog.publishedAt,
    createdAt: blog.createdAt,
  };
}

async function loadCommentTarget(commentId: string): Promise<ReportTargetDTO> {
  const comment = await commentService.getModerationSnapshot(commentId);
  if (!comment) return { kind: 'MISSING', id: commentId, targetType: 'COMMENT' };

  const authors = await loadUserCards([comment.authorId]);
  return {
    kind: 'COMMENT',
    id: comment.id,
    blogId: comment.blogId,
    content: comment.content,
    isHidden: comment.isHidden,
    hiddenAt: comment.hiddenAt,
    isDeleted: comment.isDeleted,
    author: authors.get(comment.authorId) ?? null,
    createdAt: comment.createdAt,
  };
}

async function loadUserTarget(userId: string): Promise<ReportTargetDTO> {
  const user = await userService.getModerationSummary(userId).catch(() => null);
  if (!user) return { kind: 'MISSING', id: userId, targetType: 'USER' };

  return {
    kind: 'USER',
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: user.avatar,
    role: user.role,
    status: user.status,
    isVerified: user.isVerified,
    suspendedAt: user.suspendedAt,
    suspendedReason: user.suspendedReason,
    createdAt: user.createdAt,
    counts: {
      blogs: user._count.blogs,
      comments: user._count.comments,
      followers: user._count.followers,
    },
  };
}

/**
 * The account that OWNS a target, resolved at report time and denormalized onto
 * the report row.
 *
 * Done once, on submission, so the queue never has to join three tables per row
 * to answer "who is this about". Returns null when the target does not exist,
 * which is what the caller turns into a 404 — reporting a target that is not
 * there is either a stale client or a probe.
 */
export async function resolveTargetOwner(
  targetType: ReportTargetType,
  targetId: string
): Promise<{ ownerId: string | null } | null> {
  switch (targetType) {
    case 'BLOG': {
      const blog = await blogService.getBlogMeta(targetId);
      return blog ? { ownerId: blog.authorId } : null;
    }
    case 'COMMENT': {
      const comment = await commentService.getModerationSnapshot(targetId);
      return comment ? { ownerId: comment.authorId } : null;
    }
    case 'USER': {
      const user = await userService.getModerationSummary(targetId).catch(() => null);
      // A reported ACCOUNT owns itself: the queue's "reports about this person"
      // filter then covers both their content and their profile in one query.
      return user ? { ownerId: user.id } : null;
    }
    default:
      return null;
  }
}
