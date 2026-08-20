import { userRepository } from './user.repository';
import { AppError } from '../../core/exceptions/AppError';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import {
  assertPermission,
  permissionsFor,
} from '../auth/permissions';
import { activeStorageProvider } from '../../core/providers/storage';
import { mediaService } from '../media/media.service';
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

    // Media module is the single owner of file operations.
    const media = await mediaService.uploadAvatar(id, { buffer, originalname: originalName, mimetype });

    const previousMediaId = user.avatarMediaId;
    await userRepository.update(id, {
      avatar: media.secureUrl,
      avatarMedia: { connect: { id: media.id } },
    });

    // Retire the previous avatar's Media record + storage asset via the Media
    // lifecycle (soft-delete + provider cleanup) — no orphaned rows/files.
    if (previousMediaId) {
      await mediaService.deleteMedia(previousMediaId, id).catch(() => {});
    } else if (user.avatar) {
      // Legacy avatar (pre-FK) had no Media row — clean the raw URL best-effort.
      await activeStorageProvider.delete(user.avatar).catch(() => {});
    }

    eventBus.emit(EVENTS.USER_AVATAR_UPDATED, { userId: id, avatarUrl: media.secureUrl });
    return { avatarUrl: media.secureUrl };
  }

  async deleteAvatar(id: string) {
    const user = await userRepository.findById(id);
    if (!user || !user.avatar) return;

    const previousMediaId = user.avatarMediaId;
    await userRepository.update(id, { avatar: null, avatarMedia: { disconnect: true } });

    if (previousMediaId) {
      await mediaService.deleteMedia(previousMediaId, id).catch(() => {});
    } else {
      // Legacy avatar with no Media row.
      await activeStorageProvider.delete(user.avatar).catch(() => {});
    }

    eventBus.emit(EVENTS.USER_AVATAR_UPDATED, { userId: id, avatarUrl: null });
  }

  async softDelete(id: string) {
    await userRepository.delete(id);
    eventBus.emit(EVENTS.USER_DELETED, { userId: id });
  }

  // ---- Self-service account lifecycle --------------------------------------
  //
  // Deactivation is the reversible exit: the account and everything it wrote
  // leave every public surface, and one successful login brings all of it back.
  // It is written here for the same reason suspension is — `User.status` has one
  // owner — and it emits a DISTINCT event from suspension because the two are
  // not the same fact, however identical their enforcement looks.
  //
  // Nothing here touches a blog, a comment, a follow or a bookmark. Every
  // discovery surface already gates on `u."status" = 'ACTIVE'`, so hiding the
  // account hides its output as a consequence, and reactivation restores the
  // whole catalogue with one UPDATE. A deactivation that rewrote content rows
  // would be a deletion wearing a reversible name.

  /**
   * Deactivates the caller's own account.
   *
   * `expected: ['ACTIVE']` is load-bearing, not defensive: a SUSPENDED account
   * that could deactivate itself would be handing every suspended user a way to
   * launder their status back to ACTIVE through the login flow below. The route
   * guard (`requireActiveAccount`) refuses that request first; this is the layer
   * that would still hold if the guard were ever dropped from the route.
   */
  async deactivate(id: string) {
    const changed = await userRepository.transitionStatus(id, ['ACTIVE'], 'DEACTIVATED', {
      deactivatedAt: new Date(),
    });

    if (!changed) {
      throw new AppError('Account is not active', 409, 'NOT_ACTIVE');
    }

    eventBus.emit(EVENTS.USER_DEACTIVATED, { userId: id });
  }

  /**
   * Reverses a deactivation. Called by `authService.login` after the password
   * has been verified — that verification IS the confirmation, which is why
   * there is no reactivation token to mint, mail, store or expire.
   *
   * Returns whether it changed anything, rather than throwing, because the only
   * caller is a login that must succeed either way: a concurrent second login
   * losing the UPDATE has still authenticated a now-ACTIVE account, and failing
   * it would lock a user out of their own reactivation over a race they cannot
   * see.
   */
  async reactivate(id: string): Promise<boolean> {
    const changed = await userRepository.transitionStatus(id, ['DEACTIVATED'], 'ACTIVE', {
      deactivatedAt: null,
    });

    if (changed) {
      eventBus.emit(EVENTS.USER_REACTIVATED, { userId: id });
    }

    return changed;
  }

  // ---- Moderation seam -----------------------------------------------------
  //
  // Account status belongs to this module, so suspension is written HERE and the
  // Moderation module calls these. The alternative — moderation updating
  // `User.status` itself — would put two modules in charge of one column and
  // make "what does SUSPENDED mean" a question with two answers.
  //
  // These methods do NOT write the audit log. They emit the fact; the caller
  // that decided to act is the one that records having acted, because it is the
  // only one that knows the report and the rationale behind it.

  /**
   * Suspends an account.
   *
   * Throws rather than returning a flag on every refusal, because each refusal
   * is a genuinely different situation the caller must not paper over:
   * 404 for an unknown account, 409 for one already suspended (the concurrent
   * second moderator), 403 for self-suspension or for acting above one's level.
   */
  async suspend(
    targetUserId: string,
    actor: { userId: string; role: string },
    reason?: string
  ) {
    assertPermission(actor.role, 'users:suspend');

    const target = await this.loadModerationTarget(targetUserId, actor);

    if (target.status === 'DELETED') {
      throw new AppError('Cannot suspend a deleted account', 409, 'USER_DELETED');
    }

    // DEACTIVATED is suspendable. Without it, deactivating would be a shield:
    // a user under investigation could hide, wait out the queue, and log back in
    // to an ACTIVE account. Moderation has to be able to reach an account that
    // has stepped out of view.
    //
    // The cost is that `unsuspend` returns the account to ACTIVE rather than to
    // the DEACTIVATED state it was in — the user's own choice is overwritten by
    // the moderation round-trip. Accepted deliberately: the alternative is a
    // "status before suspension" column whose only job is to remember one flag,
    // and a reinstated user who quietly reappears in public search results
    // because a moderator's action restored a state they never asked for. A
    // reinstated user who finds themselves visible can deactivate again in one
    // request; a suspended user who cannot be suspended is a hole.
    const changed = await userRepository.transitionStatus(
      targetUserId,
      ['ACTIVE', 'DEACTIVATED'],
      'SUSPENDED',
      { suspendedAt: new Date(), suspendedReason: reason ?? null, deactivatedAt: null }
    );

    // Conditional UPDATE, so this is the losing side of a race with another
    // moderator — not a stale read. Reporting it as a conflict is what stops two
    // audit records and two notifications for one suspension.
    if (!changed) {
      throw new AppError('Account is already suspended', 409, 'ALREADY_SUSPENDED');
    }

    eventBus.emit(EVENTS.USER_SUSPENDED, {
      userId: targetUserId,
      actorId: actor.userId,
      reason: reason ?? null,
    });

    return this.getModerationSummary(targetUserId);
  }

  /** Lifts a suspension. Mirror of `suspend`, including the concurrency guard. */
  async unsuspend(targetUserId: string, actor: { userId: string; role: string }) {
    assertPermission(actor.role, 'users:unsuspend');

    const target = await this.loadModerationTarget(targetUserId, actor);

    if (target.status === 'DELETED') {
      throw new AppError('Cannot restore a deleted account', 409, 'USER_DELETED');
    }

    const changed = await userRepository.transitionStatus(
      targetUserId,
      ['SUSPENDED'],
      'ACTIVE',
      { suspendedAt: null, suspendedReason: null }
    );

    if (!changed) {
      throw new AppError('Account is not suspended', 409, 'NOT_SUSPENDED');
    }

    eventBus.emit(EVENTS.USER_UNSUSPENDED, {
      userId: targetUserId,
      actorId: actor.userId,
    });

    return this.getModerationSummary(targetUserId);
  }

  /**
   * The account view administrative surfaces render. Deliberately narrower than
   * `getMe`: no email, no settings, no password hash — an administrator needs to
   * judge an account's behaviour, which does not require its private data.
   */
  async getModerationSummary(userId: string) {
    const user = await userRepository.findModerationSummaryById(userId);
    if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    return user;
  }

  /**
   * Public identity for many users at once, keyed by id.
   *
   * The module boundary for "label these ids" — a moderation queue page renders
   * a reporter and an owner per row, and without a batch this is two queries per
   * row. Ids that do not resolve are simply absent.
   */
  async getPublicUserCards(ids: string[]) {
    const rows = await userRepository.findPublicByIds([...new Set(ids)]);
    return new Map(rows.map((u) => [u.id, u]));
  }

  /**
   * Loads the target of an administrative action and enforces the two rules that
   * are about the ACTOR rather than the account:
   *
   *   self       nobody suspends themselves. It is either an accident or an
   *              attempt to make a suspension look like it came from elsewhere.
   *   seniority  a moderator may not act on another privileged account. Without
   *              this, two moderators can suspend each other, and a compromised
   *              moderator account can disable the people who would notice.
   *              Administrators (`users:manage`) are exempt — someone has to be
   *              able to act on a rogue moderator.
   */
  private async loadModerationTarget(
    targetUserId: string,
    actor: { userId: string; role: string }
  ) {
    if (targetUserId === actor.userId) {
      throw new AppError(
        'You cannot perform this action on your own account',
        403,
        'CANNOT_MODERATE_SELF'
      );
    }

    const target = await userRepository.findModerationSummaryById(targetUserId);
    if (!target) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

    const targetIsPrivileged = permissionsFor(target.role).length > 0;
    if (targetIsPrivileged) {
      assertPermission(actor.role, 'users:manage');
    }

    return target;
  }

  async search(query: string, page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    return userRepository.searchUsers(query, limit, offset);
  }

  /**
   * The account itself, for the data export: identity, profile, settings,
   * developer links and skills.
   *
   * `passwordHash` is stripped here rather than left to the caller. An export is
   * the one place where "the caller will remember to remove it" is not an
   * acceptable design — the artifact is written to storage and handed to a
   * human, so the credential must never be in the object at all.
   */
  async collectForExport(id: string) {
    const user = await userRepository.getFullProfile(id);
    if (!user) throw new AppError('User not found', 404);

    const { passwordHash: _, ...account } = user;
    return {
      ...account,
      skills: user.skills.map((entry) => entry.skill.name),
    };
  }
}

export const userService = new UserService();
