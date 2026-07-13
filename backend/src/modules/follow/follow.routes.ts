import { Router } from 'express';
import { followController } from './follow.controller';
import { requireAuth, optionalAuth } from '../../core/middlewares/requireAuth';
import { catchAsync } from '../../core/utils/asyncHandler';

/**
 * Follow routes are nested under the user resource (`/api/v1/users/:userId/...`).
 * Auth is applied PER ROUTE (never `router.use(requireAuth)`) so this router can
 * share the `/api/v1/users` mount with userRoutes without gating its public
 * siblings. It must be registered BEFORE userRoutes in app.ts (see app.ts).
 *
 *  - follow / unfollow / follow-status : require authentication
 *  - followers / following lists       : public, personalized when a token is present
 */
const router = Router();

router.post('/:userId/follow', requireAuth, catchAsync(followController.follow));
router.delete('/:userId/follow', requireAuth, catchAsync(followController.unfollow));

router.get('/:userId/followers', optionalAuth, catchAsync(followController.getFollowers));
router.get('/:userId/following', optionalAuth, catchAsync(followController.getFollowing));

router.get('/:userId/follow-status', requireAuth, catchAsync(followController.followStatus));

export const followRoutes = router;
