/**
 * Feed index verification.
 *
 * Answers the only question that matters about a feed index set: are the
 * indexes actually being used, or is Postgres quietly reading the table and
 * sorting?
 *
 * A `CREATE INDEX` that succeeded proves nothing. The feed indexes are PARTIAL
 * on a status/visibility predicate, and Postgres can only prove a partial index
 * applies against LITERALS — so parameterising that predicate, or editing it out
 * of step with `prisma/sql/feed_indexes.sql`, disqualifies every one of them
 * silently, and shows up only as latency. This script:
 *
 *   1. checks every expected index exists;
 *   2. snapshots `pg_stat_user_indexes.idx_scan`;
 *   3. runs each feed's real query through the repository;
 *   4. re-reads the counters and reports which indexes were touched, and how
 *      long each query took.
 *
 * Probes hit the REPOSITORY, not the service, on purpose: the service is behind
 * a Redis cache, and a warm cache would report microseconds while saying nothing
 * about the database.
 *
 * Run it after any change to the feed SQL or to prisma/sql/feed_indexes.sql:
 *
 *     DATABASE_URL=<url> npx tsx scripts/feed-index-report.ts
 *
 * On a small table the planner may legitimately prefer a sequential scan — an
 * unused index here is a prompt to check the data volume, not an automatic bug.
 * Seed a realistic corpus before drawing conclusions.
 */
import { prisma } from '../src/core/database/prisma';
import { redis } from '../src/core/providers/redis';
import { analyticsService } from '../src/modules/analytics/analytics.service';
import { followService } from '../src/modules/follow/follow.service';
import { feedRepository } from '../src/modules/feed/feed.repository';
import {
  CANDIDATE_LIMIT,
  ENGAGEMENT_WEIGHTS,
  EXPLORE_ENGAGEMENT_WINDOW_DAYS,
} from '../src/modules/feed/feed.config';

/**
 * Indexes the feeds depend on.
 *
 * `blog_search_published_idx` is on the list although `feed_indexes.sql` does
 * not create it: all four feeds walk exactly the ordering it provides, so it has
 * two dependants and dropping it with the Search module would silently degrade
 * discovery too. See the note in prisma/sql/feed_indexes.sql.
 */
const EXPECTED_INDEXES = [
  'blog_search_published_idx',
  'blog_feed_author_public_idx',
  'BlogAnalyticsDaily_date_idx',
  'Follow_followerId_followingId_key',
  'Follow_followerId_createdAt_idx',
];

const PAGE_LIMIT = 20;

/** Warm runs timed per probe, after the first (cold) one. */
const WARM_RUNS = 5;

interface IndexStat {
  indexrelname: string;
  idx_scan: bigint;
  size: string;
}

async function pickHeavyFollower(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ followerId: string }[]>`
    SELECT "followerId" FROM "Follow" GROUP BY "followerId"
    ORDER BY count(*) DESC LIMIT 1
  `;
  return rows[0]?.followerId ?? null;
}

async function pickLightFollower(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ followerId: string }[]>`
    SELECT "followerId" FROM "Follow" GROUP BY "followerId"
    ORDER BY count(*) ASC LIMIT 1
  `;
  return rows[0]?.followerId ?? null;
}

async function pickTag(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ slug: string }[]>`
    SELECT t."slug" FROM "Tag" t
    JOIN "BlogTag" bt ON bt."tagId" = t."id"
    GROUP BY t."slug" ORDER BY count(*) DESC LIMIT 1
  `;
  return rows[0]?.slug ?? null;
}

