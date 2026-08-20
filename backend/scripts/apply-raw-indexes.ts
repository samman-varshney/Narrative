/**
 * Applies the raw-SQL indexes that Prisma's schema language cannot express
 * (currently the partial index behind the unread-notification count).
 *
 * `prisma db push` silently ignores these, so they must be applied separately —
 * on every environment, or production runs a different index set than dev.
 * Every statement is idempotent (`IF NOT EXISTS`), so this is safe to re-run.
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/core/database/prisma';

const SQL_DIR = path.resolve(__dirname, '../prisma/sql');

async function main() {
  const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    await prisma.$executeRawUnsafe(sql);
    console.log(`applied ${file}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Failed to apply raw indexes:', err);
  await prisma.$disconnect();
  process.exit(1);
});
