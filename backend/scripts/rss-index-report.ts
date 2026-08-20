/**
 * RSS index verification.
 *
 * Answers the only question that matters about the RSS query set: are the
 * indexes actually being used, or is Postgres quietly reading the table and
 * sorting?
 *
 * The question has teeth here for a specific reason. The eligibility predicate
 * is emitted with LITERAL status and visibility values because `Blog`'s
 * discovery indexes are PARTIAL on exactly that predicate, and Postgres can only
 * prove a partial index applies against constants. Parameterising it — or
 * editing it out of step with `prisma/sql/search_indexes.sql` — disqualifies
 * every one of them silently, and shows up only as latency. This script:
 *
 *   1. checks every index the feeds depend on exists;
 *   2. prints the PLAN for each of the four feed queries;
 *   3. times each one cold and warm;
 *   4. reports which indexes were actually scanned.
 *
 * Probes hit the REPOSITORY, not the service, on purpose: the service is behind
 * a Redis cache, and a warm cache would report microseconds while saying nothing
 * about the database.
 *
 * Run it after any change to `rss.repository.ts`, to `rss.eligibility.ts`, or to
 * the index files those depend on:
 *
 *     DATABASE_URL=<url> npx tsx scripts/rss-index-report.ts
 *
 * On a small table the planner may legitimately prefer a sequential scan — an
 * unused index here is a prompt to check the data volume, not an automatic bug.
 * Seed a realistic corpus before drawing conclusions.
 */
import { prisma } from '../src/core/database/prisma';
import { redis } from '../src/core/providers/redis';
import { rssRepository } from '../src/modules/rss/rss.repository';
import { DEFAULT_ITEM_COUNT, MAX_ITEM_COUNT } from '../src/modules/rss/rss.config';
import type { RssFeedScope } from '../src/modules/rss/rss.types';

/**
 * Indexes the RSS feeds depend on.
 *
 * NONE of them is created by `prisma/sql/rss_indexes.sql` — that file
 * deliberately adds nothing and documents why. Every entry here belongs to
 * another module, which is precisely the reason to list them: each now has one
 * more dependant than its owner may realise.
 */
const EXPECTED_INDEXES = [
  'blog_search_published_idx', // global, category and tag feeds
  'blog_feed_author_public_idx', // author feed
  'BlogTag_tagId_idx', // tag feed's EXISTS subquery
  'BlogCategory_categoryId_idx', // category feed's EXISTS subquery
  'BlogSEO_blogId_key', // the SEO join
  'User_username_key', // author subject resolution
  'Tag_slug_key',
  'Category_slug_key',
];

/** Warm runs timed per probe, after the first (cold) one. */
const WARM_RUNS = 5;

interface IndexStat {
  indexrelname: string;
  idx_scan: bigint;
  size: string;
}

interface Probe {
  label: string;
  scope: RssFeedScope;
  subjectId: string | null;
  limit: number;
}

async function readIndexStats(): Promise<Map<string, IndexStat>> {
  const rows = await prisma.$queryRaw<IndexStat[]>`
    SELECT indexrelname,
           idx_scan,
           pg_size_pretty(pg_relation_size(indexrelid)) AS size
    FROM pg_stat_user_indexes
    WHERE schemaname = 'public'
  `;
  return new Map(rows.map((row) => [row.indexrelname, row]));
}

/**
 * The same, after forcing the counters to be current.
 *
 * `pg_stat_user_indexes` is served from a per-transaction SNAPSHOT, and a
 * backend flushes its own counters to shared memory at most once a second. Read
 * naively straight after the probes, every delta comes back zero and the whole
 * section reports "unused" for indexes the plans above clearly named. Clearing
 * the snapshot and waiting out the flush interval is what makes the numbers
 * mean anything.
 */
async function readIndexStatsFresh(): Promise<Map<string, IndexStat>> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await prisma.$executeRawUnsafe('SELECT pg_stat_clear_snapshot()');
  return readIndexStats();
}

/**
 * Builds one probe per feed type, using REAL subjects drawn from the database.
 *
 * A synthetic id would be perfectly selective and produce a plan nobody will
 * ever run. The author, tag and category chosen are the ones with the most
 * eligible posts, because those are the feeds whose plans are worth knowing —
 * a subject with three posts is fast under any plan at all.
 */
async function buildProbes(): Promise<Probe[]> {
  const probes: Probe[] = [
    { label: 'global feed', scope: 'global', subjectId: null, limit: DEFAULT_ITEM_COUNT },
    {
      label: `global feed (limit=${MAX_ITEM_COUNT})`,
      scope: 'global',
      subjectId: null,
      limit: MAX_ITEM_COUNT,
    },
  ];

  const [author] = await prisma.$queryRaw<{ id: string; username: string; n: number }[]>`
    SELECT u."id", u."username", count(*)::int AS n
    FROM "Blog" b JOIN "User" u ON u."id" = b."authorId"
    WHERE b."status" = 'PUBLISHED' AND b."visibility" = 'PUBLIC' AND u."status" = 'ACTIVE'
    GROUP BY u."id", u."username" ORDER BY n DESC LIMIT 1
  `;
  if (author) {
    probes.push({
      label: `author feed (@${author.username}, ${author.n} posts)`,
      scope: 'author',
      subjectId: author.id,
      limit: DEFAULT_ITEM_COUNT,
    });
  }

  const [tag] = await prisma.$queryRaw<{ id: string; slug: string; n: number }[]>`
    SELECT t."id", t."slug", count(*)::int AS n
    FROM "BlogTag" bt JOIN "Tag" t ON t."id" = bt."tagId"
    JOIN "Blog" b ON b."id" = bt."blogId"
    WHERE b."status" = 'PUBLISHED' AND b."visibility" = 'PUBLIC'
    GROUP BY t."id", t."slug" ORDER BY n DESC LIMIT 1
  `;
  if (tag) {
    probes.push({
      label: `tag feed (#${tag.slug}, ${tag.n} posts)`,
      scope: 'tag',
      subjectId: tag.id,
      limit: DEFAULT_ITEM_COUNT,
    });
  }

  const [category] = await prisma.$queryRaw<{ id: string; slug: string; n: number }[]>`
    SELECT c."id", c."slug", count(*)::int AS n
    FROM "BlogCategory" bc JOIN "Category" c ON c."id" = bc."categoryId"
    JOIN "Blog" b ON b."id" = bc."blogId"
    WHERE b."status" = 'PUBLISHED' AND b."visibility" = 'PUBLIC'
    GROUP BY c."id", c."slug" ORDER BY n DESC LIMIT 1
  `;
  if (category) {
    probes.push({
      label: `category feed (${category.slug}, ${category.n} posts)`,
      scope: 'category',
      subjectId: category.id,
      limit: DEFAULT_ITEM_COUNT,
    });
  }

  return probes;
}

