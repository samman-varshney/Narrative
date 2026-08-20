import { logger } from '../../../core/utils/logger';
import { registerContentModerationSubscriber } from './content.subscriber';

let registered = false;

/**
 * Registers the Moderation module's event subscribers.
 *
 * MUST be called from `server.ts`, never from `app.ts`: registering at app
 * import time would make every test that touches `app` start evaluating content
 * and writing report rows as a side effect of unrelated service calls. Same
 * rule, and same reason, as every other module's registration.
 *
 * Idempotent — a second call is ignored, so a stray import cannot double-file
 * automated reports.
 */
export function registerModerationSubscribers(): void {
  if (registered) return;
  registered = true;

  registerContentModerationSubscriber();

  logger.info('Moderation subscribers registered');
}

/** Test seam. */
export function resetModerationSubscriberRegistration(): void {
  registered = false;
}
