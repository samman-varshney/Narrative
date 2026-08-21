import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { seoRepository } from '../seo.repository';
import { seoService } from '../seo.service';
import { sitemapService } from '../sitemap.service';
import {
  registerSeoSubscribers,
  resetSeoSubscriberRegistration,
} from '../subscribers';

/**
 * Event-driven invalidation.
 *
 * The services are mocked, so what is under test is the MAPPING: which event
 * reaches which tier, what it is given, and that a failure anywhere is
 * swallowed rather than escaping into the job that carried the event.
 */

jest.mock('../seo.service');
jest.mock('../sitemap.service');
jest.mock('../seo.repository');

const service = seoService as jest.Mocked<typeof seoService>;
const sitemap = sitemapService as jest.Mocked<typeof sitemapService>;
const repository = seoRepository as jest.Mocked<typeof seoRepository>;

beforeEach(() => {
  eventBus.clearHandlers();
  resetSeoSubscriberRegistration();
  jest.clearAllMocks();

  service.invalidateForBlog.mockResolvedValue(undefined);
  service.invalidateForAuthor.mockResolvedValue(undefined);
  service.invalidateEverything.mockResolvedValue(undefined);
  sitemap.invalidate.mockResolvedValue(undefined);
  repository.findBlogAuthorId.mockResolvedValue('user-from-lookup');

  registerSeoSubscribers();
});

afterEach(() => {
  eventBus.clearHandlers();
  resetSeoSubscriberRegistration();
});

// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers exactly once however many times it is called', () => {
    registerSeoSubscribers();
    registerSeoSubscribers();

    expect(eventBus.handlerCount(EVENTS.BLOG_PUBLISHED)).toBe(1);
  });

  it('subscribes to no event the platform does not emit', () => {
    // The brief suggested USER_UPDATED, CATEGORY_UPDATED and TAG_UPDATED. None
    // exists in the catalogue, and subscribing to a name that is never emitted
    // is a handler that silently never runs.
    for (const absent of ['USER_UPDATED', 'CATEGORY_UPDATED', 'TAG_UPDATED']) {
      expect(EVENTS).not.toHaveProperty(absent);
      expect(eventBus.handlerCount(absent)).toBe(0);
    }
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
  ])('%s drops the post and its author, never the whole cache', async (event) => {
    await eventBus.dispatch(event, { blogId: 'blog-1', authorId: 'user-1' });

    expect(service.invalidateForBlog).toHaveBeenCalledWith('blog-1', 'user-1');
    expect(service.invalidateEverything).not.toHaveBeenCalled();
  });

  it('ignores BLOG_CREATED — a draft has no public page to invalidate', async () => {
    await eventBus.dispatch(EVENTS.BLOG_CREATED, { blogId: 'blog-1', authorId: 'user-1' });

    expect(service.invalidateForBlog).not.toHaveBeenCalled();
    expect(sitemap.invalidate).not.toHaveBeenCalled();
  });

  it('resolves the author when the payload omits one', async () => {
    await eventBus.dispatch(EVENTS.BLOG_UPDATED, { blogId: 'blog-1' });

    expect(repository.findBlogAuthorId).toHaveBeenCalledWith('blog-1');
    expect(service.invalidateForBlog).toHaveBeenCalledWith('blog-1', 'user-from-lookup');
  });

  it('does not look the author up when the payload carries one', async () => {
    await eventBus.dispatch(EVENTS.BLOG_PUBLISHED, { blogId: 'blog-1', authorId: 'user-1' });
    expect(repository.findBlogAuthorId).not.toHaveBeenCalled();
  });

  it('still drops the post when the author cannot be resolved', async () => {
    repository.findBlogAuthorId.mockRejectedValue(new Error('gone'));

    await eventBus.dispatch(EVENTS.BLOG_DELETED, { blogId: 'blog-1' });
    expect(service.invalidateForBlog).toHaveBeenCalledWith('blog-1', undefined);
  });
});

