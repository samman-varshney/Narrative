import { mediaService } from '../media.service';
import { mediaRepository } from '../media.repository';
import { activeStorageProvider } from '../../../core/providers/storage';
import { mediaQueue } from '../../../core/providers/queue';
import { eventBus, EVENTS } from '../../../core/events/eventBus';

// Shared sharp instance mock (must be prefixed `mock` to be usable in the hoisted factory).
const mockSharpInstance = {
  metadata: jest.fn(),
  rotate: jest.fn().mockReturnThis(),
  resize: jest.fn().mockReturnThis(),
  toFormat: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('processed-bytes')),
};

jest.mock('sharp', () => ({
  __esModule: true,
  default: jest.fn(() => mockSharpInstance),
}));

jest.mock('../media.repository');
jest.mock('../../../core/providers/storage', () => ({
  activeStorageProvider: {
    uploadFile: jest.fn(),
    deleteFile: jest.fn(),
    upload: jest.fn(),
    delete: jest.fn(),
    name: 'local',
  },
}));
jest.mock('../../../core/providers/queue', () => ({
  mediaQueue: { add: jest.fn().mockResolvedValue(undefined) },
  QUEUES: { MEDIA_PROCESSING: 'media_processing' },
}));
jest.mock('../../../core/events/eventBus');

const validFile = { buffer: Buffer.from('image-bytes'), originalname: 'pic.png', mimetype: 'image/png' };
const storedResult = {
  publicId: 'media/1-pic.png',
  url: '/uploads/media/1-pic.png',
  secureUrl: '/uploads/media/1-pic.png',
  width: 800,
  height: 600,
  bytes: 4321,
  format: 'png',
  resourceType: 'image',
  provider: 'local',
};

