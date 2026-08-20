import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { rssService } from '../rss.service';
import {
  registerRssSubscribers,
  resetRssSubscriberRegistration,
} from '../subscribers';

/**
 * Event integration.
 *
 * What is under test is the MAPPING — which event reaches which tier of
 * invalidation — and the defensive contract every subscriber on this platform
 * owes its producer: registered once, idempotent, and unable to fail the job
 * that carried the event.
 *
 * The service is mocked; that invalidation actually clears a cached document is
 * established in `rss.cache.test.ts` and `rss.e2e.test.ts`.
 */

jest.mock('../rss.service', () => ({
  rssService: {
    invalidateForBlog: jest.fn().mockResolvedValue(undefined),
    invalidateForAuthor: jest.fn().mockResolvedValue(undefined),
    invalidateEverything: jest.fn().mockResolvedValue(undefined),
  },
}));

const mocked = rssService as jest.Mocked<typeof rssService>;

beforeEach(() => {
  eventBus.clearHandlers();
  resetRssSubscriberRegistration();
  jest.clearAllMocks();
  registerRssSubscribers();
});

afterAll(() => {
  eventBus.clearHandlers();
  resetRssSubscriberRegistration();
});

const emit = async (event: string, payload?: unknown) => {
  eventBus.emit(event, payload);
  await eventBus.settled();
};

describe('registration', () => {
  it('registers exactly one handler per subscribed event', () => {
    expect(eventBus.handlerCount(EVENTS.BLOG_PUBLISHED)).toBe(1);
    expect(eventBus.handlerCount(EVENTS.USER_SUSPENDED)).toBe(1);
    expect(eventBus.handlerCount(EVENTS.CONTENT_MODERATED)).toBe(1);
  });

  it('ignores a second registration, so a stray import cannot double-bump', () => {
    registerRssSubscribers();
    registerRssSubscribers();
    expect(eventBus.handlerCount(EVENTS.BLOG_PUBLISHED)).toBe(1);
  });

  it('subscribes to nothing it does not need', () => {
    // A new post is a DRAFT, which no feed can contain. Invalidating on it
    // would drop the platform's cache on its most frequent content write for no
    // possible change in output.
    expect(eventBus.handlerCount(EVENTS.BLOG_CREATED)).toBe(0);
    expect(eventBus.handlerCount(EVENTS.BLOG_VIEWED)).toBe(0);
    expect(eventBus.handlerCount(EVENTS.COMMENT_CREATED)).toBe(0);
    expect(eventBus.handlerCount(EVENTS.BLOG_BOOKMARKED)).toBe(0);
  });
});

describe('blog lifecycle — targeted invalidation', () => {
  it.each([
    [EVENTS.BLOG_PUBLISHED],
    [EVENTS.BLOG_UPDATED],
    [EVENTS.BLOG_UNPUBLISHED],
    [EVENTS.BLOG_ARCHIVED],
    [EVENTS.BLOG_RESTORED],
    [EVENTS.BLOG_DELETED],
    [EVENTS.BLOG_COVER_UPDATED],
  ])('invalidates only the feeds %s can affect', async (event) => {
    await emit(event, { blogId: 'b1', authorId: 'u1' });

    expect(mocked.invalidateForBlog).toHaveBeenCalledWith('b1', 'u1');
    // The whole point of the targeted tier: publishing one post must not drop
    // every author, tag and category feed on the platform.
    expect(mocked.invalidateEverything).not.toHaveBeenCalled();
  });

  it('does nothing when a payload carries no blog id', async () => {
    await emit(EVENTS.BLOG_PUBLISHED, { authorId: 'u1' });

    expect(mocked.invalidateForBlog).not.toHaveBeenCalled();
    // Notably it does NOT escalate to a root bump: an unknown payload shape is
    // a bug to fix, not a reason to flush the cache on every delivery.
    expect(mocked.invalidateEverything).not.toHaveBeenCalled();
  });

  it('does not crash on a missing payload', async () => {
    await expect(emit(EVENTS.BLOG_PUBLISHED, undefined)).resolves.toBeUndefined();
    expect(mocked.invalidateForBlog).not.toHaveBeenCalled();
  });
});

