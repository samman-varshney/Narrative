import { Prisma } from '@prisma/client';
import {
  followRepository,
  FollowWithFollower,
  FollowWithFollowing,
} from './follow.repository';
import { userRepository } from '../user/user.repository';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { buildCursorPage, CursorPagination } from '../../core/utils/pagination';

/** A user as it appears in a followers/following list. */
export interface FollowUserDTO {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  bio: string | null;
  isVerified: boolean;
  /** When the follow edge was created (for the list's ordering context). */
  followedAt: Date;
  /**
   * Whether the requesting viewer follows this user. Present only when the
   * request is authenticated; omitted for anonymous callers.
   */
  isFollowedByViewer?: boolean;
}

/** The relationship between a viewer and a target user, plus target counts. */
export interface FollowStatusDTO {
  isFollowing: boolean;
  isFollowedBy: boolean;
  isMutual: boolean;
  followersCount: number;
  followingCount: number;
}

/** A single page of the followers/following list. */
export interface FollowListResult {
  items: FollowUserDTO[];
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
}

export class FollowService {
  /**
   * Follow `targetId` as `followerId`. Idempotent: following someone already
   * followed succeeds without creating a duplicate or re-emitting the event.
   * The follower is the authenticated user, enforcing "act as yourself".
   */
  async followUser(followerId: string, targetId: string): Promise<FollowStatusDTO> {
    if (followerId === targetId) {
      throw new AppError('You cannot follow yourself', 400, 'SELF_FOLLOW');
    }

    const target = await userRepository.findById(targetId);
    if (!target) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const { created } = await followRepository.follow(followerId, targetId);
    if (created) {
      eventBus.emit(EVENTS.USER_FOLLOWED, { followerId, followingId: targetId });
    }

    return this.getFollowStatus(followerId, targetId);
  }

  /**
   * Unfollow `targetId` as `followerId`. Idempotent: unfollowing someone not
   * followed succeeds and emits nothing.
   */
  async unfollowUser(followerId: string, targetId: string): Promise<FollowStatusDTO> {
    const { count } = await followRepository.unfollow(followerId, targetId);
    if (count > 0) {
      eventBus.emit(EVENTS.USER_UNFOLLOWED, { followerId, followingId: targetId });
    }

    return this.getFollowStatus(followerId, targetId);
  }

  /**
   * Relationship between `viewerId` and `targetId` plus the target's follower/
   * following counts. `isMutual` is true only when both edges exist.
   */
  async getFollowStatus(viewerId: string, targetId: string): Promise<FollowStatusDTO> {
    const [isFollowing, isFollowedBy, followersCount, followingCount] =
      await Promise.all([
        followRepository.exists(viewerId, targetId),
        followRepository.exists(targetId, viewerId),
        followRepository.countFollowers(targetId),
        followRepository.countFollowing(targetId),
      ]);

    return {
      isFollowing,
      isFollowedBy,
      isMutual: isFollowing && isFollowedBy,
      followersCount,
      followingCount,
    };
  }

  /**
   * Both relationship totals for one user, in one call.
   *
   * `getFollowStatus` already returns these, but only alongside a relationship
   * between two users — asking it for your own totals means passing your id
   * twice and paying for two existence checks that answer a question nobody
   * asked. This is the plain "how big is my audience" read, and both counts are
   * served by the composite indexes' leading column.
   */
  async getCounts(userId: string): Promise<{ followers: number; following: number }> {
    const [followers, following] = await Promise.all([
      followRepository.countFollowers(userId),
      followRepository.countFollowing(userId),
    ]);
    return { followers, following };
  }

  /**
   * Paginated followers of `targetId`. When `viewerId` is provided (the caller
   * is authenticated) each item is annotated with `isFollowedByViewer`.
   */
  async getFollowers(
    targetId: string,
    pagination: CursorPagination,
    viewerId?: string
  ): Promise<FollowListResult> {
    const [rows, totalCount] = await Promise.all([
      followRepository.getFollowers(targetId, pagination),
      followRepository.countFollowers(targetId),
    ]);

    const page = buildCursorPage(rows, pagination.limit, (r) => r.id);
    const items = await this.toUserDTOs(
      page.items,
      (r) => r.follower,
      viewerId
    );

    return {
      items,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      totalCount,
    };
  }

  /**
   * Paginated list of users `targetId` follows, with the same viewer annotation.
   */
  async getFollowing(
    targetId: string,
    pagination: CursorPagination,
    viewerId?: string
  ): Promise<FollowListResult> {
    const [rows, totalCount] = await Promise.all([
      followRepository.getFollowing(targetId, pagination),
      followRepository.countFollowing(targetId),
    ]);

    const page = buildCursorPage(rows, pagination.limit, (r) => r.id);
    const items = await this.toUserDTOs(
      page.items,
      (r) => r.following,
      viewerId
    );

    return {
      items,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      totalCount,
    };
  }

  /**
   * The viewer's followed-author set as a composable SQL subquery, for sibling
   * modules that need to express "…by someone I follow" inside their own query.
   *
   * A pass-through to the repository so consumers depend on this module's
   * SERVICE, never on its data layer — the dependency rule in
   * docs/ARCHITECTURE.md § 5. The Feed module is the only caller.
   */
  followedAuthorIdsSql(viewerId: string): Prisma.Sql {
    return followRepository.followedAuthorIdsSql(viewerId);
  }

  /**
   * Of `targetUserIds`, which does `viewerId` follow? One batched query.
   *
   * Exposed for consumers that annotate or filter a page of content by
   * relationship — the Feed module's `excludeFollowing` option on Explore. The
   * batching is the point: the per-item alternative is an N+1 on every feed
   * page.
   */
  getFollowedSubset(viewerId: string, targetUserIds: string[]): Promise<Set<string>> {
    return followRepository.getFollowedSubset(viewerId, targetUserIds);
  }

  /**
   * Maps follow rows to FollowUserDTOs. When `viewerId` is set, performs a single
   * batched lookup to set `isFollowedByViewer` on every item (no N+1).
   */
  private async toUserDTOs<T extends { id: string; createdAt: Date }>(
    rows: T[],
    pickUser: (row: T) => {
      id: string;
      username: string;
      name: string;
      avatar: string | null;
      bio: string | null;
      isVerified: boolean;
    },
    viewerId?: string
  ): Promise<FollowUserDTO[]> {
    const users = rows.map((row) => ({ user: pickUser(row), followedAt: row.createdAt }));

    let followedSet: Set<string> | null = null;
    if (viewerId) {
      followedSet = await followRepository.getFollowedSubset(
        viewerId,
        users.map((u) => u.user.id)
      );
    }

    return users.map(({ user, followedAt }) => ({
      ...user,
      followedAt,
      ...(followedSet && { isFollowedByViewer: followedSet.has(user.id) }),
    }));
  }
}

export const followService = new FollowService();
