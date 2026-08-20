import type { Redis } from 'ioredis';
import { redis as sharedRedis } from '../../../core/providers/redis';
import { env } from '../../../core/config/env';
import { logger } from '../../../core/utils/logger';
import { AnalyticsBuffer, analyticsBuffer } from '../analytics.buffer';
import { AnalyticsBlogResolver, analyticsBlogResolver } from '../analytics.resolver';
import {
  EVENT_DEDUPE_TTL_SECONDS,
  READ_SESSION_TTL_SECONDS,
  eventDedupeKey,
  readQuotaKey,
  readSessionKey,
  viewDedupeKey,
  viewerIdentity,
} from '../analytics.keys';
import { reportingDateKey } from '../analytics.time';
import type { AnalyticsEvent, IngestionResult } from '../analytics.types';
import type { IAnalyticsIngestionService } from './IAnalyticsIngestionService';

/**
 * The Redis-buffered ingestion service — the only implementation today.
 *
 * Sits between the producers (domain-event subscribers, the reading-telemetry
 * endpoint) and the buffer. Everything that makes an analytics number
 * trustworthy happens here: deduplication, self-action filtering, view
 * windowing, reading-session ordering, and duration sanity checks. The buffer
 * below it counts whatever it is told to, and the flush worker moves numbers; by
 * the time data leaves this class it is assumed to be true.
 *
 * ── Non-negotiable property: this can never break a user action ────────────
 * Every path returns an `IngestionResult` instead of throwing, and the callers
 * (subscribers running inside the domain-events worker, a fire-and-forget HTTP
 * handler) swallow the result. A reader must be able to open a blog while Redis
 * is on fire.
 */

/** Below this, a claimed read is a mis-fired timer rather than a read. */
export const MIN_READ_SECONDS = 5;

/** Absolute ceiling on a single claimed read, whatever the post's length. */
export const MAX_READ_SECONDS = 4 * 60 * 60;

/**
 * How far past a post's own estimate a claimed duration is still believed.
 *
 * A reader who pauses, re-reads and thinks is entirely normal, so the multiplier
 * is generous. Past it the value is CLAMPED rather than discarded: the read
 * genuinely happened and should count, it is only the duration that is not
 * credible — and an unclamped one would drag the author's average reading time
 * away from anything useful.
 */
export const READ_DURATION_TOLERANCE = 4;

/** Floor for the estimate a duration is judged against, for very short posts. */
const MIN_ESTIMATED_SECONDS = 60;

/**
 * Reads one client may claim on one blog per dedupe window.
 *
 * A reading session is client-asserted, and a client can mint session ids
 * freely. The ordering guard stops a session being completed twice; this stops
 * ten thousand sessions being opened. High enough that a genuine re-reader never
 * meets it.
 */
export const MAX_READS_PER_WINDOW = 10;

export class RedisAnalyticsIngestionService implements IAnalyticsIngestionService {
  constructor(
    private readonly redis: Redis = sharedRedis,
    private readonly buffer: AnalyticsBuffer = analyticsBuffer,
    private readonly resolver: AnalyticsBlogResolver = analyticsBlogResolver
  ) {}

  async recordEvent(event: AnalyticsEvent): Promise<IngestionResult> {
    try {
      if (!(await this.claimEvent(event.eventId))) {
        return { outcome: 'duplicate-event', reason: 'eventId already processed' };
      }

      switch (event.eventType) {
        case 'BLOG_VIEWED':
          return await this.recordView(event);
        case 'BLOG_READ_STARTED':
          return await this.recordReadStart(event);
        case 'BLOG_READ_COMPLETED':
          return await this.recordReadCompletion(event);
        case 'BLOG_BOOKMARKED':
          return await this.recordBlogCounter(event, 'bookmarks');
        case 'BLOG_UNBOOKMARKED':
          return await this.recordBlogCounter(event, 'unbookmarks');
        case 'BLOG_COMMENTED':
          return await this.recordBlogCounter(event, 'comments');
        case 'BLOG_PUBLISHED':
          return await this.recordUserCounter(event, 'blogsPublished');
        case 'USER_FOLLOWED':
          return await this.recordUserCounter(event, 'followersGained');
        case 'USER_UNFOLLOWED':
          return await this.recordUserCounter(event, 'followersLost');
      }
    } catch (err) {
      // Reaching here means Redis or the resolver failed. One event is lost; the
      // caller carries on. Deliberately NOT rethrown: a retried domain-event job
      // would re-run every OTHER subscriber for that event too, so failing here
      // would turn an analytics outage into duplicate notifications.
      logger.warn(
        { err, eventType: event.eventType, entityId: event.entityId },
        'analytics: event ingestion failed'
      );
      return { outcome: 'buffer-unavailable', reason: 'ingestion infrastructure error' };
    }
  }

