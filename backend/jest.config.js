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
  clearMocks: true,
  // The app opens a long-lived Redis (ioredis) connection at import time, which
  // keeps the event loop alive after the suite finishes. Force a clean exit until
  // a dedicated test bootstrap tears that connection down.
  forceExit: true,
};
