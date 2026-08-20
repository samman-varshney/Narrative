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

  /**
   * One page of this user's uploads, for the data export.
   *
   * METADATA ONLY — never the file bytes. The images already live at the URLs
   * recorded here, which the user can fetch directly; inlining them would turn a
   * text export into a multi-hundred-megabyte one for no capability gained.
   * Soft-deleted rows are included, since the user did upload them.
   */
  async findAllByUploaderForExport(uploadedById: string, take: number, cursorId?: string) {
    return prisma.media.findMany({
      where: { uploadedById },
      orderBy: { id: 'asc' },
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        publicId: true,
        url: true,
        secureUrl: true,
        originalFilename: true,
        mimeType: true,
        extension: true,
        fileSize: true,
        width: true,
        height: true,
        resourceType: true,
        provider: true,
        checksum: true,
        metadata: true,
        deletedAt: true,
        createdAt: true,
      },
    });
  }
}

export const mediaRepository = new MediaRepository();
