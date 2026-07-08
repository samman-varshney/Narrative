import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';

export class MediaRepository {
  async create(data: Prisma.MediaCreateInput) {
    return prisma.media.create({ data });
  }

  /** Returns the record only if it has not been soft-deleted. */
  async findById(id: string) {
    return prisma.media.findFirst({ where: { id, deletedAt: null } });
  }

  /** Returns the record regardless of soft-delete state (for restore/audit). */
  async findByIdWithDeleted(id: string) {
    return prisma.media.findUnique({ where: { id } });
  }

  async update(id: string, data: Prisma.MediaUpdateInput) {
    return prisma.media.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return prisma.media.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async listByUser(userId: string, limit = 20, offset = 0) {
    return prisma.media.findMany({
      where: { uploadedById: userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}

export const mediaRepository = new MediaRepository();
