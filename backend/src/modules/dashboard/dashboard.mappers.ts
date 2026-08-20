import type { BlogCardDTO } from '../blog/blog.service';
import type { BookmarkItemDTO } from '../bookmark/bookmark.service';
import type { ReceivedCommentDTO } from '../comment/comment.service';
import type { FollowUserDTO } from '../follow/follow.service';
import type { NotificationDTO } from '../notification/notification.service';
import type { ReadingStatsDTO as AnalyticsReadingStatsDTO } from '../analytics/analytics.types';
import { MAX_EXCERPT_LENGTH } from './dashboard.config';
import type {
  ActivityItemDTO,
  BlogSummaryDTO,
  NotificationSummaryItemDTO,
  ReadingSummaryDTO,
  SavedBlogDTO,
} from './dashboard.types';

/**
 * Sibling-module DTO → dashboard DTO.
 *
 * Every function here is PURE and EXPLICIT — field by field, never a spread of
 * someone else's object. That is deliberate, and it is the whole reason this
 * file exists separately from the section builders:
 *
 *   A spread makes another module's DTO this module's API. A field added over
 *   there would appear in the dashboard payload without anyone reviewing it as
 *   an API change, and a field removed would break dashboard clients from a
 *   commit that never mentioned the dashboard. Listing the fields means the
 *   compiler stops the second case and nothing at all happens in the first —
 *   which is the correct outcome for both.
 *
 *   It also keeps the payload small. A blog card carries categories, reading
 *   stats, char counts and a full author object; a dashboard panel row needs
 *   about a third of that, eight rows at a time.
 *
 * Dates become ISO strings here, once, before anything is cached. See
 * `dashboard.types.ts` for why no DTO in this module carries a `Date`.
 */

/** ISO string, or null. The single place a nullable date is converted. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** ISO string for a date that is always present. */
function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Shortens text for an activity row.
 *
 * Cuts on a character count rather than a word boundary: comment text is
 * arbitrary user input in any script, and "words" is not a concept that
 * survives contact with it. The ellipsis is a single character, so the result
 * never exceeds the budget it was given.
 */
