import {
  IStorageProvider,
  StorageProviderName,
  StorageResourceType,
  StorageResult,
  StorageUploadOptions,
} from './IStorageProvider';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

// Scaffolded local storage provider for development
// In production, this would be replaced with CloudinaryProvider or S3Provider
export class LocalStorageProvider implements IStorageProvider {
  public readonly name: StorageProviderName = 'local';
  private readonly uploadDir = path.join(process.cwd(), 'uploads');

  constructor() {
    // Ensure upload directory exists
    fs.mkdir(this.uploadDir, { recursive: true }).catch(console.error);
  }

  async upload(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
    const uniqueFilename = `${Date.now()}-${filename}`;
    const filePath = path.join(this.uploadDir, uniqueFilename);
    await fs.writeFile(filePath, buffer);

    // Return a mock URL that would ideally map to a static Express route
    return `/uploads/${uniqueFilename}`;
  }

  async delete(identifier: string): Promise<void> {
    const filename = identifier.replace('/uploads/', '');
    const filePath = path.join(this.uploadDir, filename);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }

  async uploadFile(buffer: Buffer, opts: StorageUploadOptions): Promise<StorageResult> {
    const folder = opts.folder ?? 'media';
    const safeName = (opts.filename ?? 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueFilename = `${folder}/${Date.now()}-${safeName}`;
    const filePath = path.join(this.uploadDir, uniqueFilename);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);

    // Derive real dimensions/format so the record is provider-agnostic and accurate.
    let width: number | undefined;
    let height: number | undefined;
    let format = 'bin';
    try {
      const meta = await sharp(buffer).metadata();
      width = meta.width;
      height = meta.height;
      if (meta.format) format = meta.format;
    } catch {
      // Non-image buffers (future resource types) — leave dimensions undefined.
    }

    const url = `/uploads/${uniqueFilename}`;
    return {
      publicId: uniqueFilename,
      url,
      secureUrl: url,
      width,
      height,
      bytes: buffer.length,
      format,
      resourceType: opts.resourceType ?? 'image',
      provider: this.name,
    };
  }

  async deleteFile(publicId: string, _resourceType?: StorageResourceType): Promise<void> {
    const filePath = path.join(this.uploadDir, publicId);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }
}

export const storageProvider = new LocalStorageProvider();
