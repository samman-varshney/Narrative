import { Request, Response } from 'express';
import { sendSuccess } from '../../core/utils/responseFormatter';
import { exportService } from './export.service';

export class ExportController {
  async request(req: Request, res: Response) {
    const request = await exportService.request(req.user!.userId);
    // 202, not 201: the request is accepted and the artifact does not exist yet.
    // A 201 would tell the client something is there to fetch.
    sendSuccess(res, { request }, 202, {
      message: 'Your export is being prepared. We will notify you when it is ready.',
    });
  }

  async list(req: Request, res: Response) {
    const requests = await exportService.listForUser(req.user!.userId);
    sendSuccess(res, { requests });
  }

  async getById(req: Request, res: Response) {
    const request = await exportService.getById(req.params.id as string, req.user!.userId);
    sendSuccess(res, { request });
  }

  /**
   * The download. Deliberately NOT wrapped in `sendSuccess` — this response is
   * the artifact itself, not a JSON envelope around it.
   *
   * The bytes are already gzip, so they are sent with `Content-Encoding: gzip`
   * and the underlying type declared as JSON. A client that understands the
   * encoding gets usable JSON with no extra step; `Content-Length` is set from
   * the stored size so progress bars work.
   */
  async download(req: Request, res: Response) {
    const { artifact, checksum, filename } = await exportService.download(
      req.params.id as string,
      req.user!.userId
    );

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', artifact.length);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (checksum) res.setHeader('X-Checksum-SHA256', checksum);
    // An export must never be cached by a proxy or a shared browser cache.
    res.setHeader('Cache-Control', 'no-store, private');

    res.status(200).end(artifact);
  }
}

export const exportController = new ExportController();
