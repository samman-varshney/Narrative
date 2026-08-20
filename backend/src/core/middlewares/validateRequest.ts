import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodError } from 'zod';
import { AppError } from '../exceptions/AppError';

export const validateRequest = (schema: ZodType) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // `req.body` is undefined when a request carries no JSON body at all —
      // Express only populates it when `express.json()` recognises the content
      // type. Treating that as an empty object is what lets a schema whose
      // fields are ALL optional (the moderation action bodies: an optional
      // reason, an optional report id) accept a bodyless POST, and it improves
      // the error for every other schema too: "title is required" instead of
      // "expected object, received undefined".
      await schema.parseAsync(req.body ?? {});
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }));
        next(new AppError('Validation failed', 400, 'VALIDATION_ERROR', true, details));
      } else {
        next(error);
      }
    }
  };
};
