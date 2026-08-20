import { Request, Response } from 'express';
import { userService } from './user.service';
import { sessionService } from '../auth/session.service';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { AppError } from '../../core/exceptions/AppError';

export class UserController {
  async getMe(req: Request, res: Response) {
    const user = await userService.getMe(req.user!.userId);
    sendSuccess(res, { user });
  }

  async updateProfile(req: Request, res: Response) {
    const user = await userService.updateProfile(req.user!.userId, req.body);
    sendSuccess(res, { user }, 200, { message: 'Profile updated successfully' });
  }

  async updateDeveloperProfile(req: Request, res: Response) {
    const user = await userService.updateDeveloperProfile(req.user!.userId, req.body);
    sendSuccess(res, { user }, 200, { message: 'Developer profile updated successfully' });
  }

  async updateSettings(req: Request, res: Response) {
    const user = await userService.updateSettings(req.user!.userId, req.body);
    sendSuccess(res, { user }, 200, { message: 'Settings updated successfully' });
  }

  async updateSkills(req: Request, res: Response) {
    const user = await userService.updateSkills(req.user!.userId, req.body);
    sendSuccess(res, { user }, 200, { message: 'Skills updated successfully' });
  }

  async uploadAvatar(req: Request, res: Response) {
    if (!req.file) {
      throw new AppError('No file uploaded', 400);
    }
    const result = await userService.uploadAvatar(
      req.user!.userId,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    sendSuccess(res, result, 200, { message: 'Avatar updated successfully' });
  }

  async deleteAvatar(req: Request, res: Response) {
    await userService.deleteAvatar(req.user!.userId);
    sendSuccess(res, null, 200, { message: 'Avatar removed successfully' });
  }

  async softDelete(req: Request, res: Response) {
    await userService.softDelete(req.user!.userId);
    // Says "deleted", because that is what it does. It previously reported a
    // deactivation while writing DELETED — now that the two are genuinely
    // different operations, the message has to name the right one.
    sendSuccess(res, null, 200, { message: 'Account deleted successfully' });
  }

  async deactivate(req: Request, res: Response) {
    await userService.deactivate(req.user!.userId);
    sendSuccess(res, null, 200, {
      message: 'Account deactivated. Log in again at any time to reactivate it.',
    });
  }

  async getStats(req: Request, res: Response) {
    const stats = await userService.getStats(req.user!.userId);
    sendSuccess(res, { stats });
  }

  async getSessions(req: Request, res: Response) {
    const sessions = await sessionService.getUserSessions(req.user!.userId);
    sendSuccess(res, { sessions });
  }

  async search(req: Request, res: Response) {
    const query = req.query.q as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;

    if (!query) throw new AppError('Search query is required', 400);

    const users = await userService.search(query, page, limit);
    sendSuccess(res, { users });
  }

  async getPublicProfile(req: Request, res: Response) {
    const username = req.params.username as string;
    const profile = await userService.getPublicProfile(username);
    sendSuccess(res, { profile });
  }
}

export const userController = new UserController();
