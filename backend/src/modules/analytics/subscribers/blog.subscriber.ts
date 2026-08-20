import { eventBus, EVENTS, type DomainEventMeta } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { analyticsIngestionService } from '../ingestion/RedisAnalyticsIngestionService';
import type { AnalyticsEvent } from '../analytics.types';

/**
 * BLOG_VIEWED and BLOG_PUBLISHED → analytics events.
 *
 * ── What a subscriber is allowed to do ─────────────────────────────────────
 * Translate, and nothing else. It reads a domain payload, builds an
 * `AnalyticsEvent`, and hands it to the ingestion service. It does not
 * deduplicate, does not decide whether a view counts, does not touch Redis, and
 * does not know that PostgreSQL exists. Every one of those decisions lives in
 * `RedisAnalyticsIngestionService`, in one place, applied identically to events
 * arriving from the bus and from the telemetry endpoint.
 *
 * That is also why there is no `switch` here. Each event gets its own named
 * handler registered against its own event name; the dispatch is the event bus's
 * job, and a growing switch statement would just be a second, worse dispatcher.
 *
 * ── Volume ──────────────────────────────────────────────────────────────────
 * BLOG_VIEWED is by a wide margin the highest-volume event on the bus — one per
 * public blog read. Everything on its path is O(1) Redis work with no database
 * access in the common case (the blog's author rides along on the payload, so
 * the resolver is not even consulted).
 */

/**
 * The BLOG_VIEWED payload as the Blog module actually emits it.
 *
 * `slug` is declared but unread: these interfaces describe the CONTRACT, not
 * just the subset this handler happens to use, so a reader can see what is
 * available without opening blog.service.ts. Every field is optional because a
 * payload arriving off the queue is untrusted input, not a typed call.
 */
interface BlogViewedPayload {
  blogId?: string;
  authorId?: string;
  slug?: string;
  userId?: string;
  anonymousId?: string;
}

interface BlogPublishedPayload {
  blogId?: string;
  authorId?: string;
}

export async function onBlogViewed(
  payload: BlogViewedPayload,
  meta: DomainEventMeta
): Promise<void> {
  if (!payload?.blogId) return;

  const event: AnalyticsEvent = {
    eventId: meta.eventId,
    eventType: 'BLOG_VIEWED',
    // The bus's emit time, not the dispatch time. A view that sat in the queue
    // through a midnight rollover — or through a worker outage — belongs to the
    // day it happened on, not the day it was processed on.
    occurredAt: new Date(meta.emittedAt),
    entityType: 'BLOG',
    entityId: payload.blogId,
    ...(payload.authorId && { ownerId: payload.authorId }),
    ...(payload.userId && { userId: payload.userId }),
    ...(payload.anonymousId && { anonymousId: payload.anonymousId }),
  };

  await analyticsIngestionService.recordEvent(event);
}

/**
 * BLOG_PUBLISHED is a USER-scoped metric, not a blog-scoped one: it answers
 * "how often does this author publish", which is a property of the author. The
 * blog's own row starts accumulating when someone reads it.
 */
export async function onBlogPublished(
  payload: BlogPublishedPayload,
  meta: DomainEventMeta
): Promise<void> {
  if (!payload?.authorId) return;

  await analyticsIngestionService.recordEvent({
    eventId: meta.eventId,
    eventType: 'BLOG_PUBLISHED',
    occurredAt: new Date(meta.emittedAt),
    entityType: 'USER',
    entityId: payload.authorId,
    ownerId: payload.authorId,
  });
}

export function registerBlogAnalyticsSubscriber(): void {
  eventBus.on(EVENTS.BLOG_VIEWED, onBlogViewed);
  eventBus.on(EVENTS.BLOG_PUBLISHED, onBlogPublished);

  logger.debug('Analytics blog subscriber registered');
}
