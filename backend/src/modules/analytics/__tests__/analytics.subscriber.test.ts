import { eventBus, EVENTS, type DomainEventMeta } from '../../../core/events/eventBus';
import { analyticsIngestionService } from '../ingestion/RedisAnalyticsIngestionService';
import { onBlogPublished, onBlogViewed } from '../subscribers/blog.subscriber';
import {
  onBlogBookmarked,
  onBlogUnbookmarked,
  onCommentCreated,
} from '../subscribers/engagement.subscriber';
import { onUserFollowed, onUserUnfollowed } from '../subscribers/user.subscriber';
import {
  registerAnalyticsSubscribers,
  resetAnalyticsSubscriberRegistration,
} from '../subscribers';

/**
 * The translation layer: domain event → analytics event.
 *
 * Ingestion is mocked, because what is under test here is exclusively the
 * MAPPING — and the mapping is where a mistake is both easy and invisible.
 * Crediting a follow to the follower instead of the followed, or reading
 * `authorId` off a COMMENT_CREATED payload (where it means the commenter, not
 * the blog owner), both produce a full dashboard of plausible, wrong numbers.
 *
 * The payload shapes asserted here are the ones the sibling modules ACTUALLY
 * emit, transcribed from their services — not from the EVENTS comment block,
 * which is documentation and could drift.
 */
jest.mock('../ingestion/RedisAnalyticsIngestionService', () => ({
  analyticsIngestionService: { recordEvent: jest.fn(), recordBatch: jest.fn() },
}));

const ingestion = analyticsIngestionService as jest.Mocked<typeof analyticsIngestionService>;

const META: DomainEventMeta = {
  eventId: 'event-id-1',
  event: 'TEST',
  emittedAt: '2026-08-20T10:00:00.000Z',
};

/** The single analytics event the handler produced. */
const recorded = () => ingestion.recordEvent.mock.calls[0]?.[0];

