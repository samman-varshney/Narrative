import { Queue, Worker } from 'bullmq';
import { redis, createRedisConnection } from './redis';
import { logger } from '../utils/logger';

// Queue names
export const QUEUES = {
  EMAIL: 'email_queue',
  NOTIFICATION: 'notification_queue',
  MEDIA_PROCESSING: 'media_processing',
  ANALYTICS_FLUSH: 'analytics_flush',
};

// Generic function to create a queue
export const createQueue = (queueName: string) => {
  return new Queue(queueName, { connection: redis });
};

// Generic function to create a worker
export const createWorker = (
  queueName: string,
  processor: (job: any) => Promise<any>
) => {
  const workerConnection = createRedisConnection();
  const worker = new Worker(queueName, processor, { connection: workerConnection });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, `Job completed in queue ${queueName}`);
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, `Job failed in queue ${queueName}`);
  });

  return worker;
};

// Initialize Queues
export const emailQueue = createQueue(QUEUES.EMAIL);
export const notificationQueue = createQueue(QUEUES.NOTIFICATION);
export const analyticsQueue = createQueue(QUEUES.ANALYTICS_FLUSH);
