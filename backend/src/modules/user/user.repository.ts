import { Prisma } from '@prisma/client';
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

  async update(id: string, data: Prisma.UserUpdateInput) {
    return prisma.user.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return prisma.user.update({
      where: { id },
      data: { status: 'DELETED' },
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
