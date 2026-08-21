/**
 * SEO index verification.
 *
 * Answers the only question that matters about the SEO query set: are the
 * indexes actually being used, or is Postgres quietly reading the table and
 * sorting?
 *
 * The question has teeth here for two reasons. The eligibility predicate is
 * emitted with LITERAL status and visibility values because `Blog`'s discovery
 * indexes are PARTIAL on exactly that predicate, and Postgres can only prove a
 * partial index applies against constants — parameterising it disqualifies every
 * one of them silently. And the sitemap is the platform's only OFFSET-paged
 * query: a deep page is the one place a plan regression shows up as a table scan
 * per crawl rather than as a slightly slower request. This script:
 *
 *   1. checks every index the module depends on exists;
 *   2. prints the PLAN for each sitemap section, shallow and deep;
 *   3. times each one cold and warm;
 *   4. reports which indexes were actually scanned.
 *
 * Probes hit the REPOSITORY, not the services, on purpose: the services are
 * behind a Redis cache, and a warm cache would report microseconds while saying
 * nothing about the database.
 *
 * Run it after any change to `seo.repository.ts`, to `seo.indexability.ts`, or
 * to the index files those depend on:
 *
 *     DATABASE_URL=<url> npx tsx scripts/seo-index-report.ts
 *
 * On a small table the planner may legitimately prefer a sequential scan — an
 * unused index here is a prompt to check the data volume, not an automatic bug.
 * Seed a realistic corpus before drawing conclusions.
 */
import { prisma } from '../src/core/database/prisma';
import { redis } from '../src/core/providers/redis';
import { seoRepository } from '../src/modules/seo/seo.repository';
import {
  SITEMAP_MAX_CHUNKS,
  SITEMAP_URLS_PER_CHUNK,
} from '../src/modules/seo/seo.config';
import {
  DYNAMIC_SITEMAP_SECTIONS,
  type DynamicSitemapSection,
} from '../src/modules/seo/seo.types';

/**
 * Indexes the SEO module depends on.
 *
 * NONE of them is created by `prisma/sql/seo_indexes.sql` — that file
 * deliberately adds nothing and documents why. Every entry here belongs to
 * another module, which is precisely the reason to list them: each now has one
 * more dependant than its owner may realise.
 */
const EXPECTED_INDEXES = [
  'blog_search_published_idx', // every sitemap section's eligible set
  'blog_feed_author_public_idx', // the per-author "has published" aggregate
  'BlogTag_tagId_idx', // the tag section and the per-tag count
  'BlogCategory_categoryId_idx', // the category section and the per-category count
  'BlogSEO_blogId_key', // the canonical anti-join, and the override read
  'Blog_slug_key', // the identity probe on every metadata request
  'User_username_key', // the same, for a profile
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
  section: DynamicSitemapSection;
  page: number;
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
 * section reports "unused" for indexes the plans above clearly named.
 */
async function readIndexStatsFresh(): Promise<Map<string, IndexStat>> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await prisma.$executeRawUnsafe('SELECT pg_stat_clear_snapshot()');
  return readIndexStats();
}

/**
 * One probe per section, plus a DEEP page for each that has one.
 *
 * The deep page is the point of this script. A sitemap chunk is addressed by
 * page number and therefore by `OFFSET`, so page 1 tells you almost nothing:
 * every plan looks fine when the offset is zero. What matters is whether the
 * planner still walks the index at page 20, where a regression means Postgres
 * discards a hundred thousand rows before returning any.
 */
async function buildProbes(): Promise<Probe[]> {
  const probes: Probe[] = [];

  for (const section of DYNAMIC_SITEMAP_SECTIONS) {
    const summary = await seoRepository.findSitemapChunkSummary(section);
    if (summary.length === 0) continue;

    const total = summary.reduce((sum, chunk) => sum + chunk.urls, 0);
    probes.push({
      label: `${section} page 1 of ${summary.length} (${total} URLs)`,
      section,
      page: 1,
    });

    const deepest = summary[summary.length - 1]!.page;
    if (deepest > 1) {
      probes.push({ label: `${section} page ${deepest} (deepest)`, section, page: deepest });
    }
  }

  return probes;
}

