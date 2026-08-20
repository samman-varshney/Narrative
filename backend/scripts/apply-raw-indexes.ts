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
 * prepared statement".
 *
 * Line comments are stripped first so a `;` inside one cannot split a statement
 * in half, and DOLLAR-QUOTED bodies are tracked so the semicolons inside a
 * `CREATE FUNCTION ... $$ ... $$` body do not either. The moderation audit log's
 * append-only trigger is the first file here to need that; before it, every
 * statement in this directory was a bare `CREATE INDEX`.
 *
 * Still not a SQL parser: semicolons inside ordinary string literals would
 * split wrongly. No file here has one, and the alternative — a real parser, or
 * shelling out to psql — is a lot of machinery for a directory of DDL.
 */
function splitStatements(sql: string): string[] {
  const source = sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');

  // Sticky so it can be tested at a position without slicing the string.
  const dollarQuote = /\$[A-Za-z_]*\$/y;

  const statements: string[] = [];
  let current = '';
  let openTag: string | null = null;

  for (let i = 0; i < source.length; i++) {
    if (openTag) {
      if (source.startsWith(openTag, i)) {
        current += openTag;
        i += openTag.length - 1;
        openTag = null;
        continue;
      }
    } else {
      dollarQuote.lastIndex = i;
      const opened = dollarQuote.exec(source);
      if (opened) {
        openTag = opened[0];
        current += openTag;
        i += openTag.length - 1;
        continue;
      }
      if (source[i] === ';') {
        statements.push(current.trim());
        current = '';
        continue;
      }
    }
    current += source[i];
  }

  statements.push(current.trim());
  return statements.filter(Boolean);
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
