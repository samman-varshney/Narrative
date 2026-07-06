import { userService } from '../user.service';
import { userRepository } from '../user.repository';
import { storageProvider } from '../../../core/providers/storage/LocalStorageProvider';
import { eventBus, EVENTS } from '../../../core/events/eventBus';

// Mock dependencies
jest.mock('../user.repository');
jest.mock('../../../core/providers/storage/LocalStorageProvider');
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
    it('should upload avatar and emit event', async () => {
      (userRepository.findById as jest.Mock).mockResolvedValue({ id: '123', avatar: 'old.png' });
      (storageProvider.delete as jest.Mock).mockResolvedValue(undefined);
      (storageProvider.upload as jest.Mock).mockResolvedValue('new.png');

      const buffer = Buffer.from('mock');
      await userService.uploadAvatar('123', buffer, 'image/png', 'test.png');

      expect(storageProvider.delete).toHaveBeenCalledWith('old.png');
      expect(storageProvider.upload).toHaveBeenCalledWith(buffer, 'test.png', 'image/png');
      expect(userRepository.update).toHaveBeenCalledWith('123', { avatar: 'new.png' });
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_AVATAR_UPDATED, { userId: '123', avatarUrl: 'new.png' });
    });
  });
});
