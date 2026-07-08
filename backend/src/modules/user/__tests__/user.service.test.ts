import { userService } from '../user.service';
import { userRepository } from '../user.repository';
import { activeStorageProvider } from '../../../core/providers/storage';
import { mediaService } from '../../media/media.service';
import { eventBus, EVENTS } from '../../../core/events/eventBus';

// Mock dependencies
jest.mock('../user.repository');
jest.mock('../../../core/providers/storage', () => ({
  activeStorageProvider: {
    delete: jest.fn(),
    upload: jest.fn(),
    uploadFile: jest.fn(),
    deleteFile: jest.fn(),
    name: 'local',
  },
}));
jest.mock('../../media/media.service', () => ({
  mediaService: {
    uploadAvatar: jest.fn(),
    uploadCoverImage: jest.fn(),
    uploadImage: jest.fn(),
    replaceMedia: jest.fn(),
    deleteMedia: jest.fn(),
    getMedia: jest.fn(),
  },
}));
jest.mock('../../../core/events/eventBus');

describe('UserService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getPublicProfile', () => {
    it('should return public profile without sensitive data', async () => {
      (userRepository.getPublicProfile as jest.Mock).mockResolvedValue({
        id: '123',
        username: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        passwordHash: 'hashed',
        settings: { isPrivate: false, hideActivity: false },
        _count: { following: 5, followers: 10 }
      });

      const result = await userService.getPublicProfile('testuser');
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('email');
      expect((result as any)._count.following).toBe(5);
    });

    it('should mask activity if hideActivity is true', async () => {
      (userRepository.getPublicProfile as jest.Mock).mockResolvedValue({
        id: '123',
        username: 'testuser',
        name: 'Test User',
        settings: { isPrivate: false, hideActivity: true },
        _count: { following: 5, followers: 10 }
      });

      const result = await userService.getPublicProfile('testuser');
      expect((result as any)._count.following).toBe(0); // Masked
    });

    it('should return minimal data if profile isPrivate', async () => {
      (userRepository.getPublicProfile as jest.Mock).mockResolvedValue({
        id: '123',
        username: 'testuser',
        name: 'Test User',
        bio: 'Secret bio',
        settings: { isPrivate: true },
      });

      const result = await userService.getPublicProfile('testuser');
      expect(result).not.toHaveProperty('bio');
      expect(result).toHaveProperty('isPrivate', true);
    });
  });

  describe('uploadAvatar', () => {
    it('delegates the upload to MediaService and links the new Media record', async () => {
      (userRepository.findById as jest.Mock).mockResolvedValue({ id: '123', avatar: 'old.png', avatarMediaId: null });
      (activeStorageProvider.delete as jest.Mock).mockResolvedValue(undefined);
      (mediaService.uploadAvatar as jest.Mock).mockResolvedValue({ id: 'newmid', secureUrl: 'new.png' });

      const buffer = Buffer.from('mock');
      await userService.uploadAvatar('123', buffer, 'image/png', 'test.png');

      // Media module is the single owner of the actual upload.
      expect(mediaService.uploadAvatar).toHaveBeenCalledWith('123', {
        buffer,
        originalname: 'test.png',
        mimetype: 'image/png',
      });
      // The new avatar is linked via a proper FK, not just the URL string.
      expect(userRepository.update).toHaveBeenCalledWith('123', {
        avatar: 'new.png',
        avatarMedia: { connect: { id: 'newmid' } },
      });
      // No prior Media row → legacy URL cleanup, and NOT a media soft-delete.
      expect(activeStorageProvider.delete).toHaveBeenCalledWith('old.png');
      expect(mediaService.deleteMedia).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_AVATAR_UPDATED, { userId: '123', avatarUrl: 'new.png' });
    });

    it('retires the previous avatar Media record through the Media lifecycle on replace', async () => {
      (userRepository.findById as jest.Mock).mockResolvedValue({ id: '123', avatar: 'old.png', avatarMediaId: 'oldmid' });
      (mediaService.uploadAvatar as jest.Mock).mockResolvedValue({ id: 'newmid', secureUrl: 'new.png' });
      (mediaService.deleteMedia as jest.Mock).mockResolvedValue(undefined);

      await userService.uploadAvatar('123', Buffer.from('mock'), 'image/png', 'test.png');

      expect(userRepository.update).toHaveBeenCalledWith('123', {
        avatar: 'new.png',
        avatarMedia: { connect: { id: 'newmid' } },
      });
      // Old avatar is soft-deleted + purged from storage — no orphaned row/file.
      expect(mediaService.deleteMedia).toHaveBeenCalledWith('oldmid', '123');
      expect(activeStorageProvider.delete).not.toHaveBeenCalled();
    });
  });
});
