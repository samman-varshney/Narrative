import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { AppError } from '../exceptions/AppError';
import { logger } from '../utils/logger';

export const globalErrorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof AppError) {
    logger.error({ err, path: req.path }, err.message);
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.errorCode,
        message: err.message,
        details: err.details,
      },
    });
  }

  // Multer surfaces client-side upload problems (oversized file, too many parts, etc.)
  // as MulterError — these are operational 400s, not server faults.
  if (err instanceof MulterError) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR';
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the maximum allowed size' : err.message;
    logger.warn({ err, path: req.path }, 'Upload rejected by multer');
    return res.status(400).json({
      success: false,
      error: { code, message },
    });
  }

  // Fallback for unexpected errors
  logger.error({ err, path: req.path }, 'Unhandled Exception');
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
};
