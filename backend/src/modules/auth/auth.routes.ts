import { Router } from 'express';
import { authController } from './auth.controller';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { registerSchema, loginSchema, changePasswordSchema } from './auth.validator';
import { catchAsync } from '../../core/utils/asyncHandler';
import { requireAuth } from '../../core/middlewares/requireAuth';

const router = Router();

// Public routes
router.post('/register', validateRequest(registerSchema), catchAsync(authController.register));
router.post('/login', validateRequest(loginSchema), catchAsync(authController.login));
router.post('/refresh', catchAsync(authController.refresh));

router.post('/forgot-password', catchAsync(authController.forgotPassword));
router.post('/reset-password', catchAsync(authController.resetPassword));
router.post('/verify-email', catchAsync(authController.verifyEmail));

// Protected routes
router.post('/logout', requireAuth, catchAsync(authController.logout));
router.post('/logout-all', requireAuth, catchAsync(authController.logoutAll));

router.get('/me', requireAuth, catchAsync(authController.getMe));
router.patch('/change-password', requireAuth, validateRequest(changePasswordSchema), catchAsync(authController.changePassword));

export const authRoutes = router;
