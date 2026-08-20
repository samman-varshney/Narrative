/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    // Transpile-only (isolatedModules is set in tsconfig.json). Tests run without a
    // full type-check pass, so a strict type nit in a test file never blocks the
    // suite. `npm run typecheck` still type-checks everything (tests included).
    '^.+\\.ts$': ['ts-jest', {}],
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Serial by necessity: the *.db.test.ts suites truncate a single shared test
  // database, so parallel workers would wipe each other's fixtures mid-test.
  // The alternative (a database per JEST_WORKER_ID) buys parallelism the suite
  // is far too small to need — it runs in seconds against local Postgres.
  maxWorkers: 1,
  // Provisions the local test schema once per run (prisma db push --force-reset).
  globalSetup: '<rootDir>/jest.globalSetup.js',
  clearMocks: true,
  // The app opens a long-lived Redis (ioredis) connection at import time, which
  // keeps the event loop alive after the suite finishes. Force a clean exit until
  // a dedicated test bootstrap tears that connection down.
  forceExit: true,
};