  /**
   * Records a batch, sequentially.
   *
   * Sequential on purpose: events in one batch may target the same bucket, and
   * the dedupe/window guards are read-modify-write. Concurrency here would buy
   * nothing (the work is Redis round trips on one connection) and would make the
   * guards racy.
   */
  async recordBatch(events: AnalyticsEvent[]): Promise<IngestionResult[]> {
    const results: IngestionResult[] = [];
    for (const event of events) {
      results.push(await this.recordEvent(event));
    }
    return results;
  }

  // ---- Guards ------------------------------------------------------------

  /**
   * Claims an event id, returning false if it was already processed.
   *
   * `SET NX` is the whole mechanism: the first caller to claim an id wins, and
   * every redelivery of that same BullMQ job — which carries a fixed `eventId`
   * across all five attempts — loses. A processed-events TABLE would be the
   * alternative and is the wrong shape here: it adds a synchronous write per
   * event to the database this module exists to keep out of the hot path, and it
   * would need its own pruning. Redis gives the same guarantee with a TTL that
   * cleans up after itself.
   *
   * FAILS OPEN. If Redis cannot answer, the event is processed. Duplicates are
   * rare (they need a retry) and cost a small over-count; dropping events on a
   * transient Redis blip would lose data permanently. For a metric, the first is
   * the cheaper error.
   */
  private async claimEvent(eventId: string): Promise<boolean> {
    try {
      const claimed = await this.redis.set(
        eventDedupeKey(eventId),
        '1',
        'EX',
        EVENT_DEDUPE_TTL_SECONDS,
        'NX'
      );
      return claimed === 'OK';
    } catch (err) {
      logger.warn({ err, eventId }, 'analytics: dedupe check failed — processing anyway');
      return true;
    }
  }

  /**
   * Is this the owner acting on their own content?
   *
   * Author self-actions are excluded from every metric. An author refreshing
   * their own post, bookmarking it, or replying in its comments is not audience,
   * and counting it means a dashboard that responds to its own reader. This is
   * also the single most common way a brand-new post shows "1 view" before
   * anyone has seen it.
   */
  private isSelfAction(event: AnalyticsEvent, ownerId: string): boolean {
    return !!event.userId && event.userId === ownerId;
  }

  /** The blog's author, from the event if it carried one, else resolved. */
  private async ownerFor(event: AnalyticsEvent): Promise<string | null> {
    if (event.ownerId) return event.ownerId;
    const meta = await this.resolver.resolve(event.entityId);
    return meta?.authorId ?? null;
  }

  /**
   * The blog's estimated reading time, in seconds, floored for very short posts.
   *
   * Resolved once per completion and passed down, rather than looked up again
   * inside the duration check. `ownerFor` returns early when the event already
   * carries an author — which the telemetry endpoint always sets — so without
   * this the completion path would resolve the blog a second time purely to read
   * one number off it.
   */
  private async estimatedSecondsFor(blogId: string): Promise<number> {
    const meta = await this.resolver.resolve(blogId);
    return Math.max(MIN_ESTIMATED_SECONDS, (meta?.readingTimeMinutes ?? 0) * 60);
  }

  // ---- Views -------------------------------------------------------------

