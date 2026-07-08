import { Router } from 'express';
import { mediaController } from './media.controller';
import { requireAuth } from '../../core/middlewares/requireAuth';
import { validateRequest } from '../../core/middlewares/validateRequest';
import { upload } from '../../core/middlewares/upload';
import { catchAsync } from '../../core/utils/asyncHandler';
import { uploadMediaSchema } from './media.validator';

const router = Router();

// All media routes require authentication.
router.use(requireAuth);

// upload.single runs before validateRequest so multipart text fields populate req.body.
router.post(
  '/upload',
  upload.single('file'),
  validateRequest(uploadMediaSchema),
  catchAsync(mediaController.upload)
);

router.get('/:id', catchAsync(mediaController.get));

router.patch('/:id/replace', upload.single('file'), catchAsync(mediaController.replace));

router.delete('/:id', catchAsync(mediaController.remove));

export const mediaRoutes = router;
