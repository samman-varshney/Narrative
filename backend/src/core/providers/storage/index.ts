import { env } from '../../config/env';
import { IStorageProvider } from './IStorageProvider';
import { storageProvider } from './LocalStorageProvider';
import { cloudinaryStorageProvider } from './CloudinaryStorageProvider';

/**
 * The active storage provider, selected at boot from STORAGE_PROVIDER.
 * All modules should depend on this rather than a concrete provider so the
 * backing store can be swapped (local ↔ cloudinary ↔ future S3/GCS) without
 * touching business logic.
 */
export const activeStorageProvider: IStorageProvider =
  env.STORAGE_PROVIDER === 'cloudinary' ? cloudinaryStorageProvider : storageProvider;

export * from './IStorageProvider';