/** The plan for a probe, indented for reading. */
async function explain(probe: Probe): Promise<string> {
  // EXPLAIN over the statement the repository actually builds — not a copy of
  // it, which would drift the first time that file changes.
  const query = rssRepository.buildFeedQuery(probe);
  const rows = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`EXPLAIN ${query}`;
  return rows.map((row) => `      ${row['QUERY PLAN']}`).join('\n');
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

  const [counts] = await prisma.$queryRaw<
    { blogs: number; syndicatable: number; tags: number; categories: number }[]
  >`
    SELECT (SELECT count(*)::int FROM "Blog") AS blogs,
           (SELECT count(*)::int FROM "Blog" b JOIN "User" u ON u."id" = b."authorId"
             WHERE b."status" = 'PUBLISHED' AND b."visibility" = 'PUBLIC'
               AND b."isHidden" = false AND b."publishedAt" IS NOT NULL
               AND u."status" = 'ACTIVE') AS syndicatable,
           (SELECT count(*)::int FROM "BlogTag") AS tags,
           (SELECT count(*)::int FROM "BlogCategory") AS categories
  `;
  console.log(
    `\n== Corpus: ${counts!.blogs} blogs (${counts!.syndicatable} syndicatable), ` +
      `${counts!.tags} tag links, ${counts!.categories} category links ==`
  );

  const probes = await buildProbes();
  const [subjects] = await prisma.$queryRaw<
    { username: string; tag: string; category: string }[]
  >`
    SELECT coalesce((SELECT "username" FROM "User" WHERE "status" = 'ACTIVE' LIMIT 1), '') AS username,
           coalesce((SELECT "slug" FROM "Tag" LIMIT 1), '')      AS tag,
           coalesce((SELECT "slug" FROM "Category" LIMIT 1), '') AS category
  `;

  console.log('\n== Plans ==');
  for (const probe of probes) {
    console.log(`\n  ${probe.label}`);
    try {
      console.log(await explain(probe));
    } catch (err) {
      console.log(`      FAILED: ${(err as Error).message}`);
    }
  }

  console.log('\n== Query latency (cold / median of 5 warm) ==');
  // Both numbers are reported because a single timed run is misleading:
  // straight after a bulk load the heap pages are not in shared buffers and
  // there is no cached plan. The cold number is the first execution; the warm
  // median is what a cache miss on a served request actually costs.
  for (const probe of probes) {
    const samples: number[] = [];
    let rows = 0;

    try {
      for (let run = 0; run < WARM_RUNS + 1; run++) {
        const started = process.hrtime.bigint();
        rows = (await rssRepository.findFeedRows(probe)).length;
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
        `${rows.toString().padStart(4)} rows  ${probe.label}`
    );
  }

  // The subject lookups a scoped feed pays on EVERY request, cache hit
  // included (see rss.service). Timed separately because they are not part of
  // `findFeedRows`, and listed because three of the expected indexes exist only
  // to serve them.
  console.log('\n== Subject resolution ==');
  for (const [label, run] of [
    ['author by username', () => rssRepository.findAuthorByUsername(subjects!.username)],
    ['tag by slug', () => rssRepository.findTagBySlug(subjects!.tag)],
    ['category by slug', () => rssRepository.findCategoryBySlug(subjects!.category)],
  ] as const) {
    const started = process.hrtime.bigint();
    const found = await run();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`  ${ms.toFixed(2).padStart(7)}ms  ${found ? 'found  ' : 'missing'}  ${label}`);
  }

  console.log('\n== Index usage during this run ==');
  const after = await readIndexStatsFresh();
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
    '\n  A `Seq Scan on "Blog"` in any plan above is the failure this script\n' +
      '  exists to catch: it means the partial index could not be proven to\n' +
      '  apply, almost always because the eligibility predicate stopped being\n' +
      '  emitted as literals. See rss.eligibility.ts.\n' +
      '\n' +
      '  A sequential scan of "BlogTag" / "BlogCategory" / "User" is NOT that —\n' +
      '  those are small tables the planner is right to read whole, which is\n' +
      '  also why the unique-key indexes above often report zero scans on a\n' +
      '  seeded corpus. Judge them against a realistic vocabulary, not this one.\n'
  );

  await prisma.$disconnect();
  await redis.quit();
}

main().catch(async (err) => {
  console.error('rss-index-report failed:', err);
  await prisma.$disconnect();
  await redis.quit();
  process.exit(1);
});