  private async recordView(event: AnalyticsEvent): Promise<IngestionResult> {
    const ownerId = await this.ownerFor(event);
    if (!ownerId) {
      return { outcome: 'unresolved-owner', reason: 'blog not found' };
    }
    if (this.isSelfAction(event, ownerId)) {
      return { outcome: 'self-action', reason: 'author viewing own blog' };
    }

    const identity = viewerIdentity(event);
    const date = reportingDateKey(event.occurredAt);

    // No identity at all: an anonymous client that sent no id. The view is real
    // and is counted, but it cannot be deduplicated or attributed to a distinct
    // reader — so it never reaches the HyperLogLog. Under-counting uniques is
    // the honest outcome; the alternative would be inventing an identity from
    // the IP address, which this module deliberately does not do.
    if (!identity) {
      await this.buffer.incrementBlog(event.entityId, ownerId, date, { views: 1 });
      return { outcome: 'recorded' };
    }

    const fresh = await this.redis.set(
      viewDedupeKey(event.entityId, identity),
      '1',
      'EX',
      env.ANALYTICS_VIEW_DEDUPE_SECONDS,
      'NX'
    );

    if (fresh !== 'OK') {
      // Inside the window. Not an error and not fraud — a refresh, a back
      // button, a second tab. Counting it would make "views" mean "page loads",
      // which is the number the brief explicitly does not want.
      return { outcome: 'duplicate-view', reason: 'within dedupe window' };
    }

    await this.buffer.incrementBlog(event.entityId, ownerId, date, { views: 1 });
    await this.buffer.addUniqueViewer(event.entityId, date, identity);

    return { outcome: 'recorded' };
  }

  // ---- Reading -----------------------------------------------------------

  private async recordReadStart(event: AnalyticsEvent): Promise<IngestionResult> {
    const session = this.readSessionOf(event);
    if (!session) {
      return { outcome: 'invalid', reason: 'read event without a session id' };
    }

    const identity = viewerIdentity(event);
    if (!identity) {
      // Reading metrics are session-based, and a session cannot be tracked
      // without something stable to tie it to. Rejecting is right: the
      // alternative is a completion that can never be matched to a start, which
      // would inflate completion counts with unpaired events.
      return { outcome: 'invalid', reason: 'read event without an identity' };
    }

    const ownerId = await this.ownerFor(event);
    if (!ownerId) return { outcome: 'unresolved-owner', reason: 'blog not found' };
    if (this.isSelfAction(event, ownerId)) {
      return { outcome: 'self-action', reason: 'author reading own blog' };
    }

    if (!(await this.withinReadQuota(event.entityId, identity))) {
      return { outcome: 'invalid', reason: 'read session quota exceeded' };
    }

    // The session marker. Its EXISTENCE is what makes a later completion
    // believable, and its TTL is what stops a tab left open overnight from
    // being completed the next day.
    await this.redis.set(
      readSessionKey(event.entityId, identity, session.sessionId),
      String(event.occurredAt.getTime()),
      'EX',
      READ_SESSION_TTL_SECONDS
    );

    await this.buffer.incrementBlog(event.entityId, ownerId, reportingDateKey(event.occurredAt), {
      readStarts: 1,
    });

    return { outcome: 'recorded' };
  }

  private async recordReadCompletion(event: AnalyticsEvent): Promise<IngestionResult> {
    const session = this.readSessionOf(event);
    if (!session) {
      return { outcome: 'invalid', reason: 'read event without a session id' };
    }

    const identity = viewerIdentity(event);
    if (!identity) {
      return { outcome: 'invalid', reason: 'read event without an identity' };
    }

    const ownerId = await this.ownerFor(event);
    if (!ownerId) return { outcome: 'unresolved-owner', reason: 'blog not found' };
    if (this.isSelfAction(event, ownerId)) {
      return { outcome: 'self-action', reason: 'author reading own blog' };
    }

    // Consuming the session marker enforces ORDERING and UNIQUENESS in one
    // atomic step: a completion with no start finds nothing, and a second
    // completion for the same session finds nothing either because the first one
    // took it. Without this, a client could post completions in a loop and every
    // one would count.
    const consumed = await this.consumeReadSession(event.entityId, identity, session.sessionId);
    if (consumed === null) {
      return { outcome: 'out-of-order', reason: 'no open reading session' };
    }

    const duration = this.validatedDuration(
      session.durationSeconds,
      consumed,
      event.occurredAt,
      await this.estimatedSecondsFor(event.entityId)
    );
    if (duration === null) {
      return { outcome: 'invalid', reason: 'implausible reading duration' };
    }

    await this.buffer.incrementBlog(event.entityId, ownerId, reportingDateKey(event.occurredAt), {
      readCompletions: 1,
      totalReadingSeconds: duration,
    });

    return { outcome: 'recorded' };
  }

