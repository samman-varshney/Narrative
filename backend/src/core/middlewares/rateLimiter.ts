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
 * The administrative surface is here for a third reason, and an operational one
 * rather than a UX one. Working a report takes about four requests (open the
 * queue, open the report, claim it, act on it), so the global budget of 100 per
 * 15 minutes runs out after roughly twenty-five reports — which is fine on a
 * quiet day and precisely wrong during a spam wave, when the moderation team is
 * the thing that must not stop. `adminLimiter` replaces it with a budget sized
 * for a backlog, and every one of those endpoints is permission-gated anyway.
 *
 * The RSS endpoints are here for the same inversion as search and feed, arriving
 * from a different direction. A feed reader polls on a timer and an AGGREGATOR
 * — Feedly, Inoreader, a company's internal reader — polls on behalf of many
 * subscribers from a handful of addresses. Under the global budget of 100 per 15
 * minutes, under seven requests a minute, a perfectly well-behaved aggregator
 * following a few dozen authors would be cut off while doing exactly what the
 * format is for. `rssLimiter` replaces it with a budget sized for that, and the
 * requests it admits are overwhelmingly conditional ones the origin answers with
 * a 304 out of Redis.
 *
 * The SEO metadata endpoints are here for the same reason as `/feed`, arriving
 * from the rendering side. A server-side renderer asks for a page's metadata
 * once per page it renders, so a reader browsing a dozen posts produces a dozen
 * requests on top of everything else the app does — and under the global budget
 * of under seven a minute, that is a site that stops rendering titles. The
 * crawler routes (`/robots.txt`, `/sitemap*.xml`) are NOT listed here because
 * they are not under `/api` at all and the global limiter never saw them;
 * `seoLimiter` is applied to them directly by the SEO router.
 *
 * `originalUrl` rather than `path`: Express strips the mount prefix from
 * `req.url` inside a `app.use('/api', ...)` middleware, so `req.path` would read
 * `/v1/search/...` here and the check would be quietly mount-dependent.
 */
export const SELF_LIMITED_PATH_PREFIXES = [
  '/api/v1/search',
  '/api/v1/feed',
  '/api/v1/admin',
  '/api/v1/rss',
  '/api/v1/seo',
];

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

/**
 * Dedicated limiter for filing reports.
 *
 * Reporting is the one write on the platform whose ABUSE is aimed at other
 * users rather than at the server: a script filing hundreds of reports against
 * one author buries the queue and, in a naive system, gets that author actioned
 * by weight of numbers. The queue is not naive — reports are requests for review
 * and never hide anything by themselves — but a flooded queue still costs
 * moderators the time they would have spent on real abuse.
 *
 * 20 an hour is far above genuine use (reporting is a rare act; a normal reader
 * files a handful a year) and far below what makes flooding worthwhile. The
 * duplicate guards handle repeat reports of the SAME target; this bounds the
 * total across different ones.
 *
 * An hour-long window rather than a minute, deliberately: a per-minute cap is
 * trivially evaded by a script that sleeps, and the thing being bounded here is
 * volume over a session, not burstiness.
 */
export const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many reports from this IP, please try again later',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:report:', // Distinct namespace for report counters
  }),
});

/**
 * Dedicated limiter for blog CREATION.
 *
 * Creation only — not updates or autosaves, which a single writing session
 * fires constantly and which create nothing new. What this bounds is the
 * spammer's actual mechanism: minting posts in bulk to seed links across the
 * discovery surfaces.
 *
 * 20 an hour is more than any human writes and few enough that a link farm is
 * not worth building here. Drafts are included: a draft is invisible, but it is
 * one publish away from not being.
 */
export const blogCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many blogs created from this IP, please try again later',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:blog:', // Distinct namespace for blog-creation counters
  }),
});

/**
 * Dedicated limiter for profile mutations.
 *
 * The abuse it bounds is impersonation churn: renaming and re-avataring an
 * account repeatedly to evade recognition, or cycling a display name through
 * abusive strings that appear in everyone's notifications. Profile fields are
 * denormalized into cached feed and search results too, so each change also
 * invalidates work across the platform.
 *
 * 30 per 15 minutes leaves ordinary editing (and the fiddling that follows a
 * new avatar) completely untouched.
 */
export const profileWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many profile updates from this IP, please slow down',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:profile:', // Distinct namespace for profile-write counters
  }),
});

/**
 * Dedicated limiter for the administrative surface.
 *
 * This is NOT an abuse control — every route behind it requires a permission,
 * so an attacker without one is refused before doing any work. It is a backstop
 * against a runaway admin client, and its budget is set by what a human
 * moderator clearing a backlog actually needs.
 *
 * 600 per 15 minutes is roughly 150 reports handled in a quarter of an hour,
 * which is faster than anyone reviews content and far more headroom than a
 * shared office egress IP will use. See SELF_LIMITED_PATH_PREFIXES above for
 * why the global limiter had to be replaced here rather than layered under.
 */
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many administrative requests from this IP, please slow down',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:admin:', // Distinct namespace for administrative counters
  }),
});

