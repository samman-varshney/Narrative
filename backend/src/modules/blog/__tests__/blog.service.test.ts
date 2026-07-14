import { blogService } from '../blog.service';
import { blogRepository } from '../blog.repository';
import { userRepository } from '../../user/user.repository';
import { mediaService } from '../../media/media.service';
import { editorParser } from '../../../core/providers/editor/TiptapParser';
import { eventBus, EVENTS } from '../../../core/events/eventBus';

jest.mock('../blog.repository');
jest.mock('../../user/user.repository');
jest.mock('../../media/media.service');
jest.mock('../../../core/providers/editor/TiptapParser');
jest.mock('../../../core/events/eventBus');

const repo = blogRepository as jest.Mocked<typeof blogRepository>;
const users = userRepository as jest.Mocked<typeof userRepository>;
const media = mediaService as jest.Mocked<typeof mediaService>;
const parser = editorParser as jest.Mocked<typeof editorParser>;

const AUTHOR = 'author-1';

function makeBlog(overrides: Partial<any> = {}): any {
  return {
    id: 'blog-1',
    title: 'Hello World',
    slug: 'hello-world',
    subtitle: null,
    content: null,
    coverImage: null,
    coverMediaId: null,
    status: 'DRAFT',
    visibility: 'PUBLIC',
    readingTimeMinutes: 0,
    wordCount: 0,
    charCount: 0,
    readingStats: { headingCount: 0, imageCount: 0, codeBlockCount: 0 },
    authorId: AUTHOR,
    author: {
      id: AUTHOR,
      username: 'alice',
      name: 'Alice',
      avatar: null,
      bio: null,
      isVerified: false,
    },
    tags: [],
    categories: [],
    seo: null,
    publishedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  users.findById.mockResolvedValue({ id: AUTHOR, status: 'ACTIVE' } as any);
  parser.sanitize.mockImplementation((c: any) => c);
  parser.extractMetadata.mockReturnValue({
    wordCount: 5,
    charCount: 20,
    readingTimeMinutes: 1,
    plainText: 'hello world',
    headingCount: 1,
    imageCount: 0,
    codeBlockCount: 0,
  });
  repo.generateUniqueSlug.mockResolvedValue('hello-world');
  repo.upsertTagsByName.mockResolvedValue(['tag-1']);
  repo.findExistingCategoryIds.mockResolvedValue([]);
});

describe('createDraft', () => {
  it('throws 404 when the author does not exist', async () => {
    users.findById.mockResolvedValue(null);
    await expect(blogService.createDraft('ghost', { title: 'x' } as any)).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'USER_NOT_FOUND',
    });
  });

  it('creates a draft, persists reading metadata, and emits BLOG_CREATED', async () => {
    repo.createDraft.mockResolvedValue(makeBlog());

    await blogService.createDraft(AUTHOR, {
      title: 'Hello World',
      content: { type: 'doc', content: [] },
      tags: ['ts'],
    } as any);

    expect(repo.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: AUTHOR,
        slug: 'hello-world',
        tagIds: ['tag-1'],
        reading: expect.objectContaining({
          readingTimeMinutes: 1,
          readingStats: { headingCount: 1, imageCount: 0, codeBlockCount: 0 },
        }),
      })
    );
    expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.BLOG_CREATED, {
      blogId: 'blog-1',
      authorId: AUTHOR,
      slug: 'hello-world',
    });
  });

  it('rejects unknown category ids with 400 INVALID_CATEGORY', async () => {
    repo.findExistingCategoryIds.mockResolvedValue([]); // none exist
    await expect(
      blogService.createDraft(AUTHOR, { title: 'x', categoryIds: ['missing'] } as any)
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_CATEGORY' });
  });
});

describe('ownership', () => {
  it('blocks a non-author, non-admin from updating (403)', async () => {
    repo.findById.mockResolvedValue(makeBlog());
    await expect(
      blogService.updateDraft('blog-1', 'stranger', 'USER', { title: 'x' })
    ).rejects.toMatchObject({ statusCode: 403, errorCode: 'FORBIDDEN' });
  });

  it('allows an admin to update someone else’s blog', async () => {
    repo.findById.mockResolvedValue(makeBlog());
    repo.updateBlog.mockResolvedValue(makeBlog({ title: 'Edited' }));
    const result = await blogService.updateDraft('blog-1', 'admin', 'ADMIN', { title: 'Edited' });
    expect(result.title).toBe('Edited');
  });
});