describe('author changes — per-author invalidation', () => {
  it.each([[EVENTS.USER_PROFILE_UPDATED], [EVENTS.USER_AVATAR_UPDATED]])(
    'invalidates the author scope for %s',
    async (event) => {
      await emit(event, { userId: 'u1' });

      expect(mocked.invalidateForAuthor).toHaveBeenCalledWith('u1');
      expect(mocked.invalidateEverything).not.toHaveBeenCalled();
    }
  );

  it('does nothing without a user id', async () => {
    await emit(EVENTS.USER_PROFILE_UPDATED, {});
    expect(mocked.invalidateForAuthor).not.toHaveBeenCalled();
  });
});

describe('account status — whole-catalogue invalidation', () => {
  it.each([
    [EVENTS.USER_SUSPENDED],
    [EVENTS.USER_UNSUSPENDED],
    [EVENTS.USER_DEACTIVATED],
    [EVENTS.USER_REACTIVATED],
    [EVENTS.USER_DELETED],
  ])('drops every cached feed for %s', async (event) => {
    // Eligibility already gates on `u."status" = 'ACTIVE'`, so the account
    // leaves discovery on the next uncached read. What this closes is the
    // window in which an already-cached document keeps being served — and
    // re-served to conditional requests as a 304.
    await emit(event, { userId: 'u1' });
    expect(mocked.invalidateEverything).toHaveBeenCalledTimes(1);
  });
});

describe('moderation outcomes', () => {
  it.each([[EVENTS.CONTENT_MODERATED], [EVENTS.CONTENT_RESTORED]])(
    'drops every cached feed when %s targets a blog',
    async (event) => {
      await emit(event, { targetType: 'BLOG', targetId: 'b1', ownerId: 'u1' });
      expect(mocked.invalidateEverything).toHaveBeenCalledTimes(1);
    }
  );

  it('ignores comment moderation, which is not syndicated', async () => {
    await emit(EVENTS.CONTENT_MODERATED, { targetType: 'COMMENT', targetId: 'c1' });
    expect(mocked.invalidateEverything).not.toHaveBeenCalled();
  });

  it('ignores a moderation event with no target type', async () => {
    await emit(EVENTS.CONTENT_MODERATED, {});
    expect(mocked.invalidateEverything).not.toHaveBeenCalled();
  });
});

describe('defensiveness', () => {
  it('never lets a failed invalidation escape into the producer', async () => {
    // These run in the domain-events worker. A throw would fail the job and
    // have it retried — for a cache bump whose failure costs at most one TTL of
    // staleness.
    mocked.invalidateForBlog.mockRejectedValueOnce(new Error('redis down'));
    await expect(emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1' })).resolves.toBeUndefined();

    mocked.invalidateEverything.mockRejectedValueOnce(new Error('redis down'));
    await expect(emit(EVENTS.USER_SUSPENDED, { userId: 'u1' })).resolves.toBeUndefined();

    mocked.invalidateForAuthor.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      emit(EVENTS.USER_PROFILE_UPDATED, { userId: 'u1' })
    ).resolves.toBeUndefined();
  });

  it('is idempotent under redelivery', async () => {
    // The domain-events queue is at-least-once. Bumping a generation twice is
    // indistinguishable from bumping it once — what invalidates a key is the
    // number CHANGING, not its value — so there is nothing to deduplicate.
    await emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1', authorId: 'u1' });
    await emit(EVENTS.BLOG_PUBLISHED, { blogId: 'b1', authorId: 'u1' });

    expect(mocked.invalidateForBlog).toHaveBeenCalledTimes(2);
    expect(mocked.invalidateForBlog).toHaveBeenNthCalledWith(2, 'b1', 'u1');
  });
});
