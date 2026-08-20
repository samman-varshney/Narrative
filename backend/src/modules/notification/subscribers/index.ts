import { registerFollowSubscriber } from './follow.subscriber';
import { registerBlogSubscriber } from './blog.subscriber';
import { registerCommentSubscriber } from './comment.subscriber';
import { registerModerationNotificationSubscriber } from './moderation.subscriber';
import { registerExportNotificationSubscriber } from './export.subscriber';
import { logger } from '../../../core/utils/logger';

let registered = false;

/**
 * Registers every notification subscriber. This is the module's only inbound
 * seam — no business module calls NotificationService, so this is what makes the
 * whole feature exist.
 *
 * MUST be called from server.ts only, never app.ts. Registering at app import
 * time would make every test that touches `app` start writing notification rows
 * as a side effect of unrelated service calls.
 *
 * Idempotent: a second call is ignored, so a stray import cannot double-register
 * handlers and double-notify.
 */
export function registerNotificationSubscribers(): void {
  if (registered) return;
  registered = true;

  registerFollowSubscriber();
  registerBlogSubscriber();
  registerCommentSubscriber();
  registerModerationNotificationSubscriber();
  registerExportNotificationSubscriber();

  logger.info('Notification subscribers registered');
}

/** Test seam. */
export function resetSubscriberRegistration(): void {
  registered = false;
}