describe('lifecycle state machine', () => {
  const transitions: Array<[string, 'publish' | 'unpublish' | 'archive' | 'restore', boolean]> = [
    ['DRAFT', 'publish', true],
    ['PUBLISHED', 'publish', false],
    ['ARCHIVED', 'publish', true],
    ['PUBLISHED', 'unpublish', true],
    ['DRAFT', 'unpublish', false],
    ['DRAFT', 'archive', true],
    ['ARCHIVED', 'archive', false],
    ['ARCHIVED', 'restore', true],
    ['PUBLISHED', 'restore', false],
  ];

  it.each(transitions)('%s → %s allowed=%s', async (status, action, allowed) => {
    repo.findById.mockResolvedValue(makeBlog({ status }));
    repo.setStatus.mockResolvedValue(makeBlog({ status: 'PUBLISHED' }));

    const call = (blogService as any)[action]('blog-1', AUTHOR, 'USER');
    if (allowed) {
      await expect(call).resolves.toBeDefined();
    } else {
      await expect(call).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'INVALID_TRANSITION',
      });
    }
  });

  it('softDelete from DELETED is rejected with 409', async () => {
    repo.findById.mockResolvedValue(makeBlog({ status: 'DELETED' }));
    await expect(blogService.softDelete('blog-1', AUTHOR, 'USER')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_TRANSITION',
    });
  });

  it('stamps publishedAt only on the first publish', async () => {
    repo.findById.mockResolvedValue(makeBlog({ status: 'DRAFT', publishedAt: null }));
    repo.setStatus.mockResolvedValue(makeBlog({ status: 'PUBLISHED', publishedAt: new Date() }));

    await blogService.publish('blog-1', AUTHOR, 'USER');

    const [, , opts] = repo.setStatus.mock.calls[0];
    expect(opts?.publishedAt).toBeInstanceOf(Date);
    expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.BLOG_PUBLISHED, expect.any(Object));
  });

  it('does not re-stamp publishedAt when re-publishing from ARCHIVED', async () => {
    const original = new Date('2026-01-01');
    repo.findById.mockResolvedValue(makeBlog({ status: 'ARCHIVED', publishedAt: original }));
    repo.setStatus.mockResolvedValue(makeBlog({ status: 'PUBLISHED', publishedAt: original }));

    await blogService.publish('blog-1', AUTHOR, 'USER');

    const [, , opts] = repo.setStatus.mock.calls[0];
    expect(opts?.publishedAt).toBeUndefined();
  });
});

describe('cover image lifecycle', () => {
  it('uploads via MediaService, retires the previous media, and emits BLOG_COVER_UPDATED', async () => {
    repo.findById.mockResolvedValue(makeBlog({ coverMediaId: 'old-media' }));
    media.uploadCoverImage.mockResolvedValue({ id: 'new-media', secureUrl: 'https://x/new.png' } as any);
    repo.updateCover.mockResolvedValue(makeBlog({ coverImage: 'https://x/new.png', coverMediaId: 'new-media' }));
    media.deleteMedia.mockResolvedValue(undefined as any);

    await blogService.updateCover('blog-1', AUTHOR, 'USER', {} as any);

    expect(media.uploadCoverImage).toHaveBeenCalledWith(AUTHOR, expect.anything());
    expect(repo.updateCover).toHaveBeenCalledWith('blog-1', 'https://x/new.png', 'new-media');
    expect(media.deleteMedia).toHaveBeenCalledWith('old-media', AUTHOR);
    expect(eventBus.emit).toHaveBeenCalledWith(
      EVENTS.BLOG_COVER_UPDATED,
      expect.objectContaining({ blogId: 'blog-1', coverImage: 'https://x/new.png' })
    );
  });
});