export function excerpt(text: string, max: number = MAX_EXCERPT_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** A blog card, reduced to what a dashboard panel renders. */
export function toBlogSummary(blog: BlogCardDTO): BlogSummaryDTO {
  return {
    id: blog.id,
    title: blog.title,
    slug: blog.slug,
    subtitle: blog.subtitle,
    coverImage: blog.coverImage,
    status: blog.status,
    visibility: blog.visibility,
    readingTimeMinutes: blog.readingTimeMinutes,
    wordCount: blog.wordCount,
    tags: blog.tags.map((tag) => ({ id: tag.id, name: tag.name, slug: tag.slug })),
    publishedAt: iso(blog.publishedAt),
    updatedAt: isoRequired(blog.updatedAt),
    createdAt: isoRequired(blog.createdAt),
  };
}

/**
 * Analytics reading statistics, renamed to this module's vocabulary.
 *
 * The nullable rates pass through UNCHANGED. Defaulting them to 0 here would
 * throw away the distinction the Analytics module went out of its way to
 * preserve: a rate is null when its denominator is zero, and "nobody has opened
 * this yet" must not render as "0% of readers finish it".
 */
export function toReadingSummary(reading: AnalyticsReadingStatsDTO): ReadingSummaryDTO {
  return {
    starts: reading.readStarts,
    completions: reading.readCompletions,
    averageSeconds: reading.averageReadingSeconds,
    totalSeconds: reading.totalReadingSeconds,
    completionRate: reading.completionRate,
    readThroughRate: reading.readThroughRate,
  };
}

/**
 * A bookmark library row.
 *
 * `blog` is null when the Bookmark module marked the row unavailable — the blog
 * was deleted, or its visibility tightened after it was saved. Nothing about it
 * is carried over in that case, not even the title: the Bookmark module nulls
 * the payload precisely so a since-hidden blog does not leak through a list the
 * user happens to still have a row in.
 */
export function toSavedBlog(item: BookmarkItemDTO): SavedBlogDTO {
  return {
    bookmarkId: item.bookmarkId,
    bookmarkedAt: isoRequired(item.bookmarkedAt),
    blog:
      item.isAvailable && item.blog
        ? {
            id: item.blog.id,
            title: item.blog.title,
            slug: item.blog.slug,
            coverImage: item.blog.coverImage,
            readingTimeMinutes: item.blog.readingTimeMinutes,
            author: {
              id: item.blog.author.id,
              username: item.blog.author.username,
              name: item.blog.author.name,
              avatar: item.blog.author.avatar,
            },
          }
        : null,
  };
}

/**
 * A notification, reduced to a dashboard row.
 *
 * `metadata` is passed through as the render INPUTS the Notification module
 * stores (blogTitle, commentExcerpt, …), never as rendered copy — that module
 * is explicit that storing a finished string would freeze it, and this module
 * is in no position to render one either.
 */
export function toNotificationSummary(
  notification: NotificationDTO
): NotificationSummaryItemDTO {
  return {
    id: notification.id,
    type: notification.type,
    actor: notification.actor
      ? {
          id: notification.actor.id,
          username: notification.actor.username,
          name: notification.actor.name,
          avatar: notification.actor.avatar,
        }
      : null,
    entityType: notification.entityType,
    entityId: notification.entityId,
    metadata: notification.metadata,
    isRead: notification.isRead,
    createdAt: isoRequired(notification.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------
//
// Three sources, one row shape. The `id` is prefixed with its source because
// ids are only unique within their own table — a comment and a blog can share
// one, and a list keyed on the bare value would silently render one of them
// twice.

export function commentActivity(comment: ReceivedCommentDTO): ActivityItemDTO {
  return {
    id: `comment:${comment.id}`,
    type: 'COMMENT_RECEIVED',
    occurredAt: isoRequired(comment.createdAt),
    actor: {
      id: comment.author.id,
      username: comment.author.username,
      name: comment.author.name,
      avatar: comment.author.avatar,
      isVerified: comment.author.isVerified,
    },
    blog: {
      id: comment.blog.id,
      title: comment.blog.title,
      slug: comment.blog.slug,
    },
    excerpt: excerpt(comment.content),
  };
}

export function followerActivity(follower: FollowUserDTO): ActivityItemDTO {
  return {
    id: `follow:${follower.id}`,
    type: 'FOLLOWER_GAINED',
    occurredAt: isoRequired(follower.followedAt),
    actor: {
      id: follower.id,
      username: follower.username,
      name: follower.name,
      avatar: follower.avatar,
      isVerified: follower.isVerified,
    },
    // A follow is about the author, not about any one post.
    blog: null,
    excerpt: null,
  };
}

/**
 * The author's own publication.
 *
 * `actor` is null rather than the author themselves: every other row answers
 * "who did this to me", and filling in the reader's own name would make the
 * feed read as if someone else had published their post. A client renders these
 * as "You published …".
 *
 * Blogs with no `publishedAt` are impossible here — the caller filters to
 * PUBLISHED — but the fallback to `updatedAt` is kept rather than a non-null
 * assertion, because an activity row with an `Invalid Date` would corrupt the
 * merge ordering for the whole feed.
 */
export function publishedActivity(blog: BlogCardDTO): ActivityItemDTO {
  return {
    id: `blog:${blog.id}`,
    type: 'BLOG_PUBLISHED',
    occurredAt: iso(blog.publishedAt) ?? isoRequired(blog.updatedAt),
    actor: null,
    blog: { id: blog.id, title: blog.title, slug: blog.slug },
    excerpt: null,
  };
}

/**
 * Merges activity from every source into one ordered feed.
 *
 * Newest first, capped. The tiebreaker on `id` is not cosmetic: three sources
 * can produce identical timestamps (a publish and its first comment can share a
 * second, and fixtures routinely share a millisecond), and without a total
 * ordering the feed would shuffle between two identical requests — including
 * between a cache miss and the next miss, which looks exactly like data
 * changing.
 */
export function mergeActivity(
  groups: ActivityItemDTO[][],
  limit: number
): ActivityItemDTO[] {
  return groups
    .flat()
    .sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? b.id.localeCompare(a.id)
        : a.occurredAt < b.occurredAt
          ? 1
          : -1
    )
    .slice(0, limit);
}
