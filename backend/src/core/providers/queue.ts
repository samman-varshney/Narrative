import { Queue, Worker } from 'bullmq';
import { redis, createRedisConnection } from './redis';
import { logger } from '../utils/logger';

// Queue names
export const QUEUES = {
  EMAIL: 'email_queue',
  NOTIFICATION: 'notification_queue',
  DOMAIN_EVENTS: 'domain_events',
  MEDIA_PROCESSING: 'media_processing',
  ANALYTICS_FLUSH: 'analytics_flush',
  DATA_EXPORT: 'data_export',
};

/**
 * Job policy applied to every queue. Previously each queue was created with only
 * a connection, so the retry/backoff/DLQ behaviour the architecture doc promises
 * was never actually configured — jobs failed once and vanished.
 *
 * `removeOnFail` deliberately KEEPS failures for a day: a failed job is the only
 * record that something went wrong, so it must outlive the process that dropped it.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

// Generic function to create a queue
export const createQueue = (queueName: string) => {
  return new Queue(queueName, {
    connection: redis as any,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
};

/**
 * Every worker created here, so shutdown can close them all.
 *
 * Without this, `server.ts` closed only the shared Redis singleton while each
 * worker held its own connection — in-flight jobs were killed mid-execution and
 * the process fell back to the 10s force-exit.
 */
const workers: Worker[] = [];

// Generic function to create a worker
export const createWorker = (
  queueName: string,
  processor: (job: any) => Promise<any>
) => {
  const workerConnection = createRedisConnection();
  const worker = new Worker(queueName, processor, { connection: workerConnection as any });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, `Job completed in queue ${queueName}`);
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, `Job failed in queue ${queueName}`);
  });

  workers.push(worker);
  return worker;
};

/**
 * Closes every worker, letting in-flight jobs finish first (BullMQ's `close()`
 * waits for the active job to complete before releasing the connection). Safe to
 * call when no workers were ever started.
 */
export const closeWorkers = async (): Promise<void> => {
  if (workers.length === 0) return;
  logger.info({ count: workers.length }, 'Closing background workers...');
  await Promise.all(
    workers.map((w) =>
      w.close().catch((err) => logger.error({ err }, 'Error closing worker'))
    )
  );
  logger.info('Background workers closed.');
};

// Initialize Queues
export const emailQueue = createQueue(QUEUES.EMAIL);
export const notificationQueue = createQueue(QUEUES.NOTIFICATION);
export const domainEventsQueue = createQueue(QUEUES.DOMAIN_EVENTS);
export const analyticsQueue = createQueue(QUEUES.ANALYTICS_FLUSH);
export const mediaQueue = createQueue(QUEUES.MEDIA_PROCESSING);
export const exportQueue = createQueue(QUEUES.DATA_EXPORT);
