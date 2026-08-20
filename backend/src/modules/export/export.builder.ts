import { analyticsService } from '../analytics/analytics.service';
import { sessionService } from '../auth/session.service';
import { blogService } from '../blog/blog.service';
import { bookmarkService } from '../bookmark/bookmark.service';
import { commentService } from '../comment/comment.service';
import { followService } from '../follow/follow.service';
import { mediaService } from '../media/media.service';
import { notificationService } from '../notification/notification.service';
import { userService } from '../user/user.service';
import { EXPORT_FORMAT_VERSION } from './export.config';
import type { ExportDocument } from './export.types';

/**
 * Assembles the export document by composing sibling module services.
 *
 * ── This file contains no SQL, and must not gain any ────────────────────────
 * Every section comes from a `collectForExport` method on the module that owns
 * that data. Export is a composition module in the mould of Dashboard: it owns
 * the document's SHAPE, its versioning and its exclusion policy, and nothing
 * about what a blog or a notification actually is.
 *
 * The dependency direction is the reason the module exists at all. A data export
 * has to read Blog, Comment, Bookmark, Follow, Notification, Media and
 * Analytics — every one of which imports User. Putting this in the User module
 * would invert the graph and create real import cycles, so it sits above them
 * instead, importing everything and imported by nothing.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * The `excluded` list below is part of the artifact, not a comment. A reader who
 * notices their moderation reports are missing should find out why from the file
 * itself rather than concluding the export is broken.
 */

/**
 * Sections that are absent by design, in the user's own words.
 *
 * Each is a decision, not an omission:
 *
 *   password       a live credential. An export lands in email and cloud
 *                  storage; a working key to the account must never travel with
 *                  it. Same reasoning excludes session refresh-token hashes.
 *
 *   reports about  a report names its reporter. Handing the subject of a report
 *   this account   a copy would turn "report this user" into "tell this user who
 *                  reported them", which ends community moderation immediately.
 *                  Reports the user FILED are theirs and are listed as a known
 *                  gap below rather than a refusal.
 *
 *   other people's the follow graph and notifications carry usernames and
 *   data          display names — already public. Nothing further about another
 *                 account belongs in this file.
 *
 *   file bytes     the images are already downloadable from the URLs recorded in
 *                 the media section.
 */
const EXCLUSIONS = [
  'Password hash and session refresh tokens — live credentials that must not travel in a file.',
  'Moderation reports filed about this account — they would identify the people who filed them.',
  'Other accounts’ data beyond the public username and display name already visible on the platform.',
  'Uploaded file contents — the media section records the URLs the files are served from.',
];

/**
 * Known gaps, distinct from exclusions: things a complete export would contain
 * and this one does not yet. Named in the artifact so the omission is honest
 * rather than silent.
 */
const KNOWN_GAPS = [
  'Reports this account filed — the Moderation module has no export collector yet.',
  'Likes — the schema defines the table but no feature writes to it, so there is nothing to export.',
];

export class ExportBuilder {
  /**
   * Builds the complete document for a user.
   *
   * Sections are collected CONCURRENTLY. They are independent reads against the
   * same connection pool, and the alternative — nine sequential round trips — is
   * nine times the wall clock for no benefit, inside a job that holds a worker
   * slot the whole time.
   */
  async build(exportId: string, userId: string): Promise<ExportDocument> {
    const [
      account,
      blogs,
      comments,
      bookmarks,
      follows,
      notifications,
      media,
      analytics,
      sessions,
    ] = await Promise.all([
      userService.collectForExport(userId),
      blogService.collectForExport(userId),
      commentService.collectForExport(userId),
      bookmarkService.collectForExport(userId),
      followService.collectForExport(userId),
      notificationService.collectForExport(userId),
      mediaService.collectForExport(userId),
      analyticsService.collectForExport(userId),
      sessionService.collectForExport(userId),
    ]);

    /**
     * Which collections hit the row ceiling.
     *
     * Surfaced in `meta.truncated` so a capped section is distinguishable from a
     * genuinely empty one. Without this a user with 50,000+ notifications gets a
     * file that looks complete and is not.
     */
    const truncated = [
      ['blogs', blogs.truncated],
      ['comments', comments.truncated],
      ['bookmarks', bookmarks.truncated],
      ['follows.following', follows.following.truncated],
      ['follows.followers', follows.followers.truncated],
      ['notifications', notifications.truncated],
      ['media', media.truncated],
      ['analytics.blogDaily', analytics.blogDaily.truncated],
    ]
      .filter(([, wasTruncated]) => wasTruncated)
      .map(([name]) => name as string);

    return {
      meta: {
        formatVersion: EXPORT_FORMAT_VERSION,
        exportId,
        userId,
        generatedAt: new Date().toISOString(),
        truncated,
        excluded: [...EXCLUSIONS, ...KNOWN_GAPS],
      },
      account,
      blogs: blogs.items,
      comments: comments.items,
      bookmarks: bookmarks.items,
      follows: {
        following: follows.following.items,
        followers: follows.followers.items,
      },
      notifications: notifications.items,
      media: media.items,
      analytics: {
        daily: analytics.daily,
        blogDaily: analytics.blogDaily.items,
      },
      sessions,
    };
  }
}

export const exportBuilder = new ExportBuilder();
