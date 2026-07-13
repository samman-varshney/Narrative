import { z } from 'zod';
import { paginationQuerySchema } from '../../core/utils/pagination';

/**
 * Route-parameter schema for endpoints targeting a specific user
 * (`/users/:userId/...`). The follower is always taken from the authenticated
 * session — never from params — so this only validates the target id.
 */
export const userIdParamSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
});
export type UserIdParam = z.infer<typeof userIdParamSchema>;

/**
 * Query schema for the paginated followers/following lists. Re-exported from the
 * shared cursor-pagination helper so every feed endpoint validates identically.
 */
export const followListQuerySchema = paginationQuerySchema;
export type FollowListQuery = z.infer<typeof followListQuerySchema>;
