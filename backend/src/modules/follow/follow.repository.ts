import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import type { CursorPagination } from '../../core/utils/pagination';

/**
 * Public, non-sensitive user fields surfaced in follower/following lists.
 * Kept here (the only place that reads User rows for this module) so the shape
 * stays consistent between the two list queries.
 */
export const followUserSelect = {
  id: true,
  username: true,
  name: true,
  avatar: true,
  bio: true,
  isVerified: true,
} satisfies Prisma.UserSelect;

/** A Follow row joined with the counterpart user (follower or following). */
export type FollowWithFollower = Prisma.FollowGetPayload<{
  include: { follower: { select: typeof followUserSelect } };
}>;
export type FollowWithFollowing = Prisma.FollowGetPayload<{
  include: { following: { select: typeof followUserSelect } };
}>;

export class FollowRepository {
  /**
   * Idempotent follow. Attempts to create the edge and swallows the unique-
   * constraint violation (P2002) that occurs when the relationship already
   * exists, so a repeat follow is a no-op. Returns whether a new row was created
   * so the service knows whether to emit USER_FOLLOWED.
   */
  async follow(
    followerId: string,
    followingId: string
  ): Promise<{ created: boolean }> {
    try {
      await prisma.follow.create({ data: { followerId, followingId } });
      return { created: true };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { created: false };
      }
      throw err;
    }
  }

  /**
   * Idempotent unfollow. `deleteMany` returns a count instead of throwing when
   * the edge is absent, so unfollowing a non-followed user is a no-op. Returns
   * how many rows were removed (0 or 1).
   */
  async unfollow(
    followerId: string,
    followingId: string
  ): Promise<{ count: number }> {
    const result = await prisma.follow.deleteMany({
      where: { followerId, followingId },
    });
    return { count: result.count };
  }

  /** Whether `followerId` currently follows `followingId`. */
  async exists(followerId: string, followingId: string): Promise<boolean> {
    const row = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Followers of `userId` (rows where they are the `following` side), newest
   * first, with cursor pagination. Fetches `limit + 1` to detect a next page.
   */
  async getFollowers(
    userId: string,
    { cursor, limit }: CursorPagination
  ): Promise<FollowWithFollower[]> {
    return prisma.follow.findMany({
      where: { followingId: userId },
      include: { follower: { select: followUserSelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  /**
   * Users that `userId` follows (rows where they are the `follower` side),
   * newest first, with cursor pagination.
   */
  async getFollowing(
    userId: string,
    { cursor, limit }: CursorPagination
  ): Promise<FollowWithFollowing[]> {
    return prisma.follow.findMany({
      where: { followerId: userId },
      include: { following: { select: followUserSelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  /** Number of followers of `userId`. Index-only via (followingId, createdAt). */
  async countFollowers(userId: string): Promise<number> {
    return prisma.follow.count({ where: { followingId: userId } });
  }

  /** Number of users `userId` follows. Index-only via (followerId, createdAt). */
  async countFollowing(userId: string): Promise<number> {
    return prisma.follow.count({ where: { followerId: userId } });
  }

  /**
   * Of `targetUserIds`, which does `viewerId` already follow? Single batched
   * query used to annotate list items with `isFollowedByViewer` (avoids N+1).
   * Returns the followed subset as a Set for O(1) lookups.
   */
  async getFollowedSubset(
    viewerId: string,
    targetUserIds: string[]
  ): Promise<Set<string>> {
    if (targetUserIds.length === 0) return new Set();
    const rows = await prisma.follow.findMany({
      where: { followerId: viewerId, followingId: { in: targetUserIds } },
      select: { followingId: true },
    });
    return new Set(rows.map((r) => r.followingId));
  }

  /**
   * A bounded batch of follower ids, for fan-out. Ids only — a fan-out needs no
   * profile fields — and always bounded, unlike the ad-hoc unbounded query this
   * was extracted from, which would load every row for a user with 500k followers.
   *
   * Ordered by id (not createdAt) so paging is stable even while new follows
   * arrive mid-fan-out: a keyset walk on a monotonic column cannot revisit or
   * skip rows the way an ordered-by-time cursor can.
   *
   * Filters to ACTIVE followers — suspended and soft-deleted users remain rows
   * and must not receive notifications.
   */
  async getFollowerIdsBatch(
    userId: string,
    { afterId, limit }: { afterId?: string; limit: number }
  ): Promise<{ ids: string[]; nextAfterId: string | null }> {
    const rows = await prisma.follow.findMany({
      where: {
        followingId: userId,
        follower: { status: 'ACTIVE' },
        ...(afterId && { id: { gt: afterId } }),
      },
      select: { id: true, followerId: true },
      orderBy: { id: 'asc' },
      take: limit,
    });

    return {
      ids: rows.map((r) => r.followerId),
      nextAfterId: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }

  /**
   * The set of users `followerId` follows, as a composable SQL SUBQUERY.
   *
   * Exists for the Feed module's following feed, which has to express "blogs by
   * anyone this user follows" inside a single ordered, keyset-paginated query.
   * Returning ids instead would be wrong in both directions at scale: a user
   * following thousands of authors would ship thousands of bind parameters on
   * every page request, and the planner would lose the option of walking the
   * published-blog index in order and filtering — the plan that makes a heavy
   * follower's feed fast.
   *
   * A SQL fragment rather than a leaked table name is the point: the Follow
   * module keeps ownership of what a follow edge looks like and where it is
   * stored, and the consumer composes an opaque `IN (...)` around it. If this
   * graph ever moves to its own store, this method changes and nothing else
   * does.
   *
   * `followerId` is BOUND, not interpolated.
   */
  followedAuthorIdsSql(followerId: string): Prisma.Sql {
    return Prisma.sql`SELECT f."followingId" FROM "Follow" f WHERE f."followerId" = ${followerId}`;
  }

  /**
   * Future-ready: users who follow BOTH `userIdA` and `userIdB` (their mutual
   * followers). Not yet exposed via a route — kept here so the mutual-follow
   * feature can be wired up without touching the data layer.
   */
  async getMutualFollowers(
    userIdA: string,
    userIdB: string,
    { cursor, limit }: CursorPagination
  ): Promise<FollowWithFollower[]> {
    const bFollowerIds = (
      await prisma.follow.findMany({
        where: { followingId: userIdB },
        select: { followerId: true },
      })
    ).map((r) => r.followerId);

    if (bFollowerIds.length === 0) return [];

    return prisma.follow.findMany({
      where: { followingId: userIdA, followerId: { in: bFollowerIds } },
      include: { follower: { select: followUserSelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  /**
   * One page of this user's follow graph in a single direction, for the export.
   *
   * `direction` picks which side: 'following' is who they follow, 'followers'
   * is who follows them. Both are the user's own data — who you chose to follow
   * is yours, and so is the list you were shown as your audience — but only the
   * counterparty's PUBLIC identity is included.
   */
  async findAllForExport(
    userId: string,
    direction: 'followers' | 'following',
    take: number,
    cursorId?: string
  ) {
    const where =
      direction === 'following' ? { followerId: userId } : { followingId: userId };
    const counterparty =
      direction === 'following'
        ? { following: { select: { username: true, name: true } } }
        : { follower: { select: { username: true, name: true } } };

    return prisma.follow.findMany({
      where,
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: { id: true, createdAt: true, ...counterparty },
    });
  }
}

export const followRepository = new FollowRepository();
