// Loads the real .env, then FORCES the test-only datasource. Runs via
// `setupFiles`, i.e. before any module (and before env.ts's own dotenv.config,
// which does not override already-set vars) — so this is the authoritative
// source of DATABASE_URL for the whole suite.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env'), quiet: true });

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_access_secret_0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_0123456789';

const testDbUrl = process.env.TEST_DATABASE_URL;

// Safety rail: integration tests truncate tables. Refuse to run against a
// database that is missing, remote, or obviously the real one. Losing the dev
// data to a mis-set env var must be impossible, not merely unlikely.
if (!testDbUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Tests truncate tables and must never run ' +
      'against the development database. Add TEST_DATABASE_URL to .env.'
  );
}
if (/neon\.tech|amazonaws|\.render\.com|supabase/i.test(testDbUrl)) {
  throw new Error(
    `TEST_DATABASE_URL points at a hosted database (${testDbUrl.replace(/:[^:@]+@/, ':****@')}). ` +
      'Refusing to run a truncating test suite against it.'
  );
}

process.env.DATABASE_URL = testDbUrl;

// Same Redis instance as dev, but a separate logical DB so the suite cannot
// clobber dev queue jobs or rate-limit counters.
const baseRedis = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.REDIS_URL = `${baseRedis.replace(/\/\d+$/, '')}/1`;
