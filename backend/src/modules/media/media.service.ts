import { createHash } from 'crypto';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { mediaRepository } from './media.repository';
import {
  AllowedImageFormat,
  MediaContext,
  UploadMediaInput,
  validateImageFile,
} from './media.validator';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { activeStorageProvider } from '../../core/providers/storage';
import { mediaQueue } from '../../core/providers/queue';
import { logger } from '../../core/utils/logger';
import { collectPaged } from '../../core/utils/collectPaged';
import { EXPORT_MAX_ROWS_PER_COLLECTION, EXPORT_PAGE_SIZE } from '../export/export.config';

/** Minimal shape of an uploaded file (satisfied by Express.Multer.File). */
export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

// Largest dimension we deliver at; larger images are downscaled (never upscaled).
const MAX_DELIVERY_DIMENSION = 2560;

export class MediaService {
  async uploadImage(userId: string, file: UploadedFile, input?: UploadMediaInput) {
    const validated = await validateImageFile(file.buffer);
    const processed = await this.processImage(file.buffer, validated.format);
    const checksum = createHash('sha256').update(processed).digest('hex');

    const context: MediaContext = input?.context ?? 'generic';
    const stored = await activeStorageProvider.uploadFile(processed, {
      folder: this.folderFor(context),
      filename: file.originalname,
      mimetype: validated.mimeType,
      resourceType: 'image',
    });

    let media;
    try {
      media = await mediaRepository.create({
        publicId: stored.publicId,
        url: stored.url,
        secureUrl: stored.secureUrl,
        originalFilename: file.originalname,
        mimeType: validated.mimeType,
        extension: validated.extension,
        fileSize: stored.bytes,
        width: stored.width ?? validated.width,
        height: stored.height ?? validated.height,
        resourceType: 'IMAGE',
        provider: activeStorageProvider.name,
        checksum,
        metadata: this.buildMetadata(context, validated.format, input?.altText),
        uploadedBy: { connect: { id: userId } },
      });
    } catch (err) {
      // Cleanup-on-failure: don't leave an orphaned asset in storage.
      await activeStorageProvider.deleteFile(stored.publicId, 'image').catch(() => {});
      throw err;
    }

    eventBus.emit(EVENTS.MEDIA_UPLOADED, {
      mediaId: media.id,
      userId,
      secureUrl: media.secureUrl,
    });
    await this.enqueueProcessing(media.id);
    return media;
  }

  uploadAvatar(userId: string, file: UploadedFile) {
    return this.uploadImage(userId, file, { context: 'avatar' });
  }

  uploadCoverImage(userId: string, file: UploadedFile) {
    return this.uploadImage(userId, file, { context: 'cover' });
  }

  async getMedia(id: string, userId: string) {
    const media = await mediaRepository.findById(id);
    if (!media) throw new AppError('Media not found', 404, 'MEDIA_NOT_FOUND');
    this.assertOwnership(media.uploadedById, userId);
    return media;
  }

  async replaceMedia(id: string, userId: string, file: UploadedFile) {
    const existing = await mediaRepository.findById(id);
    if (!existing) throw new AppError('Media not found', 404, 'MEDIA_NOT_FOUND');
    this.assertOwnership(existing.uploadedById, userId);

    const validated = await validateImageFile(file.buffer);
    const processed = await this.processImage(file.buffer, validated.format);
    const checksum = createHash('sha256').update(processed).digest('hex');

    const context = this.contextOf(existing.metadata);
    const stored = await activeStorageProvider.uploadFile(processed, {
      folder: this.folderFor(context),
      filename: file.originalname,
      mimetype: validated.mimeType,
      resourceType: 'image',
    });

    const oldPublicId = existing.publicId;
    let updated;
    try {
      updated = await mediaRepository.update(id, {
        publicId: stored.publicId,
        url: stored.url,
        secureUrl: stored.secureUrl,
        originalFilename: file.originalname,
        mimeType: validated.mimeType,
        extension: validated.extension,
        fileSize: stored.bytes,
        width: stored.width ?? validated.width,
        height: stored.height ?? validated.height,
        provider: activeStorageProvider.name,
        checksum,
        metadata: this.buildMetadata(context, validated.format, this.altTextOf(existing.metadata)),
      });
    } catch (err) {
      // Roll back the newly uploaded asset; keep the original intact.
      await activeStorageProvider.deleteFile(stored.publicId, 'image').catch(() => {});
      throw err;
    }

    // Remove the previous asset from storage (best-effort; DB is the source of truth).
    if (oldPublicId !== stored.publicId) {
      await activeStorageProvider.deleteFile(oldPublicId, 'image').catch(() => {});
    }

    eventBus.emit(EVENTS.MEDIA_REPLACED, {
      mediaId: id,
      userId,
      secureUrl: updated.secureUrl,
      oldPublicId,
    });
    await this.enqueueProcessing(id);
    return updated;
  }

