import { Router } from 'express';
import { userController } from './user.controller';
import { requireAuth } from '../../core/middlewares/requireAuth';
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

router.get('/me/profile', catchAsync(userController.getMe)); // Aliased for clarity
router.patch('/me', validateRequest(updateProfileSchema), catchAsync(userController.updateProfile));
router.delete('/me', catchAsync(userController.softDelete));

router.get('/me/stats', catchAsync(userController.getStats));
router.get('/me/sessions', catchAsync(userController.getSessions));

router.patch('/me/developer', validateRequest(updateDeveloperProfileSchema), catchAsync(userController.updateDeveloperProfile));
router.patch('/me/skills', validateRequest(updateSkillsSchema), catchAsync(userController.updateSkills));

router.patch('/me/avatar', upload.single('avatar'), catchAsync(userController.uploadAvatar));
router.delete('/me/avatar', catchAsync(userController.deleteAvatar));

router.patch('/me/preferences', validateRequest(updateSettingsSchema), catchAsync(userController.updateSettings));
router.patch('/me/privacy', validateRequest(updatePrivacySchema), catchAsync(userController.updateSettings));

export const userRoutes = router;
