import { Prisma } from '@prisma/client';
import { followRepository } from '../follow.repository';
import { prisma } from '../../../core/database/prisma';

jest.mock('../../../core/database/prisma', () => ({
  prisma: {
    follow: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

const followDelegate = (prisma as unknown as {
  follow: {
    create: jest.Mock;
    deleteMany: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
}).follow;

describe('FollowRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('follow', () => {
    it('returns { created: true } when a new edge is inserted', async () => {
      followDelegate.create.mockResolvedValue({ id: 'f1' });

      const result = await followRepository.follow('u1', 'u2');

      expect(followDelegate.create).toHaveBeenCalledWith({
        data: { followerId: 'u1', followingId: 'u2' },
      });
      expect(result).toEqual({ created: true });
    });

    it('swallows P2002 and returns { created: false } (idempotent)', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
      followDelegate.create.mockRejectedValue(p2002);

      const result = await followRepository.follow('u1', 'u2');

      expect(result).toEqual({ created: false });
    });

    it('re-throws non-P2002 errors', async () => {
      followDelegate.create.mockRejectedValue(new Error('db down'));
      await expect(followRepository.follow('u1', 'u2')).rejects.toThrow('db down');
    });
  });

  describe('unfollow', () => {
    it('uses deleteMany and returns the affected count', async () => {
      followDelegate.deleteMany.mockResolvedValue({ count: 1 });

      const result = await followRepository.unfollow('u1', 'u2');

      expect(followDelegate.deleteMany).toHaveBeenCalledWith({
        where: { followerId: 'u1', followingId: 'u2' },
      });
      expect(result).toEqual({ count: 1 });
    });
  });

  describe('exists', () => {
    it('queries the composite unique key and returns a boolean', async () => {
      followDelegate.findUnique.mockResolvedValue({ id: 'f1' });

      const result = await followRepository.exists('u1', 'u2');

      expect(followDelegate.findUnique).toHaveBeenCalledWith({
        where: { followerId_followingId: { followerId: 'u1', followingId: 'u2' } },
        select: { id: true },
      });
      expect(result).toBe(true);
    });

    it('returns false when no row is found', async () => {
      followDelegate.findUnique.mockResolvedValue(null);
      expect(await followRepository.exists('u1', 'u2')).toBe(false);
    });
  });

  describe('getFollowers (cursor pagination)', () => {
    it('fetches limit+1 rows ordered by createdAt without a cursor', async () => {
      followDelegate.findMany.mockResolvedValue([]);

      await followRepository.getFollowers('target', { limit: 20 });

      expect(followDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { followingId: 'target' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        })
      );
      // No cursor supplied → no cursor/skip keys.
      const arg = followDelegate.findMany.mock.calls[0][0];
      expect(arg).not.toHaveProperty('cursor');
      expect(arg).not.toHaveProperty('skip');
    });

    it('adds cursor + skip:1 when a cursor is supplied', async () => {
      followDelegate.findMany.mockResolvedValue([]);

      await followRepository.getFollowers('target', { cursor: 'f10', limit: 5 });

      expect(followDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 6,
          cursor: { id: 'f10' },
          skip: 1,
        })
      );
    });
  });

  describe('count queries', () => {
    it('countFollowers filters on followingId', async () => {
      followDelegate.count.mockResolvedValue(3);
      expect(await followRepository.countFollowers('target')).toBe(3);
      expect(followDelegate.count).toHaveBeenCalledWith({ where: { followingId: 'target' } });
    });

    it('countFollowing filters on followerId', async () => {
      followDelegate.count.mockResolvedValue(9);
      expect(await followRepository.countFollowing('target')).toBe(9);
      expect(followDelegate.count).toHaveBeenCalledWith({ where: { followerId: 'target' } });
    });
  });

  describe('getFollowedSubset', () => {
    it('short-circuits without a query for an empty id list', async () => {
      const result = await followRepository.getFollowedSubset('viewer', []);
      expect(result).toEqual(new Set());
      expect(followDelegate.findMany).not.toHaveBeenCalled();
    });

    it('returns the followed ids as a Set', async () => {
      followDelegate.findMany.mockResolvedValue([{ followingId: 'a' }, { followingId: 'c' }]);

      const result = await followRepository.getFollowedSubset('viewer', ['a', 'b', 'c']);

      expect(followDelegate.findMany).toHaveBeenCalledWith({
        where: { followerId: 'viewer', followingId: { in: ['a', 'b', 'c'] } },
        select: { followingId: true },
      });
      expect(result).toEqual(new Set(['a', 'c']));
    });
  });
});
