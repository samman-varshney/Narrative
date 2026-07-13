import { Request, Response, NextFunction } from 'express';
import { AppError } from '../exceptions/AppError';
import { tokensService } from '../../modules/auth/tokens.service';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: string;
      };
    }
  }
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const token = authHeader.split(' ')[1];
    
    if (!token) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const payload = tokensService.verifyAccessToken(token);
    
    // Attach user payload to the request object
    req.user = {
      userId: payload.userId,
      role: payload.role,
    };

    next();
  } catch (error) {
    next(new AppError('Invalid or expired token', 401, 'UNAUTHORIZED'));
  }
};

/**
 * Optional authentication. Populates `req.user` when a valid Bearer token is
 * present, but never rejects the request when the token is absent or invalid —
 * control always passes to the next handler. Used by endpoints that are public
 * yet personalize their response for signed-in viewers (e.g. follower lists that
 * annotate each item with `isFollowedByViewer`).
 */
export const optionalAuth = (req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return next();
  }

  try {
    const payload = tokensService.verifyAccessToken(token);
    req.user = {
      userId: payload.userId,
      role: payload.role,
    };
  } catch {
    // Invalid/expired token on an optional route: treat as anonymous.
  }

  next();
};

export const requireRole = (roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('Forbidden: Insufficient role', 403, 'FORBIDDEN'));
    }
    next();
  };
};

export const requirePermission = (permissions: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Scaffolded for future permission logic (e.g., checking DB or JWT scopes)
    if (!req.user) {
      return next(new AppError('Forbidden: Insufficient permissions', 403, 'FORBIDDEN'));
    }
    next();
  };
};
