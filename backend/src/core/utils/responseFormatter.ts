import { Response } from 'express';

export const sendSuccess = (
  res: Response,
  data: any,
  statusCode: number = 200,
  meta?: any
) => {
  res.status(statusCode).json({
    success: true,
    data,
    meta,
  });
};
