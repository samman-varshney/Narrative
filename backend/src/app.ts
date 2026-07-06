import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import cookieParser from 'cookie-parser';
import { redis } from './core/providers/redis';
import { globalErrorHandler } from './core/middlewares/errorHandler';
import { logger } from './core/utils/logger';
import { authRoutes } from './modules/auth/auth.routes';
import { userRoutes } from './modules/user/user.routes';

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
app.use('/api/v1/users', userRoutes);

// Global Error Handler
app.use(globalErrorHandler);

export default app;
