// Guarantees the env schema (core/config/env.ts) validates during tests without
// depending on a real .env. Real values (if present) win via the `||` fallback.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_access_secret_0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_0123456789';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'prisma+postgres://localhost:51213/?api_key=test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
