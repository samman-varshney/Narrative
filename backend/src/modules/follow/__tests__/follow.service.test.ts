import { followService } from '../follow.service';
import { followRepository } from '../follow.repository';
import { userRepository } from '../../user/user.repository';
import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { AppError } from '../../../core/exceptions/AppError';

jest.mock('../follow.repository');
jest.mock('../../user/user.repository');
jest.mock('../../../core/events/eventBus');

const mockedFollowRepo = followRepository as jest.Mocked<typeof followRepository>;
const mockedUserRepo = userRepository as jest.Mocked<typeof userRepository>;

describe('FollowService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults; individual tests override as needed.
    mockedUserRepo.findById.mockResolvedValue({ id: 'target' } as any);
    mockedFollowRepo.exists.mockResolvedValue(false);
    mockedFollowRepo.countFollowers.mockResolvedValue(0);
    mockedFollowRepo.countFollowing.mockResolvedValue(0);
  });

  describe('followUser', () => {
    it('rejects self-follow with a 400 SELF_FOLLOW error', async () => {
      await expect(followService.followUser('u1', 'u1')).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'SELF_FOLLOW',
      });
      expect(mockedFollowRepo.follow).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('rejects following a non-existent user with 404', async () => {
      mockedUserRepo.findById.mockResolvedValue(null);
      await expect(followService.followUser('u1', 'ghost')).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'USER_NOT_FOUND',
      });
      expect(mockedFollowRepo.follow).not.toHaveBeenCalled();
    });

    it('creates the edge and emits USER_FOLLOWED exactly once', async () => {
      mockedFollowRepo.follow.mockResolvedValue({ created: true });

      await followService.followUser('u1', 'u2');

      expect(mockedFollowRepo.follow).toHaveBeenCalledWith('u1', 'u2');
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_FOLLOWED, {
        followerId: 'u1',
        followingId: 'u2',
      });
    });

    it('is idempotent: following twice does not re-emit the event', async () => {
      mockedFollowRepo.follow.mockResolvedValue({ created: false }); // already following

      const result = await followService.followUser('u1', 'u2');

      expect(result).toBeDefined(); // still returns status, no throw
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('unfollowUser', () => {
    it('emits USER_UNFOLLOWED when an edge was removed', async () => {
      mockedFollowRepo.unfollow.mockResolvedValue({ count: 1 });

      await followService.unfollowUser('u1', 'u2');

      expect(mockedFollowRepo.unfollow).toHaveBeenCalledWith('u1', 'u2');
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_UNFOLLOWED, {
        followerId: 'u1',
        followingId: 'u2',
      });
    });

    it('is idempotent: unfollowing a non-followed user emits nothing', async () => {
      mockedFollowRepo.unfollow.mockResolvedValue({ count: 0 });

      const result = await followService.unfollowUser('u1', 'u2');

      expect(result).toBeDefined();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('getFollowStatus', () => {
    it('reports isMutual only when both edges exist', async () => {
      mockedFollowRepo.exists
        .mockResolvedValueOnce(true) // viewer -> target
        .mockResolvedValueOnce(true); // target -> viewer
      mockedFollowRepo.countFollowers.mockResolvedValue(42);
      mockedFollowRepo.countFollowing.mockResolvedValue(7);

      const status = await followService.getFollowStatus('viewer', 'target');

      expect(status).toEqual({
        isFollowing: true,
        isFollowedBy: true,
        isMutual: true,
        followersCount: 42,
        followingCount: 7,
      });
    });

    it('reports isMutual false when only one edge exists', async () => {
      mockedFollowRepo.exists
        .mockResolvedValueOnce(true) // viewer -> target
        .mockResolvedValueOnce(false); // target -> viewer

      const status = await followService.getFollowStatus('viewer', 'target');

      expect(status.isFollowing).toBe(true);
      expect(status.isFollowedBy).toBe(false);
      expect(status.isMutual).toBe(false);
    });
  });

  describe('getFollowers list enrichment', () => {
    const rows = [
      {
        id: 'f1',
        createdAt: new Date('2026-01-01'),
        follower: {
          id: 'a',
          username: 'alice',
          name: 'Alice',
          avatar: null,
          bio: null,
          isVerified: false,
        },
      },
      {
        id: 'f2',
        createdAt: new Date('2026-01-02'),
        follower: {
          id: 'b',
          username: 'bob',
          name: 'Bob',
          avatar: null,
          bio: null,
          isVerified: true,
        },
      },
    ];

    it('annotates isFollowedByViewer for an authenticated viewer', async () => {
      mockedFollowRepo.getFollowers.mockResolvedValue(rows as any);
      mockedFollowRepo.countFollowers.mockResolvedValue(2);
      mockedFollowRepo.getFollowedSubset.mockResolvedValue(new Set(['a'])); // viewer follows alice only

      const result = await followService.getFollowers('target', { limit: 20 }, 'viewer');

      expect(mockedFollowRepo.getFollowedSubset).toHaveBeenCalledWith('viewer', ['a', 'b']);
      expect(result.items[0]).toMatchObject({ id: 'a', isFollowedByViewer: true, followedAt: rows[0].createdAt });
      expect(result.items[1]).toMatchObject({ id: 'b', isFollowedByViewer: false });
      expect(result.totalCount).toBe(2);
      expect(result.hasNextPage).toBe(false);
    });

    it('omits isFollowedByViewer entirely for an anonymous viewer', async () => {
      mockedFollowRepo.getFollowers.mockResolvedValue(rows as any);
      mockedFollowRepo.countFollowers.mockResolvedValue(2);

      const result = await followService.getFollowers('target', { limit: 20 });

      expect(mockedFollowRepo.getFollowedSubset).not.toHaveBeenCalled();
      expect(result.items[0]).not.toHaveProperty('isFollowedByViewer');
    });

    it('derives hasNextPage/nextCursor from the sentinel row', async () => {
      // limit 1 but repo returns 2 (limit + 1) → there is a next page
      mockedFollowRepo.getFollowers.mockResolvedValue(rows as any);
      mockedFollowRepo.countFollowers.mockResolvedValue(2);

      const result = await followService.getFollowers('target', { limit: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(true);
      expect(result.nextCursor).toBe('f1'); // id of the last kept row
    });
  });
});
