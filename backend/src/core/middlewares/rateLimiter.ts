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
 * The feed endpoints are here for the same inversion. An infinite scroll issues
 * a request per screenful across four feeds, and a reader opening the app,
 * scrolling a page and switching tabs can pass 100 requests in a single session
 * — so the global limiter would cut off ordinary browsing of the platform's
 * primary surface. `feedLimiter` replaces it with a budget sized for scrolling.
 *
 * `originalUrl` rather than `path`: Express strips the mount prefix from
 * `req.url` inside a `app.use('/api', ...)` middleware, so `req.path` would read
 * `/v1/search/...` here and the check would be quietly mount-dependent.
 */
export const SELF_LIMITED_PATH_PREFIXES = ['/api/v1/search', '/api/v1/feed'];

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

/**
 * Dedicated limiter for the feed endpoints.
 *
 * Feeds are the platform's highest-frequency read: an infinite scroll fires a
 * request per screenful, and a session touches several feeds. They are also the
 * natural way to enumerate the whole published corpus one page at a time, which
 * is the abuse this bounds.
 *
 * 120/minute is the balance. A human scrolling continuously produces perhaps
 * one request every second or two, so this is generous headroom for real use
 * (and for a shared NAT), while a scraper walking 50-item pages is held to
 * 6 000 posts a minute — slow enough that the ranked feeds' depth cap and the
 * chronological feeds' cursor cost make bulk extraction unattractive.
 *
 * This is the ONLY limit on these paths — see SELF_LIMITED_PATH_PREFIXES above.
 */
export const feedLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many feed requests from this IP, please slow down and try again shortly',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:feed:', // Distinct namespace for feed counters
  }),
});

/**
 * Dedicated limiter for the analytics reading-telemetry endpoint.
 *
 * This is the platform's only UNAUTHENTICATED write surface, so it needs a limit
 * of its own rather than sharing the global one. The threat is not load — the
 * handler does a cached metadata read and a couple of Redis ops — it is
 * FABRICATION: without a cap, a script could post reading sessions in a loop and
 * inflate an author's completion rate and average read time. The ingestion
 * layer's own guards (a completion must consume a real session, and reads per
 * reader per blog per window are capped) already make that expensive; this makes
 * it slow as well.
 *
 * 30/minute is comfortably above real usage. A reader generates exactly two
 * events per post — one start, one completion — so this is fifteen posts a
 * minute from one address, while a shared NAT or an office egress IP still has
 * ample headroom.
 */
export const analyticsIngestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many analytics events from this IP, please slow down and try again shortly',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:analytics:', // Distinct namespace for telemetry counters
  }),
});
