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
let worker: ReturnType<typeof createWorker> | null = null;

/**
 * Starts consuming domain events.
 *
 * Deliberately a function rather than a side-effect import: static ES imports
 * are hoisted and all run before any top-level statement, so an import-time
 * worker would begin consuming BEFORE `registerNotificationSubscribers()` ran —
 * and any event already queued would dispatch to an empty handler list and be
 * silently dropped. Callers must register subscribers first, then call this.
 *
 * Idempotent: a second call returns the existing worker.
 */
export function startDomainEventsWorker() {
  if (worker) return worker;

  worker = createWorker(QUEUES.DOMAIN_EVENTS, async (job) => {
    const { event, payload, eventId, emittedAt } = job.data as {
      event?: string;
      payload?: unknown;
      eventId?: string;
      emittedAt?: string;
    };

    if (!event) {
      logger.warn({ jobId: job.id }, 'Domain event job missing an event name — skipped');
      return;
    }

    // `eventId` is absent only on jobs enqueued before the bus started minting
    // one. The job id is the right fallback: BullMQ keeps it fixed across every
    // attempt, so a deduplicating subscriber still sees one stable key per
    // delivery rather than a fresh id on each retry.
    await eventBus.dispatch(event, payload, {
      eventId: eventId ?? `job:${job.id}`,
      event,
      emittedAt: emittedAt ?? new Date().toISOString(),
    });
  });

  logger.info('Domain events worker started');
  return worker;
}
