import { Readable } from 'stream';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import {
  IStorageProvider,
  StorageProviderName,
  StorageResourceType,
  StorageResult,
  StorageUploadOptions,
} from './IStorageProvider';
import { env } from '../../config/env';
import { AppError } from '../../exceptions/AppError';

/**
 * Cloudinary-backed storage provider.
 *
 * Uploads stream from an in-memory buffer (no temp files), are delivered with
 * automatic format/quality optimization (`fetch_format`/`quality` = auto), and
 * are signed by default because an api_secret is configured.
 */
export class CloudinaryStorageProvider implements IStorageProvider {
  public readonly name: StorageProviderName = 'cloudinary';

  constructor() {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  private toResourceType(type?: StorageResourceType): 'image' | 'video' | 'raw' {
    return type ?? 'image';
  }

  async uploadFile(buffer: Buffer, opts: StorageUploadOptions): Promise<StorageResult> {
    const resourceType = this.toResourceType(opts.resourceType);

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: opts.folder ?? 'media',
          resource_type: resourceType,
          fetch_format: 'auto',
          quality: 'auto',
          // Cloudinary generates a unique public_id; original name kept as context only.
        },
        (error, uploaded) => {
          if (error || !uploaded) {
            return reject(new AppError('Cloudinary upload failed', 502, 'STORAGE_UPLOAD_FAILED'));
          }
          resolve(uploaded);
        }
      );
      Readable.from(buffer).pipe(stream);
    });

    return {
      publicId: result.public_id,
      url: result.url,
      secureUrl: result.secure_url,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      format: result.format,
      resourceType,
      provider: this.name,
    };
  }

  async deleteFile(publicId: string, resourceType?: StorageResourceType): Promise<void> {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: this.toResourceType(resourceType),
      invalidate: true,
    });
  }

  // --- Legacy IStorageProvider surface (kept for backward compatibility) ---

  async upload(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
    const result = await this.uploadFile(buffer, { filename, mimetype });
    return result.secureUrl;
  }

  async delete(identifier: string): Promise<void> {
    // Legacy callers may pass a full secure URL; best-effort extract the public_id.
    const publicId = this.extractPublicId(identifier);
    if (publicId) {
      await this.deleteFile(publicId).catch(() => {});
    }
  }

  /**
   * Best-effort extraction of a Cloudinary public_id (incl. folder) from a delivery URL.
   * e.g. https://res.cloudinary.com/<cloud>/image/upload/v123/media/abc.jpg -> media/abc
   */
  private extractPublicId(url: string): string | null {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
    return match ? match[1] : null;
  }
}

export const cloudinaryStorageProvider = new CloudinaryStorageProvider();
