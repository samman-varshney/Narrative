import { Prisma } from '@prisma/client';

jest.mock('../../../core/database/prisma', () => ({
  prisma: {
    blog: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    tag: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    category: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
  },
}));

import { blogRepository } from '../blog.repository';
import { prisma } from '../../../core/database/prisma';

const db = prisma as any;

beforeEach(() => jest.clearAllMocks());

describe('generateUniqueSlug', () => {
  it('returns the base slug when nothing conflicts', async () => {
    db.blog.findMany.mockResolvedValue([]);
    await expect(blogRepository.generateUniqueSlug('my-post')).resolves.toBe('my-post');
    expect(db.blog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ slug: 'my-post' }, { slug: { startsWith: 'my-post-' } }] },
        select: { slug: true },
      })
    );
  });

  it('increments past existing slugs', async () => {
    db.blog.findMany.mockResolvedValue([{ slug: 'my-post' }, { slug: 'my-post-2' }]);
    await expect(blogRepository.generateUniqueSlug('my-post')).resolves.toBe('my-post-3');
  });
});

describe('findByAuthor', () => {
  it('fetches limit + 1 rows, newest-first, with a status filter', async () => {
    db.blog.findMany.mockResolvedValue([]);
    await blogRepository.findByAuthor('author-1', { limit: 20 }, { statuses: ['DRAFT'] });

    expect(db.blog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authorId: 'author-1', status: { in: ['DRAFT'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      })
    );
    // no cursor spread when cursor is absent
    expect(db.blog.findMany.mock.calls[0][0]).not.toHaveProperty('cursor');
  });

  it('applies cursor + skip when a cursor is provided', async () => {
    db.blog.findMany.mockResolvedValue([]);
    await blogRepository.findByAuthor('author-1', { cursor: 'blog-9', limit: 10 });

    expect(db.blog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'blog-9' }, skip: 1, take: 11 })
    );
  });
});

describe('findPublished', () => {
  it('filters to PUBLISHED + PUBLIC and orders by publishedAt', async () => {
    db.blog.findMany.mockResolvedValue([]);
    await blogRepository.findPublished({ limit: 20 });
    expect(db.blog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PUBLISHED', visibility: 'PUBLIC' },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      })
    );
  });
});

describe('upsertTagsByName (get-or-create)', () => {
  it('reuses an existing tag by name and does not create it', async () => {
    db.tag.findUnique.mockResolvedValue({ id: 'tag-existing' });
    const ids = await blogRepository.upsertTagsByName(['TypeScript']);
    expect(ids).toEqual(['tag-existing']);
    expect(db.tag.create).not.toHaveBeenCalled();
  });

  it('creates a new tag with a unique slug when absent', async () => {
    db.tag.findUnique.mockResolvedValue(null); // not found by name
    db.tag.findMany.mockResolvedValue([]); // no slug conflicts
    db.tag.create.mockResolvedValue({ id: 'tag-new' });

    const ids = await blogRepository.upsertTagsByName(['Rust Lang']);

    expect(ids).toEqual(['tag-new']);
    expect(db.tag.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Rust Lang', slug: 'rust-lang' } })
    );
  });

  it('de-duplicates and trims incoming names', async () => {
    db.tag.findUnique.mockResolvedValue({ id: 't' });
    const ids = await blogRepository.upsertTagsByName(['  ts  ', 'ts', '']);
    expect(ids).toEqual(['t']); // one unique non-empty name
  });

  it('recovers from a P2002 name race by re-reading', async () => {
    db.tag.findUnique
      .mockResolvedValueOnce(null) // initial miss
      .mockResolvedValueOnce({ id: 'tag-raced' }); // re-read after conflict
    db.tag.findMany.mockResolvedValue([]);
    db.tag.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '7' })
    );

    const ids = await blogRepository.upsertTagsByName(['concurrent']);
    expect(ids).toEqual(['tag-raced']);
  });
});

describe('findExistingCategoryIds', () => {
  it('short-circuits on an empty list', async () => {
    await expect(blogRepository.findExistingCategoryIds([])).resolves.toEqual([]);
    expect(db.category.findMany).not.toHaveBeenCalled();
  });

  it('returns the ids that exist', async () => {
    db.category.findMany.mockResolvedValue([{ id: 'c1' }]);
    await expect(blogRepository.findExistingCategoryIds(['c1', 'c2'])).resolves.toEqual(['c1']);
  });
});

describe('moderation writers', () => {
  it('moderationDelete hides the blog as well as deleting it', async () => {
    db.blog.updateMany.mockResolvedValue({ count: 1 });

    await expect(blogRepository.moderationDelete('blog-1')).resolves.toBe(true);

    const [call] = db.blog.updateMany.mock.calls;
    // The hide flag is what `assertNotModerated` reads, and it is the ONLY
    // thing standing between a removal and its author undoing it with
    // `POST /blogs/:id/restore`. Asserted on the write itself, because a later
    // refactor that "tidies" it away would silently reopen that door.
    expect(call[0].data).toMatchObject({
      status: 'DELETED',
      isHidden: true,
      hiddenAt: expect.any(Date),
    });
    expect(call[0].where).toEqual({ id: 'blog-1', status: { not: 'DELETED' } });
  });

  it('moderationDelete reports a lost race rather than claiming the write', async () => {
    db.blog.updateMany.mockResolvedValue({ count: 0 });
    await expect(blogRepository.moderationDelete('blog-1')).resolves.toBe(false);
  });

  it('moderationRestore lifts a hide without touching the status', async () => {
    db.blog.updateMany.mockResolvedValue({ count: 1 });

    await blogRepository.moderationRestore('blog-1', { revive: false });

    const [call] = db.blog.updateMany.mock.calls;
    expect(call[0].where).toEqual({
      id: 'blog-1',
      isHidden: true,
      status: { not: 'DELETED' },
    });
    expect(call[0].data).toEqual({ isHidden: false, hiddenAt: null });
    expect(call[0].data).not.toHaveProperty('status');
  });

  it('moderationRestore revives a removal into DRAFT, never back into PUBLISHED', async () => {
    db.blog.updateMany.mockResolvedValue({ count: 1 });

    await blogRepository.moderationRestore('blog-1', { revive: true });

    const [call] = db.blog.updateMany.mock.calls;
    // Both halves of the marker are in the WHERE: a revive must only ever fire
    // on a row that moderation itself removed.
    expect(call[0].where).toEqual({ id: 'blog-1', isHidden: true, status: 'DELETED' });
    expect(call[0].data).toEqual({ isHidden: false, hiddenAt: null, status: 'DRAFT' });
  });
});
