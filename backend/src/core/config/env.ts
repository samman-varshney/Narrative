import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load variables based on NODE_ENV, default to .env
dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().default('5000'),
    DATABASE_URL: z.string().url('Must be a valid Postgres connection string'),
    REDIS_URL: z.string().url('Must be a valid Redis connection string').default('redis://127.0.0.1:6379'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    JWT_ACCESS_SECRET: z.string().min(10, 'Access secret too short'),
    JWT_REFRESH_SECRET: z.string().min(10, 'Refresh secret too short'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

    // Storage / Media
    STORAGE_PROVIDER: z.enum(['local', 'cloudinary']).default('local'),
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),

    // Email / Notifications
    // Defaults to `log` so the notification pipeline runs end to end without a
    // vendor account. Production must opt into a real transport (enforced below).
    EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
    EMAIL_FROM: z.string().default('Narrative <noreply@narrative.local>'),
    RESEND_API_KEY: z.string().optional(),
    /** Absolute base URL used to build links in emails. */
    APP_URL: z.string().default('http://localhost:3000'),

    // ---- Analytics -------------------------------------------------------
    // All optional with defaults: analytics must never be the reason a
    // deployment fails to boot. Every value is an operational knob, not a
    // credential.

    /**
     * How often the flush worker drains Redis buffers into PostgreSQL, in
     * milliseconds. This is also the upper bound on how much data a Redis loss
     * can destroy, and roughly how stale a dashboard can be — ARCHITECTURE.md's
     * risk register asks for 1-2 minutes.
     */
    ANALYTICS_FLUSH_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),

    /**
     * How long one reader's view of one blog is treated as the same view.
     * Refreshing inside this window does not count again. 30 minutes matches
     * the session convention readers are used to elsewhere on the web.
     */
    ANALYTICS_VIEW_DEDUPE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),

    /**
     * Retention for daily aggregate rows. 400 days keeps a full
     * year-over-year comparison available and bounds the table's growth.
     */
    ANALYTICS_DAILY_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(400),

    /**
     * Salt for hashing reader identities before they are used in Redis keys.
     * Analytics identity never reaches PostgreSQL, and with this it does not sit
     * in the Redis keyspace in the clear either. Changing it resets in-flight
     * dedupe windows (readers can be counted once more) and nothing else.
     */
    ANALYTICS_ID_SALT: z.string().min(8).default('narrative-analytics-dev-salt'),
  })
  .superRefine((data, ctx) => {
    // Resend needs a key only when it is the active transport.
    if (data.EMAIL_PROVIDER === 'resend' && !data.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when EMAIL_PROVIDER is "resend"',
      });
    }

    // The log transport writes emails to stdout instead of sending them. Fine
    // everywhere except production, where it would silently swallow every
    // notification email — a failure that looks like success.
    if (data.NODE_ENV === 'production' && data.EMAIL_PROVIDER === 'log') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message:
          'EMAIL_PROVIDER must not be "log" in production — emails would be logged, never sent',
      });
    }

    // The default salt is public — it is in this file. Left in place in
    // production it would make every hashed reader identity reproducible by
    // anyone with the source, which is the whole reason the hash exists. Refused
    // for the same reason EMAIL_PROVIDER=log is: a setting that looks like
    // privacy but provides none is worse than no setting at all.
    if (data.NODE_ENV === 'production' && data.ANALYTICS_ID_SALT === 'narrative-analytics-dev-salt') {
      ctx.addIssue({
        code: 'custom',
        path: ['ANALYTICS_ID_SALT'],
        message: 'ANALYTICS_ID_SALT must be set to a private value in production',
      });
    }

    // Cloudinary credentials are only required when it is the active provider.
    if (data.STORAGE_PROVIDER === 'cloudinary') {
      const required = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const;
      for (const key of required) {
        if (!data[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when STORAGE_PROVIDER is "cloudinary"`,
          });
        }
      }
    }
  });

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  throw new Error('Invalid environment variables');
}

export const env = _env.data;
