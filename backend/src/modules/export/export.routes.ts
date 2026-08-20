import { Router } from 'express';
import { requireAuth, requireActiveAccount } from '../../core/middlewares/requireAuth';
import { exportRequestLimiter } from '../../core/middlewares/rateLimiter';
import { catchAsync } from '../../core/utils/asyncHandler';
import { exportController } from './export.controller';

const router = Router();

/**
 * Every route here is about the CALLER's own data. There is no `:userId`
 * anywhere in this module — the subject is always `req.user.userId` from the
 * verified access token, so "export someone else's account" is not an
 * authorization check that could be forgotten, it is unrepresentable.
 */
router.use(requireAuth);

/**
 * Requesting a build requires an account in good standing; reading and
 * downloading do not.
 *
 * The asymmetry is the point. A build is expensive and is a write, so a
 * suspended account should not be able to start one. But an artifact that was
 * already produced belongs to the person who asked for it, and withholding it
 * from a suspended user would make moderation a way to cut someone off from
 * their own data — which is exactly the outcome an export feature exists to
 * prevent.
 */
router.post(
  '/',
  requireActiveAccount,
  exportRequestLimiter,
  catchAsync(exportController.request)
);

router.get('/', catchAsync(exportController.list));
router.get('/:id', catchAsync(exportController.getById));
router.get('/:id/download', catchAsync(exportController.download));

export const exportRoutes = router;
