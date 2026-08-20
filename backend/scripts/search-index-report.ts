/**
 * Search index verification.
 *
 * Answers the only question that matters about a search index set: are the
 * indexes actually being used, or is Postgres quietly sequential-scanning?
 *
 * A `CREATE INDEX` that succeeded proves nothing — an expression index that no
 * longer matches the query text, a partial index whose predicate was
 * parameterised, or a planner that has decided a seq scan is cheaper all fail
 * silently and show up only as latency. This script:
 *
 *   1. checks every expected index exists;
 *   2. snapshots `pg_stat_user_indexes.idx_scan`;
 *   3. runs a representative set of searches through the real engine;
 *   4. re-reads the counters and reports which indexes were touched, and how
 *      long each query took.
 *
 * Run it after any change to the ranking SQL or to prisma/sql/search_indexes.sql:
 *
 *     DATABASE_URL=<url> npx tsx scripts/search-index-report.ts
 *
 * Note that on a small table the planner may legitimately prefer a sequential
 * scan — an unused index here is a prompt to check the data volume, not an
 * automatic bug. Seed a realistic corpus before drawing conclusions.
 */
import { prisma } from '../src/core/database/prisma';
import { redis } from '../src/core/providers/redis';
import { postgresSearchEngine } from '../src/modules/search/engines/PostgresSearchEngine';
import { normalizeQuery } from '../src/modules/search/search.query';

/** Every index prisma/sql/search_indexes.sql is expected to create. */
const EXPECTED_INDEXES = [
  'blog_search_fts_idx',
  'blog_search_title_trgm_idx',
  'blog_search_title_lower_idx',
  'blog_search_published_idx',
  'user_search_username_trgm_idx',
  'user_search_name_trgm_idx',
  'user_search_username_lower_idx',
  'user_search_name_lower_idx',
  'tag_search_name_trgm_idx',
  'tag_search_name_lower_idx',
  'category_search_name_trgm_idx',
  'category_search_name_lower_idx',
];

/** Queries chosen to exercise every candidate source at least once. */
const PROBES: { label: string; run: () => Promise<{ items: unknown[] }> }[] = [
  {
    label: 'blogs: common term (full-text + prefix)',
    run: () =>
      postgresSearchEngine.searchBlogs(
        normalizeQuery('javascript'),
        { limit: 20, sort: 'relevance' },
        {}
      ),
  },
  {
    label: 'blogs: multi-word phrase',
    run: () =>
      postgresSearchEngine.searchBlogs(
        normalizeQuery('react hooks'),
        { limit: 20, sort: 'relevance' },
        {}
      ),
  },
  {
    label: 'blogs: typo (gated trigram fallback)',
    run: () =>
      postgresSearchEngine.searchBlogs(
        normalizeQuery('javascrpt'),
        { limit: 20, sort: 'relevance' },
        {}
      ),
  },
  {
    label: 'blogs: short prefix (B-tree only)',
    run: () =>
      postgresSearchEngine.searchBlogs(
        normalizeQuery('ja'),
        { limit: 20, sort: 'relevance' },
        {}
      ),
  },
  {
    label: 'blogs: no match at all',
    run: () =>
      postgresSearchEngine.searchBlogs(
        normalizeQuery('zzzznothingmatchesthis'),
        { limit: 20, sort: 'relevance' },
        {}
      ),
  },
  {
    label: 'blogs: sort=newest',
    run: () =>
      postgresSearchEngine.searchBlogs(
        normalizeQuery('javascript'),
        { limit: 20, sort: 'newest' },
        {}
      ),
  },
  {
    label: 'blogs: filtered by author',
    run: () =>
      postgresSearchEngine.searchBlogs(
        normalizeQuery('javascript'),
        { limit: 20, sort: 'relevance' },
        { author: 'gracehopper' }
      ),
  },
  {
    label: 'users',
    run: () =>
      postgresSearchEngine.searchUsers(normalizeQuery('grace'), { limit: 20, sort: 'relevance' }),
  },
  {
    label: 'tags',
    run: () =>
      postgresSearchEngine.searchTags(normalizeQuery('java'), { limit: 20, sort: 'relevance' }),
  },
  {
    label: 'categories',
    run: () =>
      postgresSearchEngine.searchCategories(normalizeQuery('front'), {
        limit: 20,
        sort: 'relevance',
      }),
  },
  {
    label: 'suggestions',
    run: async () => ({ items: await postgresSearchEngine.suggest(normalizeQuery('jav'), 10) }),
  },
];

