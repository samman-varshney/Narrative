jest.mock('../../../core/database/prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
    comment: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
  },
}));

import { prisma } from '../../../core/database/prisma';
import { commentRepository } from '../comment.repository';

const db = prisma as any;

beforeEach(() => jest.clearAllMocks());

describe('create', () => {
  it('inserts then finalizes the materialized path with the generated id', async () => {
    const tx = {
      comment: {
        create: jest.fn().mockResolvedValue({ id: 'new-id' }),
        update: jest.fn().mockResolvedValue({ id: 'new-id', path: 'root/new-id' }),
      },
    };
    db.$transaction.mockImplementation((fn: any) => fn(tx));

    await commentRepository.create({
      blogId: 'b1',
      authorId: 'u1',
      content: 'hi',
      parentId: 'root',
      depth: 1,
      parentPath: 'root',
    });

    expect(tx.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'root', depth: 1 }),
      })
    );
    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'new-id' }, data: { path: 'root/new-id' } })
    );
  });

  it('uses the bare id as the path for a top-level comment', async () => {
    const tx = {
      comment: {
        create: jest.fn().mockResolvedValue({ id: 'top-id' }),
        update: jest.fn().mockResolvedValue({ id: 'top-id', path: 'top-id' }),
      },
    };
    db.$transaction.mockImplementation((fn: any) => fn(tx));

    await commentRepository.create({
      blogId: 'b1',
      authorId: 'u1',
      content: 'hi',
      parentId: null,
      depth: 0,
      parentPath: '',
    });

    expect(tx.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { path: 'top-id' } })
    );
  });
});

describe('write helpers set the right fields', () => {
  it('update marks isEdited and sets editedAt', async () => {
    db.comment.update.mockResolvedValue({});
    await commentRepository.update('c1', 'new content');
    expect(db.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1' },
        data: expect.objectContaining({ content: 'new content', isEdited: true }),
      })
    );
    expect(db.comment.update.mock.calls[0][0].data.editedAt).toBeInstanceOf(Date);
  });

  it('softDelete sets deletedAt; restore clears it', async () => {
    db.comment.update.mockResolvedValue({});
    await commentRepository.softDelete('c1');
    expect(db.comment.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);

    await commentRepository.restore('c1');
    expect(db.comment.update.mock.calls[1][0].data).toEqual({ deletedAt: null });
  });

  it('setHidden toggles isHidden', async () => {
    db.comment.update.mockResolvedValue({});
    await commentRepository.setHidden('c1', true);
    expect(db.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' }, data: { isHidden: true } })
    );
  });
});

describe('reads', () => {
  it('findTopLevel filters parentId null and fetches limit + 1 oldest-first', async () => {
    db.comment.findMany.mockResolvedValue([]);
    await commentRepository.findTopLevel('b1', { limit: 20, cursor: undefined });
    expect(db.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blogId: 'b1', parentId: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 21,
      })
    );
  });

  it('findTopLevel applies the cursor with skip: 1', async () => {
    db.comment.findMany.mockResolvedValue([]);
    await commentRepository.findTopLevel('b1', { limit: 5, cursor: 'c9' });
    expect(db.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'c9' }, skip: 1 })
    );
  });

  it('findChildrenByParentIds short-circuits on an empty id list (no query)', async () => {
    const res = await commentRepository.findChildrenByParentIds([]);
    expect(res).toEqual([]);
    expect(db.comment.findMany).not.toHaveBeenCalled();
  });

  it('findChildrenByParentIds queries parentId IN (...)', async () => {
    db.comment.findMany.mockResolvedValue([]);
    await commentRepository.findChildrenByParentIds(['a', 'b']);
    expect(db.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { parentId: { in: ['a', 'b'] } } })
    );
  });

  it('countBlogComments excludes tombstones', async () => {
    db.comment.count.mockResolvedValue(3);
    await commentRepository.countBlogComments('b1');
    expect(db.comment.count).toHaveBeenCalledWith({
      where: { blogId: 'b1', deletedAt: null },
    });
  });

  it('countRepliesFor groups counts by parent and skips null parents', async () => {
    db.comment.groupBy.mockResolvedValue([
      { parentId: 'a', _count: { _all: 2 } },
      { parentId: null, _count: { _all: 9 } },
    ]);
    const map = await commentRepository.countRepliesFor(['a', 'b']);
    expect(map.get('a')).toBe(2);
    expect(map.has('b')).toBe(false);
    expect([...map.keys()]).not.toContain(null);
  });

  it('countRepliesFor returns an empty map without querying for no ids', async () => {
    const map = await commentRepository.countRepliesFor([]);
    expect(map.size).toBe(0);
    expect(db.comment.groupBy).not.toHaveBeenCalled();
  });
});