describe('MediaService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: a valid PNG.
    mockSharpInstance.metadata.mockResolvedValue({ format: 'png', width: 800, height: 600 });
    mockSharpInstance.toBuffer.mockResolvedValue(Buffer.from('processed-bytes'));
    (activeStorageProvider.uploadFile as jest.Mock).mockResolvedValue(storedResult);
    (activeStorageProvider.deleteFile as jest.Mock).mockResolvedValue(undefined);
  });

  describe('uploadImage', () => {
    it('validates, uploads, persists, emits MEDIA_UPLOADED and enqueues processing', async () => {
      (mediaRepository.create as jest.Mock).mockResolvedValue({
        id: 'm1',
        secureUrl: storedResult.secureUrl,
      });

      const result = await mediaService.uploadImage('user-1', validFile, { context: 'generic' });

      expect(activeStorageProvider.uploadFile).toHaveBeenCalledTimes(1);
      expect(mediaRepository.create).toHaveBeenCalledTimes(1);
      // The persisted record derives its MIME/size from inspection + storage, not client input.
      const createArg = (mediaRepository.create as jest.Mock).mock.calls[0][0];
      expect(createArg.mimeType).toBe('image/png');
      expect(createArg.provider).toBe('local');
      expect(createArg.uploadedBy).toEqual({ connect: { id: 'user-1' } });
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.MEDIA_UPLOADED, {
        mediaId: 'm1',
        userId: 'user-1',
        secureUrl: storedResult.secureUrl,
      });
      expect(mediaQueue.add).toHaveBeenCalledWith('optimize', { mediaId: 'm1' });
      expect(result).toEqual({ id: 'm1', secureUrl: storedResult.secureUrl });
    });

    it('rejects an unsupported image format before touching storage', async () => {
      mockSharpInstance.metadata.mockResolvedValue({ format: 'tiff', width: 800, height: 600 });

      await expect(mediaService.uploadImage('user-1', validFile)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'UNSUPPORTED_MEDIA_TYPE',
      });
      expect(activeStorageProvider.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects an image smaller than the minimum dimension', async () => {
      mockSharpInstance.metadata.mockResolvedValue({ format: 'png', width: 10, height: 10 });

      await expect(mediaService.uploadImage('user-1', validFile)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'IMAGE_TOO_SMALL',
      });
      expect(activeStorageProvider.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a file exceeding the maximum size before inspection', async () => {
      const bigFile = { ...validFile, buffer: Buffer.alloc(6 * 1024 * 1024) };

      await expect(mediaService.uploadImage('user-1', bigFile)).rejects.toMatchObject({
        statusCode: 400,
        errorCode: 'FILE_TOO_LARGE',
      });
      expect(activeStorageProvider.uploadFile).not.toHaveBeenCalled();
    });

    it('cleans up the uploaded asset when the DB write fails', async () => {
      (mediaRepository.create as jest.Mock).mockRejectedValue(new Error('db down'));

      await expect(mediaService.uploadImage('user-1', validFile)).rejects.toThrow('db down');

      expect(activeStorageProvider.deleteFile).toHaveBeenCalledWith(storedResult.publicId, 'image');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('getMedia', () => {
    it('returns the media for its owner', async () => {
      (mediaRepository.findById as jest.Mock).mockResolvedValue({ id: 'm1', uploadedById: 'user-1' });
      await expect(mediaService.getMedia('m1', 'user-1')).resolves.toMatchObject({ id: 'm1' });
    });

    it('throws 404 when the media does not exist', async () => {
      (mediaRepository.findById as jest.Mock).mockResolvedValue(null);
      await expect(mediaService.getMedia('m1', 'user-1')).rejects.toMatchObject({
        statusCode: 404,
        errorCode: 'MEDIA_NOT_FOUND',
      });
    });

    it('throws 403 for a non-owner', async () => {
      (mediaRepository.findById as jest.Mock).mockResolvedValue({ id: 'm1', uploadedById: 'owner' });
      await expect(mediaService.getMedia('m1', 'intruder')).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'FORBIDDEN',
      });
    });
  });

  describe('deleteMedia', () => {
    it('soft-deletes, removes the asset from storage and emits MEDIA_DELETED', async () => {
      (mediaRepository.findById as jest.Mock).mockResolvedValue({
        id: 'm1',
        uploadedById: 'user-1',
        publicId: 'media/1-pic.png',
      });

      await mediaService.deleteMedia('m1', 'user-1');

      expect(mediaRepository.softDelete).toHaveBeenCalledWith('m1');
      expect(activeStorageProvider.deleteFile).toHaveBeenCalledWith('media/1-pic.png', 'image');
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.MEDIA_DELETED, { mediaId: 'm1', userId: 'user-1' });
    });

    it('refuses deletion by a non-owner and does not touch storage', async () => {
      (mediaRepository.findById as jest.Mock).mockResolvedValue({
        id: 'm1',
        uploadedById: 'owner',
        publicId: 'media/1-pic.png',
      });

      await expect(mediaService.deleteMedia('m1', 'intruder')).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'FORBIDDEN',
      });
      expect(mediaRepository.softDelete).not.toHaveBeenCalled();
      expect(activeStorageProvider.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe('replaceMedia', () => {
    it('refuses replacement by a non-owner', async () => {
      (mediaRepository.findById as jest.Mock).mockResolvedValue({
        id: 'm1',
        uploadedById: 'owner',
        publicId: 'media/old.png',
        metadata: { context: 'generic' },
      });

      await expect(mediaService.replaceMedia('m1', 'intruder', validFile)).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'FORBIDDEN',
      });
      expect(activeStorageProvider.uploadFile).not.toHaveBeenCalled();
    });

    it('uploads the new asset, updates the record and removes the old asset', async () => {
      (mediaRepository.findById as jest.Mock).mockResolvedValue({
        id: 'm1',
        uploadedById: 'user-1',
        publicId: 'media/old.png',
        metadata: { context: 'generic' },
      });
      (mediaRepository.update as jest.Mock).mockResolvedValue({
        id: 'm1',
        secureUrl: storedResult.secureUrl,
      });

      await mediaService.replaceMedia('m1', 'user-1', validFile);

      expect(mediaRepository.update).toHaveBeenCalledTimes(1);
      expect(activeStorageProvider.deleteFile).toHaveBeenCalledWith('media/old.png', 'image');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EVENTS.MEDIA_REPLACED,
        expect.objectContaining({ mediaId: 'm1', userId: 'user-1', oldPublicId: 'media/old.png' })
      );
    });
  });
});
