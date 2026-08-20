import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import cookieParser from 'cookie-parser';
import { redis } from './core/providers/redis';
import { globalErrorHandler } from './core/middlewares/errorHandler';
import { skipInTests, hasDedicatedLimiter } from './core/middlewares/rateLimiter';
import { logger } from './core/utils/logger';
import { authRoutes } from './modules/auth/auth.routes';
import { userRoutes } from './modules/user/user.routes';
import { followRoutes } from './modules/follow/follow.routes';
import { mediaRoutes } from './modules/media/media.routes';
import { blogRoutes } from './modules/blog/blog.routes';
import { blogCommentRoutes, commentRoutes } from './modules/comment/comment.routes';
import {
  blogBookmarkRoutes,
  userBookmarkRoutes,
} from './modules/bookmark/bookmark.routes';
import { notificationRoutes } from './modules/notification/notification.routes';
import { searchRoutes } from './modules/search/search.routes';

const app: Application = express();

// Middlewares
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request Logger
app.use(pinoHttp({ logger }));

// Rate Limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window`
  standardHeaders: true,
  legacyHeaders: false,
  // Skipped in tests, and skipped for routes that bring their own limiter with a
  // HIGHER budget than this one — currently just /search. See
  // SELF_LIMITED_PATH_PREFIXES for why that exemption is necessary rather than
  // merely convenient.
  skip: (req) => skipInTests() || hasDedicatedLimiter(req),
  store: new RedisStore({
    sendCommand: redis.call.bind(redis) as any,
    prefix: 'rl:global:', // Distinct namespace so it doesn't share counters with authLimiter
  }),
});
app.use('/api', limiter);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Register Module Routes
app.use('/api/v1/auth', authRoutes);
// followRoutes shares the /users mount and MUST be registered before userRoutes:
// its 2-segment paths (/:userId/followers, etc.) are matched here first, while
// userRoutes' single-segment/`/me` routes fall through. This ordering lets the
// public follower/following lists work without userRoutes' requireAuth gating them.
app.use('/api/v1/users', followRoutes);
// Same reasoning for the bookmark library: /me/bookmarks is registered before
// userRoutes so it is matched ahead of that router's `/:username` route.
app.use('/api/v1/users', userBookmarkRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/media', mediaRoutes);
// Blog-scoped bookmark routes share the /blogs mount. Their 2-segment paths
// (/:blogId/bookmark) don't collide with the blog `/:slug` route; mounting
// before blogRoutes keeps the ordering guarantee explicit.
app.use('/api/v1/blogs', blogBookmarkRoutes);
app.use('/api/v1/blogs', blogRoutes);
// Blog-scoped comment routes share the /blogs mount; their 2-segment paths
// (/:blogId/comments) don't collide with the blog `/:slug` route, but mounting
// after blogRoutes keeps intent clear.
app.use('/api/v1/blogs', blogCommentRoutes);
app.use('/api/v1/comments', commentRoutes);
app.use('/api/v1/notifications', notificationRoutes);
// Search owns its own mount and shares no prefix with another router, so no
// ordering constraint applies here.
app.use('/api/v1/search', searchRoutes);

// Global Error Handler
app.use(globalErrorHandler);

export default app;
