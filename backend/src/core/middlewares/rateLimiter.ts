import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from '../providers/redis';
import { env } from '../config/env';

/**
 * Rate limiting is bypassed under `NODE_ENV=test`. Counters live in a real Redis
 * keyed by IP, so without this every integration test in the suite shares one
 * budget and the whole run starts 429-ing once it grows past the window — making
 * results depend on how recently the suite last ran. No test asserts limiting
 * behaviour; it is exercised in development and production only.
 */
export const skipInTests = () => env.NODE_ENV === 'test';

// Dedicated rate limiter for sensitive authentication endpoints (e.g., login, forgot-password)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs for these specific routes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many authentication attempts from this IP, please try again after 15 minutes',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:auth:', // Distinct namespace so login attempts don't share the global counter
  }),
});

// Dedicated limiter for comment writes (create/reply) to curb spam and deep-nesting
// abuse. Stricter than the global /api limiter, looser than auth. Reads are not limited
// here (they inherit the global limiter).
export const commentWriteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15, // Limit each IP to 15 comment writes per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many comments from this IP, please slow down and try again shortly',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:comment:', // Distinct namespace for comment-write counters
  }),
});

// Dedicated limiter for bookmark writes (add/remove/toggle). Bookmarking is a
// cheap, high-frequency action — a reader may save a dozen posts in a burst — so
// this is looser than comments, and exists mainly to stop toggle-spam from
// hammering the unique index. Reads inherit the global /api limiter.
export const bookmarkWriteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 bookmark writes per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many bookmark actions from this IP, please slow down and try again shortly',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:bookmark:', // Distinct namespace for bookmark-write counters
  }),
});

/**
 * Paths that carry their OWN limiter and are therefore exempt from the global
 * `/api` one in app.ts.
 *
 * This exists for search alone, and only because search inverts the usual
 * relationship. Auth, comment and bookmark writes are all STRICTER than the
 * global limiter, so the global one is a harmless backstop underneath them.
 * Search is the opposite: it is a high-frequency READ that a typeahead box fires
 * on a debounce, so its budget has to be higher than general API browsing.
 *
 * Left under the global limiter, search would be capped at 100 requests per 15
 * minutes — under 7 per minute — which breaks typeahead outright and means
 * `searchLimiter` below could never fire at all. Exempting the path makes
 * `searchLimiter` the single, real limit on these endpoints.
 *
 * `originalUrl` rather than `path`: Express strips the mount prefix from
 * `req.url` inside a `app.use('/api', ...)` middleware, so `req.path` would read
 * `/v1/search/...` here and the check would be quietly mount-dependent.
 */
export const SELF_LIMITED_PATH_PREFIXES = ['/api/v1/search'];

export const hasDedicatedLimiter = (req: { originalUrl?: string }): boolean =>
  SELF_LIMITED_PATH_PREFIXES.some((prefix) => (req.originalUrl ?? '').startsWith(prefix));

// Dedicated limiter for the search endpoints. Search is the most expensive read
// on the platform — every request ranks a candidate set across several indexes,
// and the moment filters or a cursor enter the picture the Redis cache stops
// absorbing repeats. It is also the natural tool for scraping the blog corpus
// one page at a time.
//
// 60/minute is the balance: generous enough for a debounced typeahead (a user
// typing "javascript" fires a handful of suggestion requests in a few seconds),
// tight enough that paging the whole corpus is impractical — especially given
// the top-K depth cap already bounds how far any single query can be walked.
//
// This is the ONLY limit on these paths — see SELF_LIMITED_PATH_PREFIXES above.
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 search requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many search requests from this IP, please slow down and try again shortly',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:search:', // Distinct namespace for search counters
  }),
});