describe('getBySlug access control', () => {
  const cases: Array<[string, string, any, boolean]> = [
    ['PUBLISHED', 'PUBLIC', undefined, true],
    ['PUBLISHED', 'UNLISTED', undefined, true],
    ['PUBLISHED', 'PRIVATE', undefined, false],
    ['PUBLISHED', 'MEMBERS_ONLY', undefined, false],
    ['PUBLISHED', 'MEMBERS_ONLY', { userId: 'x', role: 'USER' }, true],
    ['DRAFT', 'PUBLIC', undefined, false],
    ['ARCHIVED', 'PUBLIC', undefined, false],
  ];

  it.each(cases)('%s/%s viewer=%o visible=%s', async (status, visibility, viewer, visible) => {
    repo.findBySlug.mockResolvedValue(makeBlog({ status, visibility }));
    const call = blogService.getBySlug('hello-world', viewer);
    if (visible) {
      await expect(call).resolves.toMatchObject({ slug: 'hello-world' });
    } else {
      await expect(call).rejects.toMatchObject({ statusCode: 404, errorCode: 'BLOG_NOT_FOUND' });
    }
  });

  it('lets the owner see their own draft', async () => {
    repo.findBySlug.mockResolvedValue(makeBlog({ status: 'DRAFT', visibility: 'PRIVATE' }));
    await expect(
      blogService.getBySlug('hello-world', { userId: AUTHOR, role: 'USER' })
    ).resolves.toBeDefined();
  });

  it('returns 404 for a missing slug', async () => {
    repo.findBySlug.mockResolvedValue(null);
    await expect(blogService.getBySlug('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('hides a DELETED blog even from its owner/admin (no stale-URL resurrection)', async () => {
    repo.findBySlug.mockResolvedValue(makeBlog({ status: 'DELETED', visibility: 'PUBLIC' }));
    await expect(
      blogService.getBySlug('hello-world', { userId: AUTHOR, role: 'ADMIN' })
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'BLOG_NOT_FOUND' });
  });
});

describe('SEO defaults (effective at read time)', () => {
  it('derives metaTitle/ogImage/twitterCard when overrides are absent', async () => {
    repo.findBySlug.mockResolvedValue(
      makeBlog({ status: 'PUBLISHED', visibility: 'PUBLIC', coverImage: 'https://x/cover.png', seo: null })
    );
    const dto = await blogService.getBySlug('hello-world');
    expect(dto.seo.metaTitle).toBe('Hello World');
    expect(dto.seo.ogTitle).toBe('Hello World');
    expect(dto.seo.ogImage).toBe('https://x/cover.png');
    expect(dto.seo.twitterCard).toBe('summary_large_image');
  });

  it('writes only the SEO fields provided in an update (no clobber)', async () => {
    repo.findById.mockResolvedValue(makeBlog());
    repo.updateBlog.mockResolvedValue(makeBlog());

    await blogService.updateDraft('blog-1', AUTHOR, 'USER', {
      seo: { metaTitle: 'Only This' },
    });

    const [, data] = repo.updateBlog.mock.calls[0];
    // Patch must contain ONLY metaTitle — omitted keys are left untouched.
    expect(data.seo).toEqual({ metaTitle: 'Only This' });
  });

  it('prefers stored SEO overrides over derived defaults', async () => {
    repo.findBySlug.mockResolvedValue(
      makeBlog({
        status: 'PUBLISHED',
        visibility: 'PUBLIC',
        seo: { metaTitle: 'Custom Title', twitterCard: 'summary' },
      })
    );
    const dto = await blogService.getBySlug('hello-world');
    expect(dto.seo.metaTitle).toBe('Custom Title');
    expect(dto.seo.twitterCard).toBe('summary');
  });
});

describe('autosave', () => {
  it('rejects autosaving a non-draft with 409 NOT_A_DRAFT', async () => {
    repo.findById.mockResolvedValue(makeBlog({ status: 'PUBLISHED' }));
    await expect(
      blogService.autosave('blog-1', AUTHOR, 'USER', { title: 'x' })
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'NOT_A_DRAFT' });
  });

  it('saves a draft and returns the savedAt timestamp without emitting events', async () => {
    const savedAt = new Date('2026-02-02');
    repo.findById.mockResolvedValue(makeBlog({ status: 'DRAFT' }));
    repo.autosave.mockResolvedValue(makeBlog({ updatedAt: savedAt }));

    const result = await blogService.autosave('blog-1', AUTHOR, 'USER', { title: 'x' });

    expect(result.savedAt).toEqual(savedAt);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
