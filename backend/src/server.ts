import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import app from './app';
import { logger } from './core/utils/logger';
import { redis } from './core/providers/redis';
import { closeWorkers } from './core/providers/queue';
import { prisma } from './core/database/prisma';
// Side-effect imports: start background workers (open Redis connections eagerly).
import './modules/media/media.worker';
import './modules/notification/notification.worker';
import './modules/notification/email.worker';
import { registerNotificationSubscribers } from './modules/notification/subscribers';
import { startDomainEventsWorker } from './core/events/domainEvents.worker';

// Order is load-bearing, and cannot be expressed with import placement: static
// imports are hoisted and all run before any statement here. Subscribers must be
// registered BEFORE the dispatcher consumes, or an already-queued event would
// dispatch to an empty handler list and be silently dropped.
registerNotificationSubscribers();
startDomainEventsWorker();

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    const server = app.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`);
    });

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      server.close(async () => {
        logger.info('HTTP server closed.');
        try {
          // Order matters: drain workers (each holds its own Redis connection and
          // may have a job in flight) before tearing down the shared connection
          // and the DB pool they depend on.
          await closeWorkers();
          await prisma.$disconnect();
          logger.info('Database disconnected.');
          await redis.quit();
          logger.info('Redis disconnected.');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during graceful shutdown');
          process.exit(1);
        }
      });

      setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
};

startServer();
