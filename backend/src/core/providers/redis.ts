import { Redis } from 'ioredis';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const createRedisConnection = () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});