describe('author changes — per-author invalidation', () => {
  it.each([[EVENTS.USER_PROFILE_UPDATED], [EVENTS.USER_AVATAR_UPDATED]])(
    '%s drops only that profile',
    async (event) => {
      await eventBus.dispatch(event, { userId: 'user-1' });

      expect(service.invalidateForAuthor).toHaveBeenCalledWith('user-1');
      expect(service.invalidateEverything).not.toHaveBeenCalled();
      expect(service.invalidateForBlog).not.toHaveBeenCalled();
    }
  );
});

describe('account status — whole-catalogue invalidation', () => {
  it.each([
    [EVENTS.USER_SUSPENDED],
    [EVENTS.USER_UNSUSPENDED],
    [EVENTS.USER_DEACTIVATED],
    [EVENTS.USER_REACTIVATED],
    [EVENTS.USER_DELETED],
  ])('%s drops everything — a catalogue leaves the index at once', async (event) => {
    await eventBus.dispatch(event, { userId: 'user-1' });

    expect(service.invalidateEverything).toHaveBeenCalledTimes(1);
  });
});

describe('moderation outcomes', () => {
  it.each([[EVENTS.CONTENT_MODERATED], [EVENTS.CONTENT_RESTORED]])(
    '%s on a BLOG drops everything, immediately',
    async (event) => {
      await eventBus.dispatch(event, { targetType: 'BLOG', targetId: 'blog-1' });
      expect(service.invalidateEverything).toHaveBeenCalledTimes(1);
    }
  );

  it('ignores a COMMENT target — comments have no page and no sitemap entry', async () => {
    await eventBus.dispatch(EVENTS.CONTENT_MODERATED, {
      targetType: 'COMMENT',
      targetId: 'comment-1',
    });

    expect(service.invalidateEverything).not.toHaveBeenCalled();
  });
});

describe('taxonomy', () => {
  it('CATEGORY_CREATED refreshes the sitemap alone', async () => {
    await eventBus.dispatch(EVENTS.CATEGORY_CREATED, { categoryId: 'c1', slug: 'engineering' });

    expect(sitemap.invalidate).toHaveBeenCalledTimes(1);
    expect(service.invalidateEverything).not.toHaveBeenCalled();
  });
});

describe('defensiveness', () => {
  it('never throws when an invalidation fails', async () => {
    service.invalidateForBlog.mockRejectedValue(new Error('redis down'));
    service.invalidateForAuthor.mockRejectedValue(new Error('redis down'));
    service.invalidateEverything.mockRejectedValue(new Error('redis down'));
    sitemap.invalidate.mockRejectedValue(new Error('redis down'));

    await expect(
      Promise.all([
        eventBus.dispatch(EVENTS.BLOG_PUBLISHED, { blogId: 'b', authorId: 'u' }),
        eventBus.dispatch(EVENTS.USER_PROFILE_UPDATED, { userId: 'u' }),
        eventBus.dispatch(EVENTS.USER_SUSPENDED, { userId: 'u' }),
        eventBus.dispatch(EVENTS.CATEGORY_CREATED, { categoryId: 'c' }),
      ])
    ).resolves.toBeDefined();
  });

  it('does nothing when a payload is missing its identifier', async () => {
    await eventBus.dispatch(EVENTS.BLOG_PUBLISHED, {});
    await eventBus.dispatch(EVENTS.USER_PROFILE_UPDATED, {});

    expect(service.invalidateForBlog).not.toHaveBeenCalled();
    expect(service.invalidateForAuthor).not.toHaveBeenCalled();
    // Never escalated to a platform-wide flush by a malformed payload.
    expect(service.invalidateEverything).not.toHaveBeenCalled();
  });

  it('survives an undefined payload', async () => {
    await expect(
      eventBus.dispatch(EVENTS.BLOG_PUBLISHED, undefined)
    ).resolves.toBeUndefined();
  });

  it('is idempotent — a redelivered event repeats a no-op', async () => {
    await eventBus.dispatch(EVENTS.BLOG_PUBLISHED, { blogId: 'blog-1', authorId: 'user-1' });
    await eventBus.dispatch(EVENTS.BLOG_PUBLISHED, { blogId: 'blog-1', authorId: 'user-1' });

    expect(service.invalidateForBlog).toHaveBeenNthCalledWith(1, 'blog-1', 'user-1');
    expect(service.invalidateForBlog).toHaveBeenNthCalledWith(2, 'blog-1', 'user-1');
  });
});
