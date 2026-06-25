import { Request, Response } from 'express';
import { authService } from './auth.service';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { COOKIE_CONFIG } from '../../core/config/cookies';
import { userRepository } from '../user/user.repository';
import { eventBus, EVENTS } from '../../core/events/eventBus';
import { passwordService } from './password.service';
import { AppError } from '../../core/exceptions/AppError';

const setRefreshTokenCookie = (res: Response, token: string) => {
  res.cookie(COOKIE_CONFIG.REFRESH_TOKEN.name, token, COOKIE_CONFIG.REFRESH_TOKEN.options);
};

const clearRefreshTokenCookie = (res: Response) => {
  res.clearCookie(COOKIE_CONFIG.REFRESH_TOKEN.name, COOKIE_CONFIG.REFRESH_TOKEN.options);
};

const extractMetadata = (req: Request) => ({
  userAgent: req.headers['user-agent'],
  ipAddress: req.ip,
  deviceId: req.headers['x-device-id'] as string, // Optional device ID header
});

export class AuthController {
  async register(req: Request, res: Response) {
    const user = await authService.register(req.body);
    sendSuccess(res, { user }, 201, { message: 'Registration successful' });
  }

  async login(req: Request, res: Response) {
    const { user, accessToken, refreshToken } = await authService.login(req.body, extractMetadata(req));
    setRefreshTokenCookie(res, refreshToken);
    sendSuccess(res, { user, accessToken }, 200, { message: 'Login successful' });
  }

  async logout(req: Request, res: Response) {
    const refreshToken = req.cookies?.[COOKIE_CONFIG.REFRESH_TOKEN.name];
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    clearRefreshTokenCookie(res);
    sendSuccess(res, null, 200, { message: 'Logged out successfully' });
  }

  async refresh(req: Request, res: Response) {
    const oldRefreshToken = req.cookies?.[COOKIE_CONFIG.REFRESH_TOKEN.name];
    if (!oldRefreshToken) {
      return res.status(401).json({ success: false, error: { code: 'NO_TOKEN', message: 'No refresh token provided' } });
    }

    const { accessToken, refreshToken } = await authService.refreshTokens(oldRefreshToken, extractMetadata(req));
    setRefreshTokenCookie(res, refreshToken);
    sendSuccess(res, { accessToken }, 200, { message: 'Token refreshed' });
  }

  async logoutAll(req: Request, res: Response) {
    const userId = req.user?.userId;
    if (userId) {
      await authService.logoutAll(userId);
    }
    clearRefreshTokenCookie(res);
    sendSuccess(res, null, 200, { message: 'Logged out from all devices' });
  }

  async getMe(req: Request, res: Response) {
    const user = await userRepository.findById(req.user!.userId);
    if (!user) throw new AppError('User not found', 404);
    
    const { passwordHash: _, ...userWithoutPassword } = user;
    sendSuccess(res, { user: userWithoutPassword });
  }

  async changePassword(req: Request, res: Response) {
    const userId = req.user!.userId;
    const { currentPassword, newPassword } = req.body;

    const user = await userRepository.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const isPasswordValid = await passwordService.verify(user.passwordHash, currentPassword);
    if (!isPasswordValid) throw new AppError('Incorrect current password', 400);

    const newPasswordHash = await passwordService.hash(newPassword);
    await userRepository.update(userId, { passwordHash: newPasswordHash });

    sendSuccess(res, null, 200, { message: 'Password changed successfully' });
  }

  // Scaffolded Endpoints
  async verifyEmail(req: Request, res: Response) {
    // Logic to verify email token goes here
    sendSuccess(res, null, 200, { message: 'Email verified' });
  }

  async forgotPassword(req: Request, res: Response) {
    const { email } = req.body;
    const user = await userRepository.findByEmail(email);
    if (user) {
      eventBus.emit(EVENTS.PASSWORD_RESET_REQUESTED, { userId: user.id, email: user.email });
    }
    // Always return success to prevent email enumeration
    sendSuccess(res, null, 200, { message: 'If an account exists, a reset link has been sent' });
  }

  async resetPassword(req: Request, res: Response) {
    // Logic to process reset token and change password goes here
    sendSuccess(res, null, 200, { message: 'Password reset successfully' });
  }
}

export const authController = new AuthController();
