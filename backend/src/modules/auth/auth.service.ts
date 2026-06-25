import { userRepository } from '../user/user.repository';
import { tokensService, TokenPayload } from './tokens.service';
import { passwordService } from './password.service';
import { sessionService } from './session.service';
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
    if (!user || user.isDeleted) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const isPasswordValid = await passwordService.verify(user.passwordHash, data.password);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
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
      if (!user || user.isDeleted) {
        throw new AppError('User not found or deleted', 401, 'USER_NOT_FOUND');
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
