import { Router } from 'express';
import { notificationController } from './notification.controller';
import { requireAuth } from '../../core/middlewares/requireAuth';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { catchAsync } from '../../core/utils/asyncHandler';
import { updatePreferencesSchema } from './notification.validator';

/**
 * Mounted at /api/v1/notifications.
 *
 * Every route requires auth and is implicitly scoped to the token's user —
 * notifications are private, so there is no anonymous surface and no route that
 * takes a user id. Auth is applied per route, never via `router.use()`.
 *
 * Literal paths are declared BEFORE `/:id/...` so Express matches them first:
 * without that, `/unread-count` and `/read-all` would be captured as an `:id`.
 */
const router = Router();

// Literal routes first.
router.get('/unread-count', requireAuth, catchAsync(notificationController.unreadCount));
router.patch('/read-all', requireAuth, catchAsync(notificationController.markAllRead));

router.get('/preferences', requireAuth, catchAsync(notificationController.getPreferences));
router.patch(
  '/preferences',
  requireAuth,
  validateRequest(updatePreferencesSchema),
  catchAsync(notificationController.updatePreferences)
);

// Parameterised routes last.
router.get('/', requireAuth, catchAsync(notificationController.list));
router.patch('/:id/read', requireAuth, catchAsync(notificationController.markRead));

export const notificationRoutes = router;
