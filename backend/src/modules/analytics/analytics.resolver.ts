import type { Redis } from 'ioredis';
import { redis as sharedRedis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import { blogService } from '../blog/blog.service';
import { OWNER_CACHE_TTL_SECONDS, blogOwnerKey } from './analytics.keys';

/**
 * Resolves the blog facts the ingestion path needs but events do not carry.
 *
 * Two events arrive without an author: `BLOG_BOOKMARKED` and
 * `BLOG_UNBOOKMARKED` are `{ blogId, userId }`, because the Bookmark module has
 * no reason to load a blog on its write path. Adding an author lookup there to
 * satisfy analytics would push an extra query onto a user-facing request in
 * order to serve a dashboard — precisely the coupling this module exists to
 * avoid. Resolving it HERE is free: ingestion runs inside the domain-events
 * worker, off the request path entirely.
 *
 * The reading endpoints need `readingTimeMinutes` for the same reason: a claimed
 * duration is only meaningful next to the post's estimated length.
 *
 * ── Why caching is safe ─────────────────────────────────────────────────────
 * Authorship is immutable in this schema — there is no transfer feature — so a
 * cached author can never be wrong, only absent. `readingTimeMinutes` DOES
 * change when a post is edited, which is why the entry expires after an hour
 * rather than living forever: a stale reading estimate loosens a validation
 * bound for at most that long, which is a far smaller cost than a database read
 * per view event.
 *
 * ── Why it never throws ─────────────────────────────────────────────────────
 * A resolver failure means one event is not counted. It must never become a
 * failure of the job carrying the event, because that job may also carry work
 * for the Notification module.
 */

/** The subset of blog metadata analytics ingestion needs. */
export interface BlogAnalyticsMeta {
  authorId: string;
  readingTimeMinutes: number;
}

export class AnalyticsBlogResolver {
  constructor(private readonly redis: Redis = sharedRedis) {}

  /**
   * Blog metadata, from Redis if present and PostgreSQL otherwise. Returns null
   * for a blog that no longer exists, which is a normal race: an event can be
   * delivered after its blog was deleted.
   */
  async resolve(blogId: string): Promise<BlogAnalyticsMeta | null> {
    const cached = await this.readCache(blogId);
    if (cached) return cached;

    const blog = await blogService.getBlogMeta(blogId);
    if (!blog) return null;

    const meta: BlogAnalyticsMeta = {
      authorId: blog.authorId,
      readingTimeMinutes: blog.readingTimeMinutes,
    };

    await this.writeCache(blogId, meta);
    return meta;
  }

  private async readCache(blogId: string): Promise<BlogAnalyticsMeta | null> {
    try {
      const raw = await this.redis.get(blogOwnerKey(blogId));
      if (!raw) return null;

      const parsed = JSON.parse(raw) as Partial<BlogAnalyticsMeta>;
      // A malformed entry must not poison the blog forever — treat it as a miss
      // and let the write below overwrite it.
      if (typeof parsed.authorId !== 'string') return null;

      return {
        authorId: parsed.authorId,
        readingTimeMinutes:
          typeof parsed.readingTimeMinutes === 'number' ? parsed.readingTimeMinutes : 0,
      };
    } catch (err) {
      logger.warn({ err, blogId }, 'analytics: blog meta cache read failed');
      return null;
    }
  }

  private async writeCache(blogId: string, meta: BlogAnalyticsMeta): Promise<void> {
    try {
      await this.redis.set(
        blogOwnerKey(blogId),
        JSON.stringify(meta),
        'EX',
        OWNER_CACHE_TTL_SECONDS
      );
    } catch (err) {
      logger.warn({ err, blogId }, 'analytics: blog meta cache write failed');
    }
  }
}

export const analyticsBlogResolver = new AnalyticsBlogResolver();
