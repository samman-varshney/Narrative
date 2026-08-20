import { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../../core/database/prisma';

export class UserRepository {
  async create(data: Prisma.UserCreateInput) {
    return prisma.user.create({ data });
  }

  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  async findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  }

  async findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }

  /**
   * Account status only.
   *
   * Exists because the auth guard runs this on every write request and
   * `findById` selects the whole row — password hash, bio, avatar — to answer a
   * one-enum question. Primary-key lookup, index-only apart from the heap fetch.
   */
  async findStatusById(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { id: true, status: true } });
  }

  /**
   * Moderation-facing account summary: everything an administrator needs to
   * judge an account, and nothing that would leak more than that (no password
   * hash, no email — see the DTO in the moderation module).
   */
  async findModerationSummaryById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        name: true,
        avatar: true,
        role: true,
        status: true,
        isVerified: true,
        suspendedAt: true,
        suspendedReason: true,
        createdAt: true,
        _count: { select: { blogs: true, comments: true, followers: true } },
      },
    });
  }

  /**
   * Public-facing identity for many users in ONE query, keyed by id.
   *
   * The moderation queue renders a reporter and a target owner on every row;
   * without a batched lookup that is two queries per row — the N+1 a polymorphic
   * target invites. Returns only fields that are already public on a profile.
   */
  async findPublicByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        username: true,
        name: true,
        avatar: true,
        role: true,
        status: true,
        isVerified: true,
      },
    });
  }

  /**
   * Conditional status transition: writes `next` only if the row is currently in
   * `expected`, and reports whether it did.
   *
   * The guard against two moderators suspending the same account in the same
   * second — one UPDATE wins, the other sees `changed: false` and is told the
   * account was already suspended, rather than both writing a suspension and
   * both filing an audit record for it. Same technique the report queue uses for
   * claim/resolve.
   *
   * Self-service deactivation uses it for the same reason and a second one: the
   * `expected` list is what makes "you cannot deactivate your way out of a
   * suspension" a property of the UPDATE rather than of a check someone can
   * forget to write above it.
   */
  async transitionStatus(
    id: string,
    expected: UserStatus[],
    next: UserStatus,
    fields: {
      suspendedAt?: Date | null;
      suspendedReason?: string | null;
      deactivatedAt?: Date | null;
    } = {}
  ): Promise<boolean> {
    const result = await prisma.user.updateMany({
      where: { id, status: { in: expected } },
      data: { status: next, ...fields },
    });
    return result.count === 1;
  }

  async update(id: string, data: Prisma.UserUpdateInput) {
    return prisma.user.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.user.update({
      where: { id },
      // `deactivatedAt` is cleared alongside: it describes a DEACTIVATED account
      // and nothing else, and a deleted row carrying one would read as an
      // account that could still be brought back by logging in.
      data: { status: 'DELETED', deactivatedAt: null },
    });
  }

  async getFullProfile(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: {
        profile: true,
        developerProfile: true,
        settings: true,
        skills: { include: { skill: true } },
      },
    });
  }

  async getPublicProfile(username: string) {
    return prisma.user.findUnique({
      where: { username, status: 'ACTIVE' },
      include: {
        profile: true,
        developerProfile: true,
        settings: true,
        skills: { include: { skill: true } },
        _count: {
          select: {
            followers: true,
            following: true,
            blogs: { where: { status: 'PUBLISHED' } },
          },
        },
      },
    });
  }

  async getStats(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
            blogs: true,
          }
        }
      }
    });
  }

  async updateProfile(id: string, data: Prisma.UserProfileUpdateInput | Prisma.UserProfileCreateInput) {
    return prisma.userProfile.upsert({
      where: { userId: id },
      update: data,
      create: { ...data, userId: id } as any,
    });
  }

  async updateDeveloperProfile(id: string, data: Prisma.DeveloperProfileUpdateInput | Prisma.DeveloperProfileCreateInput) {
    return prisma.developerProfile.upsert({
      where: { userId: id },
      update: data,
      create: { ...data, userId: id } as any,
    });
  }

  async updateSettings(id: string, data: Prisma.UserSettingsUpdateInput | Prisma.UserSettingsCreateInput) {
    return prisma.userSettings.upsert({
      where: { userId: id },
      update: data,
      create: { ...data, userId: id } as any,
    });
  }

  /**
   * Settings row for a user, or null when they have never saved any (the row is
   * created lazily by `updateSettings`). Callers must treat null as "defaults",
   * not as "everything disabled".
   */
  async findSettingsByUserId(userId: string) {
    return prisma.userSettings.findUnique({ where: { userId } });
  }

  /**
   * Settings rows for many users in ONE query. Fan-out resolves preferences for
   * a whole batch of recipients; doing that per user is a textbook N+1 that
   * serializes thousands of queries over the shared connection pool and stalls
   * every concurrent HTTP request behind it.
   */
  async findSettingsByUserIds(userIds: string[]) {
    if (userIds.length === 0) return [];
    return prisma.userSettings.findMany({ where: { userId: { in: userIds } } });
  }

  async syncSkills(userId: string, skillNames: string[]) {
    return prisma.$transaction(async (tx) => {
      const skillIds = await Promise.all(skillNames.map(async (name) => {
        const normalizedName = name.trim().toLowerCase();
        const skill = await tx.skill.upsert({
          where: { name: normalizedName },
          update: {},
          create: { name: normalizedName }
        });
        return skill.id;
      }));

      await tx.userSkill.deleteMany({ where: { userId } });

      if (skillIds.length > 0) {
        await tx.userSkill.createMany({
          data: skillIds.map(skillId => ({ userId, skillId }))
        });
      }
    });
  }

  /**
   * Decoupled search abstraction.
   * Can be safely swapped with PostgreSQL Full Text Search, pg_trgm, or Elasticsearch later
   * without affecting the service layer.
   */
  async searchUsers(query: string, limit = 10, offset = 0) {
    return prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
        ],
        status: 'ACTIVE'
      },
      select: {
        id: true,
        username: true,
        name: true,
        avatar: true,
        bio: true,
        isVerified: true,
      },
      take: limit,
      skip: offset,
    });
  }
}

export const userRepository = new UserRepository();