/** The plan for a probe, indented for reading. */
async function explain(probe: Probe): Promise<string> {
  // EXPLAIN over the statement the repository actually builds — not a copy of
  // it, which would drift the first time that file changes.
  const query = seoRepository.buildChunkQuery(probe.section, probe.page);
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
    { blogs: number; indexable: number; authors: number; tags: number; categories: number }[]
  >`
    SELECT (SELECT count(*)::int FROM "Blog") AS blogs,
           (SELECT count(*)::int FROM "Blog" b JOIN "User" u ON u."id" = b."authorId"
             WHERE b."status" = 'PUBLISHED' AND b."visibility" = 'PUBLIC'
               AND b."isHidden" = false AND b."publishedAt" IS NOT NULL
               AND u."status" = 'ACTIVE') AS indexable,
           (SELECT count(*)::int FROM "User" WHERE "status" = 'ACTIVE') AS authors,
           (SELECT count(*)::int FROM "Tag") AS tags,
           (SELECT count(*)::int FROM "Category") AS categories
  `;
  console.log(
    `\n== Corpus: ${counts!.blogs} blogs (${counts!.indexable} indexable), ` +
      `${counts!.authors} active authors, ${counts!.tags} tags, ${counts!.categories} categories ==`
  );
  console.log(
    `   Chunk size ${SITEMAP_URLS_PER_CHUNK}, ceiling ${SITEMAP_MAX_CHUNKS} chunks ` +
      `(${(SITEMAP_MAX_CHUNKS * SITEMAP_URLS_PER_CHUNK).toLocaleString()} URLs per section)`
  );

  const probes = await buildProbes();
  if (probes.length === 0) {
    console.log('\n  No indexable content — seed a corpus before drawing conclusions.');
  }

  console.log('\n== Plans ==');
  for (const probe of probes) {
    console.log(`\n  ${probe.label}`);
    try {
      console.log(await explain(probe));
    } catch (err) {
      console.log(`      FAILED: ${(err as Error).message}`);
    }
  }

  console.log('\n== Chunk latency (cold / median of 5 warm) ==');
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
        rows = (await seoRepository.findSitemapChunk(probe.section, probe.page)).length;
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
        `${rows.toString().padStart(5)} rows  ${probe.label}`
    );
  }

  // The aggregate behind the sitemap INDEX. One per section, and the most
  // expensive thing this module does: it windows over the whole eligible set to
  // assign rows to chunks. Bounded by the ceiling above, cached for an hour, and
  // worth watching as the corpus grows.
  console.log('\n== Index-document aggregates (one per section) ==');
  for (const section of DYNAMIC_SITEMAP_SECTIONS) {
    const started = process.hrtime.bigint();
    const summary = await seoRepository.findSitemapChunkSummary(section);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(
      `  ${ms.toFixed(1).padStart(7)}ms  ${String(summary.length).padStart(3)} chunk(s)  ${section}`
    );
  }

  // The lookups a metadata request pays on EVERY request, cache hit included
  // (see seo.service). Timed separately because they are not part of the sitemap
  // path, and listed because several of the expected indexes exist to serve them.
  console.log('\n== Metadata resolution ==');
  const [subjects] = await prisma.$queryRaw<
    { slug: string; username: string; tag: string; category: string }[]
  >`
    SELECT coalesce((SELECT "slug" FROM "Blog" WHERE "status" = 'PUBLISHED' LIMIT 1), '') AS slug,
           coalesce((SELECT "username" FROM "User" WHERE "status" = 'ACTIVE' LIMIT 1), '') AS username,
           coalesce((SELECT "slug" FROM "Tag" LIMIT 1), '')      AS tag,
           coalesce((SELECT "slug" FROM "Category" LIMIT 1), '') AS category
  `;

  for (const [label, run] of [
    ['blog identity probe (slug → id)', () => seoRepository.findBlogIdBySlug(subjects!.slug)],
    [
      'author identity probe (username → id)',
      () => seoRepository.findUserIdByUsername(subjects!.username),
    ],
    [
      'author profile (+ aggregate)',
      async () => {
        const id = await seoRepository.findUserIdByUsername(subjects!.username);
        return id ? seoRepository.findAuthorById(id) : null;
      },
    ],
    ['tag by slug (+ aggregate)', () => seoRepository.findTagBySlug(subjects!.tag)],
    ['category by slug (+ aggregate)', () => seoRepository.findCategoryBySlug(subjects!.category)],
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
      `  ${String(delta).padStart(6)} scans  ${size.padStart(8)}  ${name}` +
        (delta === 0 ? '   <- unused in this run' : '')
    );
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
