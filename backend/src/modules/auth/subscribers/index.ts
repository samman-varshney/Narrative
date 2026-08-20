import { logger } from '../../../core/utils/logger';
import { registerAuthSubscriber } from './auth.subscriber';

let registered = false;

/**
 * Registers Auth's event subscribers.
 *
 * MUST be called from `server.ts`, never from `app.ts`: registering at app
 * import time would make every test that touches `app` start writing to Redis
 * and deleting session rows as a side effect of unrelated service calls. Same
 * rule, and same reason, as the Notification, Search, Feed and Dashboard
 * registrations.
 *
 * Idempotent — a second call is ignored, so a stray import cannot double-revoke.
 */
export function registerAuthSubscribers(): void {
  if (registered) return;
  registered = true;

  registerAuthSubscriber();

  logger.info('Auth subscribers registered');
}

/** Test seam. */
export function resetAuthSubscriberRegistration(): void {
  registered = false;
}