/** Warm runs timed per probe, after the first (cold) one. */
const WARM_RUNS = 5;

interface IndexStat {
  indexrelname: string;
  idx_scan: bigint;
  size: string;
}

async function readIndexStats(): Promise<Map<string, IndexStat>> {
  // Index counters live in the cumulative statistics system, which each backend
  // flushes lazily (and at most every ~1s). Reading them straight after the
  // probes would report zero scans for indexes that were demonstrably used.
  // pg_stat_force_next_flush() forces this backend's pending stats out first.
  await prisma.$executeRawUnsafe('SELECT pg_stat_force_next_flush()').catch(() => {
    // PG < 15: fall back to whatever has flushed on its own.
  });

  const rows = await prisma.$queryRaw<IndexStat[]>`
    SELECT s.indexrelname,
           s.idx_scan,
           pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
    FROM pg_stat_user_indexes s
    WHERE s.indexrelname LIKE '%_search_%'
  `;
  return new Map(rows.map((row) => [row.indexrelname, row]));
}

async function main() {
  console.log('\n== Index presence ==');
  const before = await readIndexStats();
  let missing = 0;
  for (const name of EXPECTED_INDEXES) {
    const present = before.has(name);
    if (!present) missing++;
    console.log(`  ${present ? 'ok     ' : 'MISSING'}  ${name}`);
  }
  if (missing > 0) {
    console.log(`\n  ${missing} index(es) missing — run: npm run db:indexes`);
  }

  const [{ blogs, users, tags }] = await prisma.$queryRaw<
    { blogs: number; users: number; tags: number }[]
  >`
    SELECT (SELECT count(*)::int FROM "Blog")  AS blogs,
           (SELECT count(*)::int FROM "User")  AS users,
           (SELECT count(*)::int FROM "Tag")   AS tags
  `;
  console.log(`\n== Corpus: ${blogs} blogs, ${users} users, ${tags} tags ==`);

  console.log('\n== Query latency (cold / median of 5 warm) ==');
  // Every probe is run REPEATEDLY and both numbers are reported.
  //
  // A single timed run is actively misleading: straight after a bulk load the
  // relevant heap pages are not in shared buffers and Postgres has no cached
  // plan, which inflated an early version of this report by 25x and looked
  // exactly like a scaling defect. The cold number is the first execution; the
  // warm median is what a served request actually costs.
  for (const probe of PROBES) {
    const samples: number[] = [];
    let count = 0;

    try {
      for (let run = 0; run < WARM_RUNS + 1; run++) {
        const started = process.hrtime.bigint();
        count = (await probe.run()).items.length;
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
    } catch (err) {
      console.log(`  FAILED  ${probe.label}: ${(err as Error).message}`);
      continue;
    }

    const cold = samples[0]!;
    const warm = [...samples.slice(1)].sort((a, b) => a - b);
    const median = warm[Math.floor(warm.length / 2)]!;

    console.log(
      `  ${cold.toFixed(1).padStart(7)} / ${median.toFixed(1).padStart(6)}ms  ` +
        `${count.toString().padStart(3)} hits  ${probe.label}`
    );
  }

  console.log('\n== Index usage during this run ==');
  const after = await readIndexStats();
  for (const name of EXPECTED_INDEXES) {
    const start = Number(before.get(name)?.idx_scan ?? 0);
    const end = Number(after.get(name)?.idx_scan ?? 0);
    const delta = end - start;
    const size = after.get(name)?.size ?? '-';
    console.log(
      `  ${delta > 0 ? 'used ' : '  -  '}  ${String(delta).padStart(4)} scans  ${size.padStart(8)}  ${name}`
    );
  }
  console.log(
    '\n  An unused index on a small table is usually the planner making the right\n' +
      '  call, not a bug. Re-check against a realistic corpus before removing one.\n'
  );

  await prisma.$disconnect();
  await redis.quit();
}

main().catch(async (err) => {
  console.error('search-index-report failed:', err);
  await prisma.$disconnect();
  await redis.quit();
  process.exit(1);
});
