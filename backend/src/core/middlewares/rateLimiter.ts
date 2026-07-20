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
