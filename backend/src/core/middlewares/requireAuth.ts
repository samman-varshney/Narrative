import { Request, Response, NextFunction } from 'express';
import { AppError } from '../exceptions/AppError';
import { tokensService } from '../../modules/auth/tokens.service';
import { accountStatusService } from '../../modules/auth/accountStatus.service';
import { hasPermission, type Permission } from '../../modules/auth/permissions';

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

/**
 * Requires EVERY listed permission, resolved from the caller's role through the
 * catalogue in `modules/auth/permissions.ts`.
 *
 * AND rather than OR: a route that needs two capabilities needs both, and a
 * route that would be satisfied by either should say so by listing one.
 *
 * MUST be composed after `requireAuth` — it authorizes, it does not
 * authenticate. A missing `req.user` is treated as unauthorized (401) rather
 * than forbidden, so a route accidentally mounted without `requireAuth` fails
 * loudly and correctly instead of leaking an admin surface to anonymous callers.
 */
export const requirePermission = (permissions: Permission[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }

    const granted = permissions.every((permission) =>
      hasPermission(req.user!.role, permission)
    );

    if (!granted) {
      // The message never names the missing permission: telling a caller which
      // capability they lack tells an attacker which role to go after.
      return next(new AppError('Forbidden: Insufficient permissions', 403, 'FORBIDDEN'));
    }

    next();
  };
};

/**
 * Requires the caller's ACCOUNT to still be in good standing, not merely their
 * token to be valid.
 *
 * `requireAuth` proves who the caller is from a signed token. It cannot prove
 * the account still exists or is still allowed to act, because that changed
 * after the token was minted — which is precisely the case when a moderator
 * suspends someone mid-session. See `accountStatus.service.ts` for why this is
 * a per-request check and what it costs (a Redis GET, warm).
 *
 * Applied to WRITE routes only. A suspended account may still read the platform
 * and see why it was suspended; what it may not do is act. Gating reads as well
 * would put this lookup on the highest-volume paths on the platform to prevent
 * nothing.
 */
export const requireActiveAccount = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
  }

  try {
    const status = await accountStatusService.getStatus(req.user.userId);

    if (status === 'SUSPENDED') {
      return next(
        new AppError('Your account has been suspended', 403, 'ACCOUNT_SUSPENDED')
      );
    }

    // Deactivated accounts get their own code so the client can offer the way
    // back rather than showing a dead end. The generic 401 below would be
    // indistinguishable from a deleted account, and the two have opposite
    // remedies: one is "log in again to reactivate", the other is "this account
    // is gone". 403 rather than 401 for the same reason suspension is — the
    // token authenticates fine, the account simply may not act.
    if (status === 'DEACTIVATED') {
      return next(
        new AppError('Your account is deactivated', 403, 'ACCOUNT_DEACTIVATED')
      );
    }

    // A deleted account, or a token for a user that no longer exists: the token
    // is valid but its subject is gone, which is an authentication failure
    // rather than a permission one.
    if (status !== 'ACTIVE') {
      return next(new AppError('Account is no longer active', 401, 'UNAUTHORIZED'));
    }

    next();
  } catch (err) {
    // Deliberately NOT swallowed into a pass. A status check that fails open is
    // the same as no status check at all on exactly the requests that matter.
    next(err);
  }
};
