import { userRepository } from '../user/user.repository';
import { userService } from '../user/user.service';
import { tokensService, TokenPayload } from './tokens.service';
import { passwordService } from './password.service';
import { sessionService } from './session.service';
import { accountStatusService } from './accountStatus.service';
import { AppError } from '../../core/exceptions/AppError';
import { RegisterInput, LoginInput } from './auth.validator';
import { logger } from '../../core/utils/logger';
import { eventBus, EVENTS } from '../../core/events/eventBus';

export class AuthService {
  async register(data: RegisterInput) {
    const existingEmail = await userRepository.findByEmail(data.email);
    if (existingEmail) {
      throw new AppError('Email is already registered', 409, 'EMAIL_EXISTS');
    }

    const existingUsername = await userRepository.findByUsername(data.username);
    if (existingUsername) {
      throw new AppError('Username is already taken', 409, 'USERNAME_EXISTS');
    }

    const passwordHash = await passwordService.hash(data.password);

    const user = await userRepository.create({
      email: data.email,
      username: data.username,
      name: data.name,
      passwordHash,
    });

    eventBus.emit(EVENTS.USER_REGISTERED, { userId: user.id, email: user.email });

    logger.info({ userId: user.id }, 'New user registered successfully');

    const { passwordHash: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  async login(data: LoginInput, metadata?: { deviceId?: string; userAgent?: string; ipAddress?: string }) {
    const user = await userRepository.findByEmail(data.email);
    if (!user || user.status === 'DELETED') {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const isPasswordValid = await passwordService.verify(user.passwordHash, data.password);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // Password is valid but the account may be banned. Checked after password
    // verification so we don't leak account status to non-owners.
    if (user.status === 'SUSPENDED') {
      throw new AppError('Your account has been suspended', 403, 'ACCOUNT_SUSPENDED');
    }

    /**
     * Deactivated accounts reactivate by logging in.
     *
     * This sits below the password check on purpose — the same reason the
     * suspension branch does. Reactivating before verifying the password would
     * let anyone who knows an email address pull a hidden account back into
     * public view, which is a stranger undoing the user's decision for them.
     * Verified credentials ARE the confirmation, so there is no separate
     * reactivation token to mint, mail, store or expire.
     *
     * The User module performs the status write; Auth asks for it. Ownership of
     * `User.status` does not move just because this is where the trigger lives.
     */
    const reactivated =
      user.status === 'DEACTIVATED' ? await userService.reactivate(user.id) : false;

    if (reactivated) {
      /**
       * Prime the status cache HERE rather than leaving it to the
       * USER_REACTIVATED subscriber.
       *
       * `emit` is queue-backed: the subscriber runs whenever the domain-events
       * worker gets to it. Deactivation primed this key to DEACTIVATED with a
       * 60-second TTL, so between this login and that dispatch every guarded
       * request from the user would be refused with ACCOUNT_DEACTIVATED — a
       * successful login handing back tokens that do not work yet. Writing it
       * synchronously closes the window; the subscriber remains the backstop for
       * any other path that reactivates an account.
       */
      await accountStatusService.prime(user.id, 'ACTIVE');
      user.status = 'ACTIVE';
      user.deactivatedAt = null;
    }

    const payload: TokenPayload = { userId: user.id, role: user.role };
    const accessToken = tokensService.generateAccessToken(payload);
    const refreshToken = tokensService.generateRefreshToken(payload);

    await sessionService.createSession(user.id, refreshToken, metadata);

    const { passwordHash: _, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken,
      // Lets the client say "welcome back, your account has been reactivated"
      // instead of silently restoring a profile the user last saw hidden.
      reactivated,
    };
  }

  async logout(refreshToken: string) {
    await sessionService.revokeSession(refreshToken);
  }

  async logoutAll(userId: string) {
    await sessionService.revokeAllSessions(userId);
  }

  async refreshTokens(oldRefreshToken: string, metadata?: { deviceId?: string; userAgent?: string; ipAddress?: string }) {
    try {
      const payload = tokensService.verifyRefreshToken(oldRefreshToken);

      const session = await sessionService.validateSession(oldRefreshToken);
      if (!session) {
        throw new AppError('Refresh token revoked or invalid', 401, 'INVALID_REFRESH_TOKEN');
      }

      const user = await userRepository.findById(payload.userId);
      if (!user || user.status !== 'ACTIVE') {
        // Deleted or suspended accounts must not be able to mint fresh tokens.
        throw new AppError('User not found or inactive', 401, 'USER_NOT_FOUND');
      }

      const newPayload: TokenPayload = { userId: user.id, role: user.role };
      const newAccessToken = tokensService.generateAccessToken(newPayload);
      const newRefreshToken = tokensService.generateRefreshToken(newPayload);

      await sessionService.rotateToken(oldRefreshToken, newRefreshToken, user.id, metadata);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }
  }
}

export const authService = new AuthService();
