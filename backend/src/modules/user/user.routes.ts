import { Router } from 'express';
import { userController } from './user.controller';
import { requireAuth, requireActiveAccount } from '../../core/middlewares/requireAuth';
import { profileWriteLimiter } from '../../core/middlewares/rateLimiter';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { upload } from '../../core/middlewares/upload';
import { catchAsync } from '../../core/utils/asyncHandler';
import {
  updateProfileSchema,
  updateDeveloperProfileSchema,
  updateSettingsSchema,
  updatePrivacySchema,
  updateSkillsSchema,
} from './user.validator';

const router = Router();

// Public Routes
router.get('/search', catchAsync(userController.search));
router.get('/:username', catchAsync(userController.getPublicProfile));

// Protected Routes
router.use(requireAuth);

/**
 * Profile MUTATIONS additionally require an account in good standing and carry
 * their own limiter.
 *
 * Both guard the same abuse: an account renaming and re-avataring itself to
 * evade recognition, or cycling an abusive display name through everyone's
 * notifications. Reads (`/me/profile`, `/me/stats`, `/me/sessions`) are
 * deliberately left open to a suspended user — they must be able to see their
 * own account, including why it was suspended.
 *
 * Collected in one array and spread onto each mutation rather than applied with
 * a `router.use()`: a `use()` here would also catch the reads above it, and a
 * read that starts refusing suspended users is exactly the regression this
 * comment exists to prevent. Account DELETION is exempt — a suspended user may
 * still leave.
 */
const profileWriteGuards = [requireActiveAccount, profileWriteLimiter];

router.get('/me/profile', catchAsync(userController.getMe)); // Aliased for clarity
router.patch('/me', profileWriteGuards, validateRequest(updateProfileSchema), catchAsync(userController.updateProfile));
router.delete('/me', catchAsync(userController.softDelete));

/**
 * Deactivation carries `profileWriteGuards` while deletion, right above it,
 * carries none — and the difference is deliberate.
 *
 * Leaving is always permitted; HIDING is not. A suspended user allowed to
 * deactivate could log straight back in to an ACTIVE account, because
 * reactivation is exactly what a successful login does — the suspension would
 * launder itself away through a feature built for something else.
 * `userService.deactivate` enforces the same rule at the UPDATE, so this guard
 * is the polite refusal rather than the only one.
 */
router.post('/me/deactivate', profileWriteGuards, catchAsync(userController.deactivate));

router.get('/me/stats', catchAsync(userController.getStats));
router.get('/me/sessions', catchAsync(userController.getSessions));

router.patch('/me/developer', profileWriteGuards, validateRequest(updateDeveloperProfileSchema), catchAsync(userController.updateDeveloperProfile));
router.patch('/me/skills', profileWriteGuards, validateRequest(updateSkillsSchema), catchAsync(userController.updateSkills));

router.patch('/me/avatar', profileWriteGuards, upload.single('avatar'), catchAsync(userController.uploadAvatar));
router.delete('/me/avatar', profileWriteGuards, catchAsync(userController.deleteAvatar));

router.patch('/me/preferences', profileWriteGuards, validateRequest(updateSettingsSchema), catchAsync(userController.updateSettings));
router.patch('/me/privacy', profileWriteGuards, validateRequest(updatePrivacySchema), catchAsync(userController.updateSettings));

export const userRoutes = router;
