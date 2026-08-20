import { EVENTS, eventBus } from '../../../core/events/eventBus';
import { hasDedicatedLimiter } from '../../../core/middlewares/rateLimiter';
import { bumpGeneration } from '../search.cache';
import {
  registerSearchSubscribers,
  resetSearchSubscriberRegistration,
} from '../subscribers';

jest.mock('../search.cache', () => ({
  bumpGeneration: jest.fn().mockResolvedValue(undefined),
}));

const bumped = bumpGeneration as jest.MockedFunction<typeof bumpGeneration>;

/** Scopes bumped by whichever handler ran, flattened and de-duplicated. */
function bumpedScopes(): string[] {
  return [...new Set(bumped.mock.calls.flatMap(([scopes]) => scopes))].sort();
}

describe('search cache subscribers', () => {
  beforeEach(() => {
    eventBus.clearHandlers();
    resetSearchSubscriberRegistration();
    jest.clearAllMocks();
    registerSearchSubscribers();
  });

  afterAll(() => {
    eventBus.clearHandlers();
    resetSearchSubscriberRegistration();
  });

  describe('registration', () => {
    it('is idempotent, so a stray import cannot double-bump every generation', () => {
      const before = eventBus.handlerCount(EVENTS.BLOG_PUBLISHED);

      registerSearchSubscribers();
      registerSearchSubscribers();

      expect(eventBus.handlerCount(EVENTS.BLOG_PUBLISHED)).toBe(before);
    });
  });

  describe('blog lifecycle', () => {
    it.each([
      EVENTS.BLOG_CREATED,
      EVENTS.BLOG_UPDATED,
      EVENTS.BLOG_PUBLISHED,
      EVENTS.BLOG_UNPUBLISHED,
      EVENTS.BLOG_ARCHIVED,
      EVENTS.BLOG_RESTORED,
      EVENTS.BLOG_DELETED,
      EVENTS.BLOG_COVER_UPDATED,
    ])('%s invalidates the blog-facing scopes', async (event) => {
      await eventBus.dispatch(event, { blogId: 'b1', authorId: 'a1' });

      expect(bumpedScopes()).toEqual(['blogs', 'global', 'suggestions', 'tags']);
    });
  });

  describe('user lifecycle', () => {
    it.each([
      EVENTS.USER_PROFILE_UPDATED,
      EVENTS.USER_AVATAR_UPDATED,
      EVENTS.USER_SETTINGS_UPDATED,
      EVENTS.USER_DELETED,
    ])('%s also invalidates BLOG results', async (event) => {
      await eventBus.dispatch(event, { userId: 'u1' });

      // A blog hit embeds the author's username, name, avatar and verified
      // badge — so a profile edit makes cached BLOG results stale, not just
      // cached user results. Missing this leaves a renamed author showing their
      // old name in search for the life of the entry.
      expect(bumpedScopes()).toEqual(['blogs', 'global', 'suggestions', 'users']);
    });

    it('invalidates on a settings change, which carries the isPrivate toggle', async () => {
      // isPrivate decides whether a user appears in search at all, so this is a
      // correctness requirement, not a freshness nicety.
      await eventBus.dispatch(EVENTS.USER_SETTINGS_UPDATED, { userId: 'u1' });

      expect(bumpedScopes()).toContain('users');
    });
  });

  describe('taxonomy', () => {
    it('CATEGORY_CREATED invalidates the category vocabulary', async () => {
      await eventBus.dispatch(EVENTS.CATEGORY_CREATED, { categoryId: 'c1', name: 'DevOps' });

      expect(bumpedScopes()).toEqual(['categories', 'global', 'suggestions']);
    });
  });

  describe('isolation', () => {
    it('ignores events the module has no stake in', async () => {
      await eventBus.dispatch(EVENTS.USER_FOLLOWED, { followerId: 'a', followingId: 'b' });
      await eventBus.dispatch(EVENTS.COMMENT_CREATED, { commentId: 'c1' });
      await eventBus.dispatch(EVENTS.BLOG_BOOKMARKED, { blogId: 'b1', userId: 'u1' });

      expect(bumped).not.toHaveBeenCalled();
    });

    it('never fails the job carrying the event when invalidation throws', async () => {
      bumped.mockRejectedValueOnce(new Error('redis down'));

      // The consequence of a failed bump is a stale entry for at most its TTL —
      // which is exactly what the TTL is there to bound.
      await expect(
        eventBus.dispatch(EVENTS.BLOG_PUBLISHED, { blogId: 'b1' })
      ).resolves.toBeUndefined();
    });
  });
});

describe('search rate-limit exemption', () => {
  it.each([
    ['/api/v1/search', true],
    ['/api/v1/search/blogs?q=js', true],
    ['/api/v1/search/suggestions?q=j', true],
    ['/api/v1/blogs', false],
    ['/api/v1/users/search?q=js', false],
    ['/api/v1/notifications', false],
  ])('%s -> exempt=%s', (originalUrl, expected) => {
    // Search must be exempt from the global /api limiter: at 100 requests per 15
    // minutes that limiter is TIGHTER than searchLimiter's 60/minute, which would
    // break typeahead and make the dedicated limiter unreachable.
    expect(hasDedicatedLimiter({ originalUrl })).toBe(expected);
  });

  it('treats a missing originalUrl as not exempt', () => {
    expect(hasDedicatedLimiter({})).toBe(false);
  });
});
