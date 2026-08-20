import { logger } from '../../../core/utils/logger';
import { registerBlogAnalyticsSubscriber } from './blog.subscriber';
import { registerEngagementAnalyticsSubscriber } from './engagement.subscriber';
import { registerUserAnalyticsSubscriber } from './user.subscriber';

/**
 * Registers every analytics subscriber.
 *
 * This is the module's only inbound seam. No business module calls
 * `AnalyticsService` — the dependency runs entirely the other way — so these
 * three registrations are what makes analytics collection exist at all.
 *
 * MUST be called from server.ts only, never app.ts. Registering at app import
 * time would make every test that touches `app` start writing Redis buffers as a
 * side effect of unrelated service calls, and would do it before the flush
 * worker exists to drain them. Same rule, and same reason, as
 * `registerNotificationSubscribers` and `registerSearchSubscribers`.
 *
 * Idempotent: a second call is ignored, so a stray import cannot double-register
 * and double-count every view on the platform.
 */

let registered = false;

export function registerAnalyticsSubscribers(): void {
  if (registered) return;
  registered = true;

  registerBlogAnalyticsSubscriber();
  registerEngagementAnalyticsSubscriber();
  registerUserAnalyticsSubscriber();

  logger.info('Analytics subscribers registered');
}

/** Test seam. */
export function resetAnalyticsSubscriberRegistration(): void {
  registered = false;
}
