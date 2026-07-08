export type StorageProviderName = 'local' | 'cloudinary';

export type StorageResourceType = 'image' | 'video' | 'raw';

export interface StorageUploadOptions {
  /** Logical folder / namespace, e.g. 'avatars', 'covers', 'media'. */
  folder?: string;
  /** Original filename, used as a naming hint (local) or public_id hint (cloudinary). */
  filename?: string;
  /** The verified MIME type (post-inspection) — never the raw client value. */
  mimetype: string;
  /** Only images are supported today; video/raw are reserved for future providers. */
  resourceType?: StorageResourceType;
}

export interface StorageResult {
  /** Provider public identifier — cloudinary public_id or local filename. Used for deletion. */
  publicId: string;
  url: string;
  secureUrl: string;
  width?: number;
  height?: number;
  bytes: number;
  /** Normalized format, e.g. 'jpeg' | 'png' | 'webp'. */
  format: string;
  resourceType: StorageResourceType;
  provider: StorageProviderName;
}

export interface IStorageProvider {
  /**
   * Identifies which concrete provider is active. Persisted on the Media record.
   */
  readonly name: StorageProviderName;

  /**
   * @deprecated Legacy simple upload. Prefer {@link uploadFile}.
   * Uploads a file buffer and returns the public URL.
   */
  upload(buffer: Buffer, filename: string, mimetype: string): Promise<string>;

  /**
   * @deprecated Legacy simple delete. Prefer {@link deleteFile}.
   * Deletes a file by its public URL or identifier.
   */
  delete(identifier: string): Promise<void>;

  /**
   * Rich upload returning full asset metadata (publicId, secure URL, dimensions, size, format).
   */
  uploadFile(buffer: Buffer, opts: StorageUploadOptions): Promise<StorageResult>;

  /**
   * Deletes a file by its provider public identifier.
   */
  deleteFile(publicId: string, resourceType?: StorageResourceType): Promise<void>;
}