describe('analytics subscribers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ingestion.recordEvent.mockResolvedValue({ outcome: 'recorded' });
  });

  describe('BLOG_VIEWED', () => {
    it('maps the payload the Blog module emits', async () => {
      await onBlogViewed(
        { blogId: 'blog-1', authorId: 'author-1', slug: 'a-post', userId: 'reader-1' },
        META
      );

      expect(recorded()).toMatchObject({
        eventId: 'event-id-1',
        eventType: 'BLOG_VIEWED',
        entityType: 'BLOG',
        entityId: 'blog-1',
        ownerId: 'author-1',
        userId: 'reader-1',
      });
    });

    it('carries an anonymous reader’s id through', async () => {
      await onBlogViewed(
        { blogId: 'blog-1', authorId: 'author-1', anonymousId: 'anon-1' },
        META
      );

      expect(recorded()).toMatchObject({ anonymousId: 'anon-1' });
      expect(recorded()?.userId).toBeUndefined();
    });

    it('dates the event by when it was EMITTED, not when it was dispatched', async () => {
      await onBlogViewed({ blogId: 'blog-1', authorId: 'author-1' }, META);

      // A view that sat in the queue through midnight — or through a worker
      // outage — belongs to the day it happened on.
      expect(recorded()?.occurredAt).toEqual(new Date('2026-08-20T10:00:00.000Z'));
    });

    it('reuses the bus event id, which is stable across retries', async () => {
      await onBlogViewed({ blogId: 'blog-1', authorId: 'author-1' }, META);

      // This is what makes a redelivered job a no-op rather than a second view.
      expect(recorded()?.eventId).toBe(META.eventId);
    });

    it('ignores a payload with no blog id', async () => {
      await onBlogViewed({ authorId: 'author-1' }, META);

      expect(ingestion.recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('BLOG_PUBLISHED', () => {
    it('is a USER-scoped metric, credited to the author', async () => {
      await onBlogPublished({ blogId: 'blog-1', authorId: 'author-1' }, META);

      // Publishing cadence is a property of the author; the blog's own row
      // starts accumulating when someone reads it.
      expect(recorded()).toMatchObject({
        eventType: 'BLOG_PUBLISHED',
        entityType: 'USER',
        entityId: 'author-1',
      });
    });
  });

  describe('bookmarks', () => {
    it('maps `{ blogId, userId }` — the payload the Bookmark module emits', async () => {
      await onBlogBookmarked({ blogId: 'blog-1', userId: 'reader-1' }, META);

      expect(recorded()).toMatchObject({
        eventType: 'BLOG_BOOKMARKED',
        entityType: 'BLOG',
        entityId: 'blog-1',
        userId: 'reader-1',
      });
    });

    it('leaves ownerId unset, because the event does not carry one', async () => {
      await onBlogBookmarked({ blogId: 'blog-1', userId: 'reader-1' }, META);

      // Resolved by the ingestion service instead, so the Bookmark module never
      // has to load a blog on its write path just to feed a dashboard.
      expect(recorded()?.ownerId).toBeUndefined();
    });

    it('distinguishes an unbookmark', async () => {
      await onBlogUnbookmarked({ blogId: 'blog-1', userId: 'reader-1' }, META);

      expect(recorded()?.eventType).toBe('BLOG_UNBOOKMARKED');
    });
  });

  describe('comments', () => {
    it('credits the BLOG’s author, not the comment’s author', async () => {
      await onCommentCreated(
        {
          blogId: 'blog-1',
          authorId: 'commenter-1', // the COMMENT's author
          blogAuthorId: 'author-1', // the BLOG's author
        },
        META
      );

      // The single easiest mistake in this file: `authorId` on a comment event
      // means the commenter. Reading it as the owner would file every comment
      // under the commenter's own dashboard.
      expect(recorded()).toMatchObject({
        eventType: 'BLOG_COMMENTED',
        entityId: 'blog-1',
        ownerId: 'author-1',
        userId: 'commenter-1',
      });
    });

    it('carries the commenter so a self-comment can be filtered downstream', async () => {
      await onCommentCreated(
        { blogId: 'blog-1', authorId: 'author-1', blogAuthorId: 'author-1' },
        META
      );

      expect(recorded()?.userId).toBe(recorded()?.ownerId);
    });
  });

  describe('follows', () => {
    it('credits the FOLLOWED user, not the follower', async () => {
      await onUserFollowed({ followerId: 'follower-1', followingId: 'followed-1' }, META);

      // Getting this backwards fills every author's growth chart with their own
      // following activity, and the numbers still look plausible.
      expect(recorded()).toMatchObject({
        eventType: 'USER_FOLLOWED',
        entityType: 'USER',
        entityId: 'followed-1',
        ownerId: 'followed-1',
        userId: 'follower-1',
      });
    });

    it('distinguishes an unfollow', async () => {
      await onUserUnfollowed({ followerId: 'follower-1', followingId: 'followed-1' }, META);

      expect(recorded()?.eventType).toBe('USER_UNFOLLOWED');
    });

    it('ignores a payload with no followed user', async () => {
      await onUserUnfollowed({ followerId: 'follower-1' }, META);

      expect(ingestion.recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('registration', () => {
    beforeEach(() => {
      eventBus.clearHandlers();
      resetAnalyticsSubscriberRegistration();
    });

    afterAll(() => {
      eventBus.clearHandlers();
      resetAnalyticsSubscriberRegistration();
    });

    it('subscribes to every event the module consumes', async () => {
      registerAnalyticsSubscribers();

      for (const event of [
        EVENTS.BLOG_VIEWED,
        EVENTS.BLOG_PUBLISHED,
        EVENTS.BLOG_BOOKMARKED,
        EVENTS.BLOG_UNBOOKMARKED,
        EVENTS.COMMENT_CREATED,
        EVENTS.USER_FOLLOWED,
        EVENTS.USER_UNFOLLOWED,
      ]) {
        expect(eventBus.handlerCount(event)).toBe(1);
      }
    });

    it('is idempotent, so a stray import cannot double-count every view', async () => {
      registerAnalyticsSubscribers();
      registerAnalyticsSubscribers();
      registerAnalyticsSubscribers();

      expect(eventBus.handlerCount(EVENTS.BLOG_VIEWED)).toBe(1);
    });

    it('does NOT subscribe to COMMENT_REPLIED, which would double-count replies', async () => {
      registerAnalyticsSubscribers();

      // The Comment module emits COMMENT_CREATED for every new comment AND
      // COMMENT_REPLIED additionally for replies. Subscribing to both would
      // count each reply twice.
      expect(eventBus.handlerCount(EVENTS.COMMENT_REPLIED)).toBe(0);
    });

    it('reaches the ingestion service when a real event is dispatched', async () => {
      registerAnalyticsSubscribers();

      await eventBus.dispatch(
        EVENTS.BLOG_VIEWED,
        { blogId: 'blog-1', authorId: 'author-1', userId: 'reader-1' },
        META
      );

      expect(ingestion.recordEvent).toHaveBeenCalledTimes(1);
    });

    it('survives an ingestion failure without failing the dispatch', async () => {
      registerAnalyticsSubscribers();
      ingestion.recordEvent.mockRejectedValue(new Error('redis down'));

      // A failing analytics subscriber must not fail the job that also carries
      // the notification subscriber's work.
      await expect(
        eventBus.dispatch(EVENTS.BLOG_VIEWED, { blogId: 'b', authorId: 'a' }, META)
      ).resolves.toBeUndefined();
    });
  });
});
