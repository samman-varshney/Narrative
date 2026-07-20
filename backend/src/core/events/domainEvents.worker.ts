import { createWorker, QUEUES } from '../providers/queue';
import { eventBus } from './eventBus';
import { logger } from '../utils/logger';

/**
 * DOMAIN_EVENTS worker — the other half of the durable event bus.
 *
 * Consumes published domain events and runs every registered subscriber. This is
 * what moves subscriber work off the HTTP request path: `emit` only enqueues.
 *
 * IMPORTANT: like every worker, this opens a Redis connection and starts polling
 * on construction, so it must be imported ONLY from server.ts — never from
 * app.ts or a service — or test suites that import `app` will spin up a live
 * worker. (In tests `eventBus.emit` dispatches inline instead; see eventBus.ts.)
 *
 * `eventBus.dispatch` isolates each handler's failure, so one broken subscriber
 * neither blocks its siblings nor fails the job. A job therefore only fails —
 * and retries — on infrastructure errors, not on subscriber bugs.
 */
export const domainEventsWorker = createWorker(QUEUES.DOMAIN_EVENTS, async (job) => {
  const { event, payload } = job.data as { event?: string; payload?: unknown };

  if (!event) {
    logger.warn({ jobId: job.id }, 'Domain event job missing an event name — skipped');
    return;
  }

  await eventBus.dispatch(event, payload);
});
