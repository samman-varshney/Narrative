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

  describe('deactivate', () => {
    it('transitions ACTIVE → DEACTIVATED, stamps the time, and emits the fact', async () => {
      (userRepository.transitionStatus as jest.Mock).mockResolvedValue(true);

      await userService.deactivate('123');

      expect(userRepository.transitionStatus).toHaveBeenCalledWith(
        '123',
        ['ACTIVE'],
        'DEACTIVATED',
        { deactivatedAt: expect.any(Date) }
      );
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_DEACTIVATED, { userId: '123' });
    });

    /**
     * The security property, asserted at the layer that enforces it rather than
     * at the route guard above it: only an ACTIVE account may deactivate. A
     * SUSPENDED one that could would reactivate itself on the next login.
     */
    it('only ever accepts ACTIVE as the source state', async () => {
      (userRepository.transitionStatus as jest.Mock).mockResolvedValue(true);

      await userService.deactivate('123');

      const [, expected] = (userRepository.transitionStatus as jest.Mock).mock.calls[0];
      expect(expected).toEqual(['ACTIVE']);
      expect(expected).not.toContain('SUSPENDED');
    });

    it('rejects with 409 when the account was not ACTIVE, and emits nothing', async () => {
      (userRepository.transitionStatus as jest.Mock).mockResolvedValue(false);

      await expect(userService.deactivate('123')).rejects.toThrow('Account is not active');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('reactivate', () => {
    it('transitions DEACTIVATED → ACTIVE, clears the stamp, and emits the fact', async () => {
      (userRepository.transitionStatus as jest.Mock).mockResolvedValue(true);

      await expect(userService.reactivate('123')).resolves.toBe(true);

      expect(userRepository.transitionStatus).toHaveBeenCalledWith(
        '123',
        ['DEACTIVATED'],
        'ACTIVE',
        { deactivatedAt: null }
      );
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_REACTIVATED, { userId: '123' });
    });

    /**
     * Returns false instead of throwing: the only caller is a login that has
     * already verified a password and must still succeed. It also must not emit
     * a second USER_REACTIVATED for a transition it did not perform.
     */
    it('reports no-op without throwing or emitting when the row was not DEACTIVATED', async () => {
      (userRepository.transitionStatus as jest.Mock).mockResolvedValue(false);

      await expect(userService.reactivate('123')).resolves.toBe(false);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('suspend, against a self-deactivated account', () => {
    const actor = { userId: 'mod-1', role: 'ADMIN' };

    beforeEach(() => {
      (userRepository.findModerationSummaryById as jest.Mock).mockResolvedValue({
        id: '123',
        role: 'USER',
        status: 'DEACTIVATED',
      });
      (userRepository.transitionStatus as jest.Mock).mockResolvedValue(true);
    });

    /**
     * Deactivation must not be a shield. If DEACTIVATED were absent from the
     * expected list, a user under investigation could hide, and the moderator's
     * suspend would fail the conditional UPDATE and surface as a misleading
     * "already suspended" conflict.
     */
    it('suspends it, clearing the deactivation stamp', async () => {
      await userService.suspend('123', actor, 'spam');

      expect(userRepository.transitionStatus).toHaveBeenCalledWith(
        '123',
        ['ACTIVE', 'DEACTIVATED'],
        'SUSPENDED',
        { suspendedAt: expect.any(Date), suspendedReason: 'spam', deactivatedAt: null }
      );
      expect(eventBus.emit).toHaveBeenCalledWith(EVENTS.USER_SUSPENDED, {
        userId: '123',
        actorId: 'mod-1',
        reason: 'spam',
      });
    });
  });
});