/**
 * Dedicated limiter for data-export REQUESTS.
 *
 * The real control is the per-account cooldown in `exportService` — one export
 * per 24 hours, enforced against the database and therefore immune to changing
 * IP. This is the cheap outer layer that stops a script burning CPU on the
 * cooldown check itself, and it is deliberately per-IP-loose (10/hour) rather
 * than tight: several people behind one office NAT must each still be able to
 * ask for their own data.
 *
 * Downloads are NOT limited here. Re-downloading an artifact you already own is
 * a byte transfer, not a build, and someone whose download failed halfway should
 * not be told to wait.
 */
export const exportRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many export requests from this IP, please try again later',
    },
  },
  skip: skipInTests,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:export:', // Distinct namespace for export counters
  }),
});


/**
 * A 429 for the RSS endpoints, as XML.
 *
 * A literal rather than an import: `core/` must not depend on `modules/`, and
 * this is the one place a core middleware has to know what an RSS response
 * looks like. Kept to the shape `rss.errors.ts` renders, so a client sees one
 * error format from the module whether the refusal came from the limiter or
 * from the feed itself.
 */
const RSS_RATE_LIMIT_DOCUMENT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<error>',
  '  <code>TOO_MANY_REQUESTS</code>',
  '  <message>Too many feed requests from this IP, please poll less often</message>',
  '</error>',
  '',
].join('\n');

/**
 * Dedicated limiter for the RSS endpoints.
 *
 * RSS is the platform's most crawlable surface — public, unauthenticated, and
 * designed to be fetched on a schedule forever — so it needs a limit of its own
 * rather than sharing the global one. What that limit has to balance is unusual:
 * the legitimate traffic is machines, and the abusive traffic is also machines.
 *
 * 60 a minute is the balance, and it is generous on purpose. The endpoints
 * advertise a `<ttl>` of five minutes and answer a conditional request with a
 * 304 out of Redis, so a well-behaved reader costs almost nothing and never
 * approaches this. An aggregator polling on behalf of thousands of subscribers
 * across many feeds has ample headroom, as does a shared NAT.
 *
 * The reason a high limit is safe here — and would not be on `/feed` — is that
 * RSS has NO pagination. `MAX_ITEM_COUNT` caps a feed at 50 items and there is
 * no cursor, so however many times a scraper asks, it can only ever see the
 * newest 50 posts of each feed. Enumerating the corpus through this surface is
 * not slow, it is impossible; the limiter is protecting the database from
 * pathological polling, not the content from extraction.
 *
 * This is the ONLY limit on these paths — see SELF_LIMITED_PATH_PREFIXES above.
 */
export const rssLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  // A custom handler rather than `message`, because express-rate-limit would
  // send the default JSON/HTML body — and an RSS endpoint that answers a feed
  // reader with a JSON envelope has changed media type mid-conversation.
  // `Retry-After` is set explicitly: it is the one header a polling client can
  // actually act on, and it is what turns a refusal into a backoff.
  handler: (_req, res) => {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '60');
    res.status(429).send(RSS_RATE_LIMIT_DOCUMENT);
  },
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:rss:', // Distinct namespace for syndication counters
  }),
});

/**
 * Dedicated limiter for the SEO module — the metadata API and the crawler
 * documents alike.
 *
 * One limiter for both, because the two workloads are the same shape: automated
 * clients fetching public, cacheable documents on a schedule. What differs is
 * only who the automation belongs to — a server-side renderer on one side, a
 * search engine on the other — and neither benefits from having its own budget.
 *
 * 120 a minute is generous on purpose, and safe for the same reason the RSS
 * limit is: none of these endpoints exposes anything unbounded. Metadata is one
 * resource per request, a sitemap chunk is capped at `SITEMAP_URLS_PER_CHUNK`
 * and a section at `SITEMAP_MAX_CHUNKS`, and every response is served from
 * Redis and answered with a 304 on revalidation. The limiter is protecting the
 * database from pathological polling, not the content from extraction — the
 * content is, by definition, what the platform is asking crawlers to take.
 *
 * A plain 429 with the default body: unlike the RSS endpoints, these have no
 * single media type to preserve (JSON, XML and plain text all appear here), and
 * a crawler acts on the status code and `Retry-After` rather than the body.
 */
export const seoLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  handler: (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '60');
    res.status(429).json({
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many metadata requests from this IP, please slow down',
      },
    });
  },
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
    prefix: 'rl:seo:', // Distinct namespace for metadata and crawler counters
  }),
});
