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
