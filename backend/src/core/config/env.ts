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

    /**
     * The calendar day analytics buckets by, as a fixed offset from UTC in
     * minutes (IST = 330, JST = 540, US Pacific = -480).
     *
     * A "day" has to mean one thing for a metric to be comparable across a
     * range, and that meaning is fixed at INGEST — a view increments a bucket
     * long before anyone asks who is looking, so per-author timezones cannot
     * work here. What this setting buys is choosing WHICH day boundary the
     * platform uses instead of being stuck with UTC's.
     *
     * That matters more than it sounds. UTC midnight is only a quiet hour for
     * roughly UTC±3: at +9 it falls at 09:00 and cuts the working morning in
     * half, at -8 it falls at 16:00 and splits the evening peak. Set this to the
     * offset of the audience the numbers are for.
     *
     * A fixed OFFSET, deliberately not an IANA zone name. A DST-observing zone
     * produces a 23-hour and a 25-hour day each year, and an ambiguous hour that
     * belongs to two buckets — for a counter whose whole value is
     * comparability, two irregular days a year is a worse defect than a boundary
     * an hour off for part of the year.
     *
     * OPERATIONAL: this is a deploy-once setting. Changing it after data exists
     * does not re-slice history — old rows keep the boundary they were written
     * with, so the days either side of the change are cut differently.
     */
    ANALYTICS_REPORTING_UTC_OFFSET_MINUTES: z.coerce
      .number()
      .int()
      .min(-840)
      .max(840)
      .default(0),

    // ---- RSS & Distribution ---------------------------------------------

    /**
     * Absolute, publicly reachable base URL of the RSS endpoints.
     *
     * RSS documents carry their OWN address in `<atom:link rel="self">`, and a
     * feed reader stores that address rather than the one it was handed — so
     * getting it wrong sends every subscriber to a URL that may not resolve.
     * It cannot be derived from the request: `Host` and `X-Forwarded-*` are
     * attacker-controlled on a public endpoint, and a cached document built
     * from a spoofed header would then be served to everyone else.
     *
     * Optional because the common deployment serves the API and the app from
     * one origin, where `${APP_URL}/api/v1/rss` is already correct. Set it when
     * the API lives somewhere else (api.example.com, a path-rewriting proxy).
     */
    RSS_SELF_BASE_URL: z.url('Must be a valid absolute URL').optional(),

    // ---- SEO & Public Metadata -------------------------------------------
    // Only the values that genuinely differ between deployments are here. The
    // sitemap's chunk size, its TTLs and the robots ruleset are product
    // decisions and live in `modules/seo/seo.config.ts`, for the same reason
    // `rss.config.ts` holds its own constants: a setting that should be
    // identical in dev and production is not configuration, it is a value with
    // a longer name.

    /**
     * The platform's name, as it appears in `og:site_name`, the `WebSite`
     * structured-data node and every title suffix.
     *
     * Configurable because a white-labelled or differently-branded deployment
     * changes it, and because the alternative — the string `Narrative`
     * hard-coded across a metadata resolver, a serializer and a robots file —
     * is the kind of duplication that is only ever half-updated.
     */
    SEO_SITE_NAME: z.string().min(1).default('Narrative'),

    /**
     * Metadata for the pages that describe no single resource — the home page,
     * and the last-resort fallback when a resource supplies nothing usable.
     *
     * The description is capped at the length search engines actually render.
     * A longer one is not an error, it is simply truncated by the consumer, so
     * the bound is advisory here and enforced in `seo.resolver`.
     */
    SEO_DEFAULT_TITLE: z.string().min(1).default('Narrative'),
    SEO_DEFAULT_DESCRIPTION: z
      .string()
      .min(1)
      .default('Narrative is a place to write, publish and read long-form writing.'),

    /**
     * Absolute URL of the fallback social preview image.
     *
     * Optional, and the module is careful to stay valid without it: a missing
     * `og:image` costs a preview card its picture, while a BROKEN one — a
     * relative path, a `data:` URI, an internal storage path — is worse than
     * none, because it is published to every consumer that renders a link. It
     * is validated as an absolute URL here and scheme-checked again at use.
     */
    SEO_DEFAULT_IMAGE: z.url('Must be a valid absolute URL').optional(),

    /**
     * The platform's own Twitter/X handle, for `twitter:site`.
     *
     * Optional because most deployments do not have one, and a card is
     * perfectly valid without it. The leading `@` is required so the value is
     * unambiguous — X treats `@narrative` and `narrative` as the same account,
     * but the tag is specified with the `@`.
     */
    SEO_TWITTER_SITE: z
      .string()
      .regex(/^@[A-Za-z0-9_]{1,15}$/, 'Must be an @handle, e.g. @narrative')
      .optional(),

    /**
     * Whether crawlers may index this deployment at all.
     *
     * The one switch in the module with real consequences, and the reason it is
     * environment configuration rather than a constant: a staging or preview
     * deployment serves the same public content as production, and if it is
     * indexed it competes with production for the same queries — the classic
     * way a staging URL ends up outranking the real site.
     *
     * Left unset it defaults to "only in production" (resolved in
     * `seo.config.ts`), which is the safe reading of an ambiguous environment.
     * When off, every page resolves to `noindex, nofollow` and `robots.txt`
     * disallows everything — the metadata layer and the crawler directive move
     * together, so a deployment cannot be half-indexable.
     */
    SEO_INDEXING_ENABLED: z.enum(['true', 'false']).optional(),

    /**
     * Absolute, publicly reachable base URL of the sitemap and `robots.txt`
     * endpoints.
     *
     * Exists for the same reason `RSS_SELF_BASE_URL` does, and matters more: a
     * sitemap index names its child sitemaps by absolute URL, and `robots.txt`
     * names the sitemap by absolute URL. Both must be fetchable by a crawler
     * that has never seen this API, and neither can be derived from a request
     * header without letting a spoofed `Host` redirect crawlers off-site.
     *
     * Optional because the common deployment proxies `/robots.txt` and
     * `/sitemap*.xml` to the API under the app's own origin, where `APP_URL` is
     * already correct.
     */
    SEO_SITEMAP_BASE_URL: z.url('Must be a valid absolute URL').optional(),
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
