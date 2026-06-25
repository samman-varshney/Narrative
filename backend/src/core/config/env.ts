import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load variables based on NODE_ENV, default to .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string().url('Must be a valid Postgres connection string'),
  REDIS_URL: z.string().url('Must be a valid Redis connection string').default('redis://127.0.0.1:6379'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  JWT_ACCESS_SECRET: z.string().min(10, 'Access secret too short'),
  JWT_REFRESH_SECRET: z.string().min(10, 'Refresh secret too short'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  throw new Error('Invalid environment variables');
}

export const env = _env.data;
