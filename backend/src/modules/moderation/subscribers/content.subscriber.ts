import type { ReportTargetType } from '@prisma/client';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { blogService } from '../../blog/blog.service';
import { commentService } from '../../comment/comment.service';
import { claimAutomatedSlot } from '../moderation.cache';
import {
  AUTOMATED_REPORT_THRESHOLD,
  AUTOMATED_SCAN_MAX_CHARS,
} from '../moderation.config';
import { activeContentModerationProvider } from '../providers';
import { reportService } from '../report.service';

/**
 * Automated content evaluation.
 *
 * ── Where this sits, and why ────────────────────────────────────────────────
 * It runs on the EVENT BUS, after the request has returned, and it files a
 * REPORT. It is not on the write path and it cannot block a publish; it cannot
 * hide anything either. The strongest thing an automated verdict can do on this
 * platform is put a row in the same queue a human report lands in.
 *
 * That is a deliberate ceiling, not a stage in a roadmap. Automated moderation
 * that acts on its own is the mechanism behind every "my account was deleted by
 * a robot and there was nobody to appeal to" story, and the difference between
 * that platform and this one is exactly this design decision.
 *
 * ── Why publish, and not create ─────────────────────────────────────────────
 * Blogs are evaluated on BLOG_PUBLISHED rather than BLOG_CREATED: a draft is
 * invisible, and scanning every autosaved stub would evaluate the same post
 * dozens of times while it was being written. Comments are evaluated on
 * creation because a comment is public the moment it exists.
 *
 * ── Failure is silent by design ─────────────────────────────────────────────
 * Every handler swallows its errors. A provider that throws, a target that
 * vanished mid-flight, a Redis outage — none of it may fail the job carrying the
 * event, because that job also carries the notification and analytics work for
 * the same publish. The consequence of a failure here is one unscanned post.
 */

interface BlogPublishedPayload {
  blogId?: string;
  authorId?: string;
}

interface CommentCreatedPayload {
  commentId?: string;
  authorId?: string;
}

export async function onBlogPublished(payload: BlogPublishedPayload): Promise<void> {
  const { blogId } = payload;
  if (!blogId) return;

  try {
    const blog = await blogService.getModerationSnapshot(blogId, AUTOMATED_SCAN_MAX_CHARS);
    if (!blog) return;

    // Already hidden: a moderator has looked at this and acted. Re-flagging it
    // would put a decided case back in the queue.
    if (blog.isHidden) return;

    await evaluate({
      targetType: 'BLOG',
      targetId: blog.id,
      ownerId: blog.authorId,
      title: blog.title,
      text: blog.excerpt,
    });
  } catch (err) {
    logger.warn({ err, blogId }, 'moderation: automated blog evaluation failed');
  }
}

export async function onCommentCreated(payload: CommentCreatedPayload): Promise<void> {
  const { commentId } = payload;
  if (!commentId) return;

  try {
    const comment = await commentService.getModerationSnapshot(commentId);
    if (!comment || comment.isHidden || comment.isDeleted) return;

    await evaluate({
      targetType: 'COMMENT',
      targetId: comment.id,
      ownerId: comment.authorId,
      text: comment.content.slice(0, AUTOMATED_SCAN_MAX_CHARS),
    });
  } catch (err) {
    logger.warn({ err, commentId }, 'moderation: automated comment evaluation failed');
  }
}

/**
 * Runs the active provider and files a report if the verdict clears the
 * platform's threshold.
 *
 * The threshold lives HERE, not in the provider. A provider reports its own
 * confidence; how much confidence is worth a moderator's time is a policy
 * decision, and keeping it on this side means swapping providers cannot silently
 * change how eagerly the platform files reports.
 */
async function evaluate(params: {
  targetType: Extract<ReportTargetType, 'BLOG' | 'COMMENT'>;
  targetId: string;
  ownerId: string;
  title?: string;
  text: string;
}): Promise<void> {
  const result = await activeContentModerationProvider.evaluate({
    targetType: params.targetType,
    targetId: params.targetId,
    authorId: params.ownerId,
    title: params.title,
    text: params.text,
  });

  if (result.score < AUTOMATED_REPORT_THRESHOLD) return;

  // Claimed AFTER the verdict: a below-threshold evaluation must not consume the
  // guard, or a post that was edited from harmless into spam would go unscanned.
  const slot = await claimAutomatedSlot(params.targetType, params.targetId);
  if (!slot) return;

  const report = await reportService.createAutomatedReport({
    targetType: params.targetType,
    targetId: params.targetId,
    targetOwnerId: params.ownerId,
    reason: result.reason,
    // The description is what a moderator reads first. It names the provider and
    // the signals, because an automated report a moderator cannot evaluate is
    // one they can only rubber-stamp.
    description: `Flagged automatically by ${result.provider} (score ${result.score.toFixed(2)}): ${result.signals.join(', ') || 'no named signals'}`,
    metadata: {
      provider: result.provider,
      score: result.score,
      signals: result.signals,
    },
  });

  if (report) {
    logger.info(
      { reportId: report.id, targetType: params.targetType, targetId: params.targetId, score: result.score },
      'moderation: automated report filed'
    );
  }
}

export function registerContentModerationSubscriber(): void {
  eventBus.on(EVENTS.BLOG_PUBLISHED, onBlogPublished);
  eventBus.on(EVENTS.COMMENT_CREATED, onCommentCreated);
}
