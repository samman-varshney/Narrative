/**
 * Applies the raw-SQL database objects that Prisma's schema language cannot
 * express — partial indexes, GIN/trigram indexes, expression indexes over
 * `to_tsvector`, and extension installs.
 *
 * `prisma db push` silently ignores these, so they must be applied separately —
 * on every environment, or production runs a different index set than dev.
 * Every statement is idempotent (`IF NOT EXISTS`), so this is safe to re-run.
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/core/database/prisma';

const SQL_DIR = path.resolve(__dirname, '../prisma/sql');

/**
 * Splits a file into individual statements.
 *
 * Necessary because the driver sends each `$executeRawUnsafe` through the
 * extended query protocol, which permits exactly ONE command per message — a
 * multi-statement file fails with "cannot insert multiple commands into a
 * prepared statement". Splitting is safe here because these files contain only
 * DDL: no functions, no dollar-quoted bodies, and no semicolons inside string
 * literals. Line comments are stripped first so a `;` inside one cannot split a
 * statement in half.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    const statements = splitStatements(sql);

    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }

    console.log(`applied ${file} (${statements.length} statement(s))`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Failed to apply raw indexes:', err);
  await prisma.$disconnect();
  process.exit(1);
});
