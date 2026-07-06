import { userRepository } from './user.repository';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { storageProvider } from '../../core/providers/storage/LocalStorageProvider'; // Ideally injected or resolved via DI
import {
  UpdateProfileInput,
  UpdateDeveloperProfileInput,
  UpdateSettingsInput,
  UpdatePrivacyInput,
  UpdateSkillsInput,
} from './user.validator';

export class UserService {
  async getMe(id: string) {
    const user = await userRepository.getFullProfile(id);
    if (!user || user.status === 'DELETED') {
      throw new AppError('User not found', 404);
    }
    const { passwordHash: _, ...safeUser } = user;
    return safeUser;
  }

  async getPublicProfile(username: string) {
    const user = await userRepository.getPublicProfile(username);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    const { passwordHash: _, email: __, settings, ...publicData } = user;

    // Apply Privacy Rules
    if (settings?.isPrivate) {
      // Return minimal info if profile is private
      return {
        id: publicData.id,
        username: publicData.username,
        name: publicData.name,
        avatar: publicData.avatar,
        isPrivate: true,
      };
    }

    if (settings?.hideActivity) {
      // Scrub activity data like following count or recent blogs (if we fetched them)
      (publicData as any)._count.following = 0;
    }

    return publicData;
  }

  async getStats(id: string) {
    const stats = await userRepository.getStats(id);
    if (!stats || stats.status === 'DELETED') throw new AppError('User not found', 404);
    return stats._count;
  }

  async updateProfile(id: string, input: UpdateProfileInput) {
    // Separate core user fields from profile fields
    const { name, username, bio, ...profileFields } = input;

    if (username) {
      const existing = await userRepository.findByUsername(username);
      if (existing && existing.id !== id) {
        throw new AppError('Username is already taken', 409);
      }
    }

    // Update core fields if provided
    if (name !== undefined || username !== undefined || bio !== undefined) {
      await userRepository.update(id, { name, username, bio });
    }

    // Update profile fields if provided
    if (Object.keys(profileFields).length > 0) {
      await userRepository.updateProfile(id, profileFields);
    }

    eventBus.emit(EVENTS.USER_PROFILE_UPDATED, { userId: id });
    return this.getMe(id);
  }

  async updateDeveloperProfile(id: string, input: UpdateDeveloperProfileInput) {
    await userRepository.updateDeveloperProfile(id, input);
    eventBus.emit(EVENTS.USER_PROFILE_UPDATED, { userId: id });
    return this.getMe(id);
  }

  async updateSettings(id: string, input: UpdateSettingsInput & UpdatePrivacyInput) {
    await userRepository.updateSettings(id, input);
    eventBus.emit(EVENTS.USER_SETTINGS_UPDATED, { userId: id });
    return this.getMe(id);
  }

  async updateSkills(id: string, input: UpdateSkillsInput) {
    await userRepository.syncSkills(id, input.skills);
    eventBus.emit(EVENTS.USER_PROFILE_UPDATED, { userId: id });
    return this.getMe(id);
  }

  async uploadAvatar(id: string, buffer: Buffer, mimetype: string, originalName: string) {
    const user = await userRepository.findById(id);
    if (!user) throw new AppError('User not found', 404);

    // Delete old avatar if exists
    if (user.avatar) {
      await storageProvider.delete(user.avatar).catch(() => {}); // ignore error if old avatar missing
    }

    const avatarUrl = await storageProvider.upload(buffer, originalName, mimetype);
    await userRepository.update(id, { avatar: avatarUrl });

    eventBus.emit(EVENTS.USER_AVATAR_UPDATED, { userId: id, avatarUrl });
    return { avatarUrl };
  }

  async deleteAvatar(id: string) {
    const user = await userRepository.findById(id);
    if (!user || !user.avatar) return;

    await storageProvider.delete(user.avatar).catch(() => {});
    await userRepository.update(id, { avatar: null });

    eventBus.emit(EVENTS.USER_AVATAR_UPDATED, { userId: id, avatarUrl: null });
  }

  async softDelete(id: string) {
    await userRepository.delete(id);
    eventBus.emit(EVENTS.USER_DELETED, { userId: id });
  }

  async search(query: string, page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    return userRepository.searchUsers(query, limit, offset);
  }
}

export const userService = new UserService();
