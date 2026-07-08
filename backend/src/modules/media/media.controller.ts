import { Request, Response } from 'express';
import { mediaService } from './media.service';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { AppError } from '../../core/exceptions/AppError';

export class MediaController {
  async upload(req: Request, res: Response) {
    if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');
    const media = await mediaService.uploadImage(req.user!.userId, req.file, req.body);
    sendSuccess(res, { media }, 201, { message: 'Media uploaded successfully' });
  }

  async get(req: Request, res: Response) {
    const id = req.params.id as string;
    const media = await mediaService.getMedia(id, req.user!.userId);
    sendSuccess(res, { media });
  }

  async replace(req: Request, res: Response) {
    if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');
    const id = req.params.id as string;
    const media = await mediaService.replaceMedia(id, req.user!.userId, req.file);
    sendSuccess(res, { media }, 200, { message: 'Media replaced successfully' });
  }

  async remove(req: Request, res: Response) {
    const id = req.params.id as string;
    await mediaService.deleteMedia(id, req.user!.userId);
    sendSuccess(res, null, 200, { message: 'Media deleted successfully' });
  }
}

export const mediaController = new MediaController();