  async deleteMedia(id: string, userId: string) {
    const existing = await mediaRepository.findById(id);
    if (!existing) throw new AppError('Media not found', 404, 'MEDIA_NOT_FOUND');
    this.assertOwnership(existing.uploadedById, userId);

    await mediaRepository.softDelete(id);
    await activeStorageProvider.deleteFile(existing.publicId, 'image').catch(() => {});

    eventBus.emit(EVENTS.MEDIA_DELETED, { mediaId: id, userId });
  }

  // --- internals ---

  private assertOwnership(ownerId: string, userId: string) {
    if (ownerId !== userId) {
      throw new AppError('You do not have permission to access this media', 403, 'FORBIDDEN');
    }
  }

  private folderFor(context: MediaContext): string {
    return context === 'avatar' ? 'avatars' : context === 'cover' ? 'covers' : 'media';
  }

  private buildMetadata(
    context: MediaContext,
    format: AllowedImageFormat,
    altText?: string | null
  ): Prisma.InputJsonObject {
    const meta: Record<string, string> = { context, format };
    if (altText) meta.altText = altText;
    return meta as Prisma.InputJsonObject;
  }

  private contextOf(metadata: Prisma.JsonValue | null): MediaContext {
    const ctx = (metadata as Record<string, unknown> | null)?.context;
    return ctx === 'avatar' || ctx === 'cover' ? ctx : 'generic';
  }

  private altTextOf(metadata: Prisma.JsonValue | null): string | undefined {
    const alt = (metadata as Record<string, unknown> | null)?.altText;
    return typeof alt === 'string' ? alt : undefined;
  }

  /**
   * Normalize, downscale, compress and strip metadata (EXIF) from the image.
   * Animated GIFs are passed through untouched to preserve animation.
   */
  private async processImage(buffer: Buffer, format: AllowedImageFormat): Promise<Buffer> {
    if (format === 'gif') return buffer;
    return sharp(buffer)
      .rotate() // auto-orient using EXIF, then drop the orientation tag
      .resize({
        width: MAX_DELIVERY_DIMENSION,
        height: MAX_DELIVERY_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toFormat(format, { quality: 82 })
      .toBuffer();
  }

  private async enqueueProcessing(mediaId: string) {
    try {
      await mediaQueue.add('optimize', { mediaId });
    } catch (err) {
      // Async processing is best-effort; never fail the request because the queue is down.
      logger.warn({ err, mediaId }, 'Failed to enqueue media processing job');
    }
  }

  /**
   * Metadata for every file this user uploaded, for the data export.
   *
   * Metadata only — never bytes. The files are already served from the URLs in
   * each record; inlining them would turn a text export into a
   * hundreds-of-megabytes one and buy the user nothing they cannot already fetch.
   */
  async collectForExport(uploadedById: string) {
    type Row = Awaited<ReturnType<typeof mediaRepository.findAllByUploaderForExport>>[number];
    return collectPaged<Row>(
      (previous) =>
        mediaRepository.findAllByUploaderForExport(uploadedById, EXPORT_PAGE_SIZE, previous?.id),
      EXPORT_PAGE_SIZE,
      EXPORT_MAX_ROWS_PER_COLLECTION
    );
  }
}

export const mediaService = new MediaService();
