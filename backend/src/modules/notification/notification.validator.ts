import { z } from 'zod';
import { NotificationType } from '@prisma/client';
import { paginationQuerySchema } from '../../core/utils/pagination';
import { notificationPreferencesSchema } from './notification.preferences';

export const notificationIdParamSchema = z.object({
  id: z.string().min(1, 'id is required'),
});
export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;

/**
 * List query. Inherits `cursor` and the bounded `limit` from the shared
 * pagination schema. `isRead` arrives as a query string, so it is coerced from
 * 'true'/'false' rather than parsed as a boolean.
 */
export const notificationListQuerySchema = paginationQuerySchema.extend({
  sort: z.enum(['recent', 'oldest']).default('recent'),
  type: z.enum(NotificationType).optional(),
  // `.transform()` before `.optional()` — the other order yields a REQUIRED key
  // typed `boolean | undefined`, forcing every caller to pass it explicitly.
  isRead: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/**
 * Preference updates are a partial patch: the body carries only the types (and
 * within a type, only the channels) the user actually changed. Everything else
 * keeps its stored value, or the default if never set.
 */
export const updatePreferencesSchema = notificationPreferencesSchema;
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
