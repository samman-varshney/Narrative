import { z } from 'zod';
import sharp from 'sharp';
import { AppError } from '../../core/exceptions/AppError';

/**
 * Image formats we accept, keyed by sharp's `metadata().format` value.
 * The true format is determined from the file's magic bytes (via sharp), never
 * from the client-provided mimetype or extension.
 */
export const ALLOWED_IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'avif'] as const;
export type AllowedImageFormat = (typeof ALLOWED_IMAGE_FORMATS)[number];

export const FORMAT_TO_MIME: Record<AllowedImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

export const FORMAT_TO_EXTENSION: Record<AllowedImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
};

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
export const MIN_DIMENSION = 32; // px
export const MAX_DIMENSION = 6000; // px

export const MEDIA_CONTEXTS = ['generic', 'avatar', 'cover'] as const;
export type MediaContext = (typeof MEDIA_CONTEXTS)[number];

/**
 * Body schema for optional text fields sent alongside the multipart file.
 * The binary itself is handled by multer + validateImageFile (not Zod).
 */
export const uploadMediaSchema = z.object({
  context: z.enum(MEDIA_CONTEXTS).optional(),
  altText: z.string().max(300).optional(),
});
export type UploadMediaInput = z.infer<typeof uploadMediaSchema>;

export interface ValidatedImage {
  width: number;
  height: number;
  format: AllowedImageFormat;
  mimeType: string;
  extension: string;
}

/**
 * Authoritative file validation. Never trusts client metadata — inspects the
 * actual bytes with sharp to determine the true format and dimensions, and
 * rejects anything outside the allowed size/type/dimension envelope.
 */
export async function validateImageFile(buffer: Buffer): Promise<ValidatedImage> {
  if (!buffer || buffer.length === 0) {
    throw new AppError('Empty file', 400, 'INVALID_IMAGE');
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new AppError('File exceeds the maximum size of 5MB', 400, 'FILE_TOO_LARGE');
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new AppError('File is not a valid image', 400, 'INVALID_IMAGE');
  }

  const format = metadata.format as AllowedImageFormat | undefined;
  if (!format || !ALLOWED_IMAGE_FORMATS.includes(format)) {
    throw new AppError(
      `Unsupported image type. Allowed: ${ALLOWED_IMAGE_FORMATS.join(', ')}`,
      400,
      'UNSUPPORTED_MEDIA_TYPE'
    );
  }

  const { width, height } = metadata;
  if (!width || !height) {
    throw new AppError('Could not read image dimensions', 400, 'INVALID_IMAGE');
  }
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
    throw new AppError(`Image is too small (minimum ${MIN_DIMENSION}px)`, 400, 'IMAGE_TOO_SMALL');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new AppError(`Image is too large (maximum ${MAX_DIMENSION}px)`, 400, 'IMAGE_TOO_LARGE');
  }

  return {
    width,
    height,
    format,
    mimeType: FORMAT_TO_MIME[format],
    extension: FORMAT_TO_EXTENSION[format],
  };
}
