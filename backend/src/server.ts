import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import app from './app';
import { logger } from './core/utils/logger';
import { redis } from './core/providers/redis';
import { closeWorkers } from './core/providers/queue';
import { prisma } from './core/database/prisma';
// Side-effect imports: start background workers (open Redis connections eagerly).
import './modules/media/media.worker';
// Dispatches published domain events to subscribers. Must be imported AFTER
// subscribers are registered below, or early jobs would find no handlers.
import './core/events/domainEvents.worker';

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
