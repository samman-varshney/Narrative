import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { feedService } from '../feed.service';
import { FEED_CACHE_SCOPES } from '../feed.cache';
import {
  registerFeedSubscribers,
  resetFeedSubscriberRegistration,
} from '../subscribers/feed.subscriber';

/**
 * Event integration.
 *
 * Two claims are under test. First, that the feeds react to the events the
 * platform ALREADY emits — no new event was introduced for this module, and
 * these subscriptions are its only inbound coupling. Second, that a failure here
 * cannot escape into the job that carried the event: feed processing is never
 * allowed to affect a blog write.
 */

jest.mock('../feed.service');

const service = feedService as jest.Mocked<typeof feedService>;

beforeEach(() => {
  jest.clearAllMocks();
  eventBus.clearHandlers();
  resetFeedSubscriberRegistration();
  service.invalidateSharedFeeds.mockResolvedValue(undefined);
  service.invalidateFollowingFeed.mockResolvedValue(undefined);
  registerFeedSubscribers();
});

afterAll(() => {
  eventBus.clearHandlers();
  resetFeedSubscriberRegistration();
});

describe('registration', () => {
  it('is idempotent, so a stray import cannot double-bump every generation', () => {
    const before = eventBus.handlerCount(EVENTS.BLOG_PUBLISHED);
    registerFeedSubscribers();
    expect(eventBus.handlerCount(EVENTS.BLOG_PUBLISHED)).toBe(before);
  });

  it('subscribes to existing domain events only', () => {
    // Every event below already existed for the Notification, Search or
    // Analytics modules; Feed invented none of them.
    for (const event of [
      EVENTS.BLOG_PUBLISHED,
      EVENTS.BLOG_UPDATED,
      EVENTS.BLOG_UNPUBLISHED,
      EVENTS.BLOG_ARCHIVED,
      EVENTS.BLOG_RESTORED,
      EVENTS.BLOG_DELETED,
      EVENTS.BLOG_COVER_UPDATED,
      EVENTS.USER_PROFILE_UPDATED,
      EVENTS.USER_AVATAR_UPDATED,
      EVENTS.USER_DELETED,
      EVENTS.USER_FOLLOWED,
      EVENTS.USER_UNFOLLOWED,
    ]) {
      expect(eventBus.handlerCount(event)).toBeGreaterThan(0);
    }
  });
});

describe('blog lifecycle', () => {
  it.each([
    [EVENTS.BLOG_PUBLISHED],
    [EVENTS.BLOG_UPDATED],
    [EVENTS.BLOG_UNPUBLISHED],
    [EVENTS.BLOG_ARCHIVED],
    [EVENTS.BLOG_RESTORED],
    [EVENTS.BLOG_DELETED],
    [EVENTS.BLOG_COVER_UPDATED],
  ])('invalidates every shared feed on %s', async (event) => {
    eventBus.emit(event, { blogId: 'b1', authorId: 'a1' });
    await eventBus.settled();

    expect(service.invalidateSharedFeeds).toHaveBeenCalledWith(FEED_CACHE_SCOPES);
  });

  it('does not touch a viewer feed for a blog event', async () => {
    // Invalidating every follower's cached feed would be a fan-out over an
    // unbounded set on the platform's hottest write. The TTL covers it instead.
    eventBus.emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1', authorId: 'a1' });
    await eventBus.settled();

    expect(service.invalidateFollowingFeed).not.toHaveBeenCalled();
  });
});

describe('user lifecycle', () => {
  it.each([
    [EVENTS.USER_PROFILE_UPDATED],
    [EVENTS.USER_AVATAR_UPDATED],
    [EVENTS.USER_DELETED],
  ])('invalidates every shared feed on %s', async (event) => {
    // A card embeds its author's name, avatar and badge, so a profile edit makes
    // cached BLOG pages stale, not just user-shaped ones.
    eventBus.emit(event, { userId: 'u1' });
    await eventBus.settled();

    expect(service.invalidateSharedFeeds).toHaveBeenCalledWith(FEED_CACHE_SCOPES);
  });
});

describe('follow graph', () => {
  it('drops exactly the follower’s feed on a follow', async () => {
    eventBus.emit(EVENTS.USER_FOLLOWED, { followerId: 'viewer-1', followingId: 'author-1' });
    await eventBus.settled();

    expect(service.invalidateFollowingFeed).toHaveBeenCalledWith('viewer-1');
    expect(service.invalidateFollowingFeed).toHaveBeenCalledTimes(1);
  });

  it('drops it on an unfollow too', async () => {
    eventBus.emit(EVENTS.USER_UNFOLLOWED, { followerId: 'viewer-1', followingId: 'author-1' });
    await eventBus.settled();

    expect(service.invalidateFollowingFeed).toHaveBeenCalledWith('viewer-1');
  });

  it('does not invalidate the shared feeds — the follow graph does not change them', async () => {
    eventBus.emit(EVENTS.USER_FOLLOWED, { followerId: 'viewer-1', followingId: 'author-1' });
    await eventBus.settled();

    expect(service.invalidateSharedFeeds).not.toHaveBeenCalled();
  });

  it('ignores a malformed payload instead of throwing', async () => {
    eventBus.emit(EVENTS.USER_FOLLOWED, { followingId: 'author-1' });
    await eventBus.settled();

    expect(service.invalidateFollowingFeed).not.toHaveBeenCalled();
  });
});

describe('failure isolation', () => {
  it('swallows an invalidation failure rather than failing the event job', async () => {
    service.invalidateSharedFeeds.mockRejectedValue(new Error('redis down'));

    eventBus.emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1', authorId: 'a1' });

    await expect(eventBus.settled()).resolves.toBeUndefined();
  });

  it('swallows a following-feed invalidation failure too', async () => {
    service.invalidateFollowingFeed.mockRejectedValue(new Error('redis down'));

    eventBus.emit(EVENTS.USER_FOLLOWED, { followerId: 'viewer-1', followingId: 'a1' });

    await expect(eventBus.settled()).resolves.toBeUndefined();
  });
});
