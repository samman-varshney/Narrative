// Provisions the test database once per suite run.
//
// `db push --force-reset` drops and recreates the public schema, so this must
// only ever point at the local test database. jest.setup.js enforces that for
// the test processes; we re-check here because this file runs in its own
// process, before any of them.
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '.env'), quiet: true });

module.exports = async () => {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set — refusing to provision a test schema.');
  }
  if (/neon\.tech|amazonaws|\.render\.com|supabase/i.test(url)) {
    throw new Error('TEST_DATABASE_URL points at a hosted database — refusing to --force-reset it.');
  }

  // `--url` targets the test database explicitly rather than relying on env
  // precedence, so this can never be redirected by a stray DATABASE_URL.
  //
  // Prisma gates `--force-reset` behind a consent token when it detects an AI
  // agent invoked it. It is read from .env (gitignored) rather than hardcoded,
  // so consent stays a local opt-in. Human-run `npm test` is unaffected either way.
  execSync(`npx prisma db push --force-reset --url "${url}"`, {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'inherit'], // quiet on success, loud on failure
  });
};