async function buildProbes(): Promise<{ label: string; run: () => Promise<number> }[]> {
  const [heavy, light, tag] = await Promise.all([
    pickHeavyFollower(),
    pickLightFollower(),
    pickTag(),
  ]);

  const probes: { label: string; run: () => Promise<number> }[] = [
    {
      label: 'latest: first page',
      run: async () =>
        (
          await feedRepository.findChronologicalPage({
            filters: {},
            limit: PAGE_LIMIT,
          })
        ).length,
    },
    {
      label: 'explore: candidate pool (recency source)',
      run: async () =>
        (
          await feedRepository.findRecentCandidates({
            filters: {},
            limit: CANDIDATE_LIMIT,
          })
        ).length,
    },
    {
      label: 'trending: engagement ranking (Analytics)',
      run: async () => {
        const window = analyticsService.buildEngagementWindow({
          windowDays: 7,
          weights: ENGAGEMENT_WEIGHTS,
        });
        return (await analyticsService.getEngagementRanking(window, CANDIDATE_LIMIT)).length;
      },
    },
    {
      label: 'explore: engagement for candidate ids (Analytics)',
      run: async () => {
        const rows = await feedRepository.findRecentCandidates({
          filters: {},
          limit: CANDIDATE_LIMIT,
        });
        const window = analyticsService.buildEngagementWindow({
          windowDays: EXPLORE_ENGAGEMENT_WINDOW_DAYS,
          weights: ENGAGEMENT_WEIGHTS,
        });
        const scores = await analyticsService.getEngagementForBlogs(
          rows.map((row) => row.id),
          window
        );
        return scores.size;
      },
    },
  ];

  if (tag) {
    probes.push({
      label: `latest: filtered by tag "${tag}"`,
      run: async () =>
        (
          await feedRepository.findChronologicalPage({
            filters: { tags: [tag] },
            limit: PAGE_LIMIT,
          })
        ).length,
    });
  }

  for (const [label, viewer] of [
    ['following: viewer with the MOST follows', heavy],
    ['following: viewer with the FEWEST follows', light],
  ] as const) {
    if (!viewer) continue;
    probes.push({
      label,
      run: async () =>
        (
          await feedRepository.findChronologicalPage({
            filters: {},
            limit: PAGE_LIMIT,
            authorScope: followService.followedAuthorIdsSql(viewer),
          })
        ).length,
    });
  }

  return probes;
}

async function readIndexStats(): Promise<Map<string, IndexStat>> {
  // Index counters live in the cumulative statistics system, which each backend
  // flushes lazily. Reading them straight after the probes would report zero
  // scans for indexes that were demonstrably used.
  await prisma.$executeRawUnsafe('SELECT pg_stat_force_next_flush()').catch(() => {
    // PG < 15: fall back to whatever has flushed on its own.
  });

  const rows = await prisma.$queryRaw<IndexStat[]>`
    SELECT s.indexrelname,
           s.idx_scan,
           pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
    FROM pg_stat_user_indexes s
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

  const [counts] = await prisma.$queryRaw<
    { blogs: number; published: number; users: number; follows: number; analytics: number }[]
  >`
    SELECT (SELECT count(*)::int FROM "Blog")   AS blogs,
           (SELECT count(*)::int FROM "Blog"
             WHERE "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC') AS published,
           (SELECT count(*)::int FROM "User")   AS users,
           (SELECT count(*)::int FROM "Follow") AS follows,
           (SELECT count(*)::int FROM "BlogAnalyticsDaily") AS analytics
  `;
  console.log(
    `\n== Corpus: ${counts!.blogs} blogs (${counts!.published} publicly discoverable), ` +
      `${counts!.users} users, ${counts!.follows} follow edges, ${counts!.analytics} analytics rows ==`
  );

  console.log('\n== Query latency (cold / median of 5 warm) ==');
  // Both numbers are reported because a single timed run is misleading: straight
  // after a bulk load the heap pages are not in shared buffers and there is no
  // cached plan. The cold number is the first execution; the warm median is what
  // a served request actually costs.
  for (const probe of await buildProbes()) {
    const samples: number[] = [];
    let rows = 0;

    try {
      for (let run = 0; run < WARM_RUNS + 1; run++) {
        const started = process.hrtime.bigint();
        rows = await probe.run();
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
    '\n  Zero scans on `blog_feed_author_public_idx` is NORMAL when no followed\n' +
      '  author has a large archive — the planner prefers the smaller\n' +
      '  `Blog_authorId_status_idx` and the difference is immeasurable. It only\n' +
      '  matters if a following-feed probe is ALSO slow, which means the planner is\n' +
      '  under-estimating one author\'s post count. Then raise the statistics target:\n' +
      '    ALTER TABLE "Blog" ALTER COLUMN "authorId" SET STATISTICS 1000; ANALYZE "Blog";\n'
  );

  await prisma.$disconnect();
  await redis.quit();
}

main().catch(async (err) => {
  console.error('feed-index-report failed:', err);
  await prisma.$disconnect();
  await redis.quit();
  process.exit(1);
});