  /** Narrows the metadata union to the reading shape. */
  private readSessionOf(
    event: AnalyticsEvent
  ): { sessionId: string; durationSeconds?: number } | null {
    const metadata = event.metadata;
    if (!metadata || metadata.kind !== 'read' || !metadata.sessionId) return null;
    return metadata.durationSeconds === undefined
      ? { sessionId: metadata.sessionId }
      : { sessionId: metadata.sessionId, durationSeconds: metadata.durationSeconds };
  }

  /**
   * Atomically reads and removes a session marker, returning the start time it
   * held (epoch ms) or null if there was none.
   *
   * `MULTI`/`EXEC` rather than `GETDEL` so this works on Redis below 6.2 — the
   * project pins no Redis version, and a silent `unknown command` here would
   * make every completion look out-of-order.
   */
  private async consumeReadSession(
    blogId: string,
    identity: string,
    sessionId: string
  ): Promise<number | null> {
    const key = readSessionKey(blogId, identity, sessionId);
    const replies = await this.redis.multi().get(key).del(key).exec();

    const raw = replies?.[0]?.[1];
    if (typeof raw !== 'string') return null;

    const startedAt = Number.parseInt(raw, 10);
    return Number.isFinite(startedAt) ? startedAt : null;
  }

  /**
   * Turns a claimed duration into one worth storing, or null to reject.
   *
   * Client-reported time is never trusted directly. Three things constrain it:
   *
   *  1. The SERVER's own measurement — the gap between the start we recorded and
   *     the completion arriving — is an upper bound the client cannot inflate,
   *     because we timestamped both ends. A claim above it is impossible.
   *  2. The post's own reading estimate bounds what is plausible, generously.
   *  3. An absolute floor and ceiling catch mis-fired timers either way.
   *
   * Rejection is reserved for durations too SHORT to be a read. Over-long ones
   * are clamped, because the completion itself is still real — only the number
   * attached to it is not.
   */
  private validatedDuration(
    claimed: number | undefined,
    startedAtMs: number,
    completedAt: Date,
    estimatedSeconds: number
  ): number | null {
    // No claim at all: fall back entirely to the server-measured elapsed time.
    const serverElapsed = Math.max(0, Math.round((completedAt.getTime() - startedAtMs) / 1000));
    const value = claimed === undefined ? serverElapsed : claimed;

    if (!Number.isFinite(value) || value < MIN_READ_SECONDS) return null;

    // `serverElapsed + 1` absorbs sub-second rounding at both timestamps; without
    // it a perfectly honest client is occasionally clamped by one second.
    return Math.min(
      value,
      serverElapsed + 1,
      estimatedSeconds * READ_DURATION_TOLERANCE,
      MAX_READ_SECONDS
    );
  }

  /** Rate-caps reading sessions per reader per blog. See MAX_READS_PER_WINDOW. */
  private async withinReadQuota(blogId: string, identity: string): Promise<boolean> {
    const key = readQuotaKey(blogId, identity);
    const replies = await this.redis
      .multi()
      .incr(key)
      .expire(key, env.ANALYTICS_VIEW_DEDUPE_SECONDS)
      .exec();

    const count = replies?.[0]?.[1];
    return typeof count !== 'number' || count <= MAX_READS_PER_WINDOW;
  }

  // ---- Simple counters ---------------------------------------------------

  private async recordBlogCounter(
    event: AnalyticsEvent,
    field: 'bookmarks' | 'unbookmarks' | 'comments'
  ): Promise<IngestionResult> {
    const ownerId = await this.ownerFor(event);
    if (!ownerId) return { outcome: 'unresolved-owner', reason: 'blog not found' };
    if (this.isSelfAction(event, ownerId)) {
      return { outcome: 'self-action', reason: `author ${field} on own blog` };
    }

    await this.buffer.incrementBlog(event.entityId, ownerId, reportingDateKey(event.occurredAt), {
      [field]: 1,
    });
    return { outcome: 'recorded' };
  }

  private async recordUserCounter(
    event: AnalyticsEvent,
    field: 'followersGained' | 'followersLost' | 'blogsPublished'
  ): Promise<IngestionResult> {
    await this.buffer.incrementUser(event.entityId, reportingDateKey(event.occurredAt), {
      [field]: 1,
    });
    return { outcome: 'recorded' };
  }
}

export const analyticsIngestionService: IAnalyticsIngestionService =
  new RedisAnalyticsIngestionService();
