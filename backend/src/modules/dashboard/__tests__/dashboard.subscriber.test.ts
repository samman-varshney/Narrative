import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { currentGeneration, resetGenerationMemo } from '../dashboard.cache';
import {
  registerDashboardSubscribers,
  resetDashboardSubscriberRegistration,
} from '../subscribers';
import { clearDashboardKeys } from './helpers';

/**
 * Cache invalidation, driven by the real event bus and the real test Redis.
 *
 * Under `NODE_ENV=test` the bus dispatches handlers inline, so `emit` followed
 * by `settled()` exercises exactly the path the domain-events worker takes in
 * production — no queue, no mocking of the bus itself.
 *
 * The question each test asks is the one the subscriber exists to answer:
 * **whose** dashboard would now show a different number? Getting that wrong is
 * not a crash, it is a user staring at a number that will not change until a TTL
 * lapses — so it is worth asserting per event rather than in aggregate.
 */

const AUTHOR = 'author-1';
const OTHER = 'other-1';

/** Emits and waits for the inline dispatch the test bus performs. */
async function emit(event: string, payload: unknown): Promise<void> {
  eventBus.emit(event, payload);
  await eventBus.settled();
}

beforeEach(async () => {
  await clearDashboardKeys();
  resetGenerationMemo();
  eventBus.clearHandlers();
  resetDashboardSubscriberRegistration();
  registerDashboardSubscribers();
});

afterAll(async () => {
  await clearDashboardKeys();
  eventBus.clearHandlers();
  resetDashboardSubscriberRegistration();
});

describe('blog lifecycle', () => {
  it.each([
    EVENTS.BLOG_CREATED,
    EVENTS.BLOG_PUBLISHED,
    EVENTS.BLOG_UPDATED,
    EVENTS.BLOG_UNPUBLISHED,
    EVENTS.BLOG_ARCHIVED,
    EVENTS.BLOG_RESTORED,
    EVENTS.BLOG_DELETED,
    EVENTS.BLOG_COVER_UPDATED,
  ])('%s invalidates the author', async (event) => {
    await emit(event, { blogId: 'b1', authorId: AUTHOR });
    expect(await currentGeneration(AUTHOR)).toBe(1);
  });

  it('invalidates nobody else', async () => {
    await emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1', authorId: AUTHOR });
    expect(await currentGeneration(OTHER)).toBe(0);
  });
});

describe('comments', () => {
  it.each([EVENTS.COMMENT_CREATED, EVENTS.COMMENT_REPLIED])(
    '%s invalidates the BLOG author, not the commenter',
    async (event) => {
      await emit(event, {
        commentId: 'c1',
        blogId: 'b1',
        authorId: OTHER, // who wrote the comment
        blogAuthorId: AUTHOR, // whose dashboard changes
      });

      expect(await currentGeneration(AUTHOR)).toBe(1);
      // The commenter's own dashboard shows nothing about comments they left,
      // so bumping them would be a wasted invalidation on every reply.
      expect(await currentGeneration(OTHER)).toBe(0);
    }
  );
});

describe('follows', () => {
  it.each([EVENTS.USER_FOLLOWED, EVENTS.USER_UNFOLLOWED])(
    '%s invalidates BOTH sides',
    async (event) => {
      await emit(event, { followerId: OTHER, followingId: AUTHOR });

      // The followed user's follower count and the follower's own following
      // count live on two different dashboards. Missing either is a user
      // watching a number not change after they changed it.
      expect(await currentGeneration(AUTHOR)).toBe(1);
      expect(await currentGeneration(OTHER)).toBe(1);
    }
  );
});

describe('bookmarks', () => {
  it.each([EVENTS.BLOG_BOOKMARKED, EVENTS.BLOG_UNBOOKMARKED])(
    '%s invalidates the saver',
    async (event) => {
      await emit(event, { blogId: 'b1', userId: OTHER });
      expect(await currentGeneration(OTHER)).toBe(1);
    }
  );
});

describe('what is deliberately not subscribed', () => {
  it('ignores BLOG_VIEWED', async () => {
    await emit(EVENTS.BLOG_VIEWED, {
      blogId: 'b1',
      authorId: AUTHOR,
      slug: 'a-post',
      userId: OTHER,
    });

    // The highest-volume event on the bus. Subscribing would mean a Redis write
    // per page view to invalidate a number that has not moved yet — views reach
    // the database only at the analytics flush, which carries its own
    // generation. See the subscriber's header.
    expect(await currentGeneration(AUTHOR)).toBe(0);
    expect(eventBus.handlerCount(EVENTS.BLOG_VIEWED)).toBe(0);
  });
});

describe('robustness', () => {
  it('survives a payload with no user id', async () => {
    await expect(emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1' })).resolves.toBeUndefined();
    expect(await currentGeneration(AUTHOR)).toBe(0);
  });

  it('survives an undefined payload', async () => {
    await expect(emit(EVENTS.USER_FOLLOWED, undefined)).resolves.toBeUndefined();
  });

  it('registers each handler exactly once however often it is called', async () => {
    registerDashboardSubscribers();
    registerDashboardSubscribers();

    expect(eventBus.handlerCount(EVENTS.BLOG_PUBLISHED)).toBe(1);

    await emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1', authorId: AUTHOR });
    // A double registration would bump twice per event, which is harmless for
    // correctness and wasteful forever.
    expect(await currentGeneration(AUTHOR)).toBe(1);
  });

  it('accumulates across successive events', async () => {
    await emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1', authorId: AUTHOR });
    await emit(EVENTS.COMMENT_CREATED, { blogId: 'b1', blogAuthorId: AUTHOR });
    await emit(EVENTS.USER_FOLLOWED, { followerId: OTHER, followingId: AUTHOR });

    expect(await currentGeneration(AUTHOR)).toBe(3);
  });
});
