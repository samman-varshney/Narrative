/**
 * Dashboard index verification.
 *
 * Answers the only question that matters about an index set: are the indexes
 * actually being used, or is Postgres quietly reading the table and sorting?
 *
 * A `CREATE INDEX` that succeeded proves nothing. `comment_author_activity_idx`
 * is PARTIAL, and Postgres can only prove a partial index applies when the
 * query's predicate is a literal — so a change to how the Comment repository
 * expresses `deletedAt: null`, or an edit to the predicate out of step with
 * `prisma/sql/dashboard_indexes.sql`, disqualifies it silently and shows up
 * only as latency. This script:
 *
 *   1. checks every expected index exists;
 *   2. snapshots `pg_stat_user_indexes.idx_scan`;
 *   3. runs each dashboard read through the SERVICE layer that owns it;
 *   4. re-reads the counters and reports which indexes were touched, and how
 *      long each query took.
 *
 * Probes hit repositories and sibling SERVICES, never the dashboard's own
 * cached endpoints: the dashboard service is behind Redis, and a warm cache
 * would report microseconds while saying nothing at all about the database.
 *
 * Run it after any change to the dashboard reads or to
 * prisma/sql/dashboard_indexes.sql:
 *
 *     DATABASE_URL=<url> npx tsx scripts/dashboard-index-report.ts
 *
 * On an empty or tiny table the planner will legitimately prefer a sequential
 * scan — an unused index there is a prompt to seed data, not a bug. Pass
 * `--seed` to build a synthetic corpus first (refuses to touch a hosted
 * database, and only ever writes to the database in DATABASE_URL):
 *
 *     DATABASE_URL=<local test url> npx tsx scripts/dashboard-index-report.ts --seed
 */
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { prisma } from '../src/core/database/prisma';
import { redis } from '../src/core/providers/redis';
import { commentRepository } from '../src/modules/comment/comment.repository';
import { blogRepository } from '../src/modules/blog/blog.repository';
import { followRepository } from '../src/modules/follow/follow.repository';
import { bookmarkRepository } from '../src/modules/bookmark/bookmark.repository';
import { analyticsRepository } from '../src/modules/analytics/analytics.repository';
import { ACTIVITY_LOOKBACK_DAYS, PANEL_LIMITS } from '../src/modules/dashboard/dashboard.config';

/**
 * Indexes the dashboard's reads depend on.
 *
 * Only the first is created by this module. The rest are listed because the
 * dashboard is one of their dependants, and an index with an unrecorded
 * dependant is an index that gets dropped by the module that created it.
 */
const EXPECTED_INDEXES = [
  'comment_author_activity_idx',
  'Blog_authorId_status_idx',
  'Follow_followingId_createdAt_idx',
  'Follow_followerId_createdAt_idx',
  'Bookmark_userId_createdAt_idx',
  'BlogAnalyticsDaily_authorId_date_idx',
];

const SEED = process.argv.includes('--seed');

interface Probe {
  name: string;
  run: (authorId: string) => Promise<unknown>;
}

const PROBES: Probe[] = [
  {
    name: 'activity: comments received',
    run: (authorId) =>
      commentRepository.findReceivedByAuthor(authorId, {
        limit: PANEL_LIMITS.activity,
        since: new Date(Date.now() - ACTIVITY_LOOKBACK_DAYS * 86_400_000),
      }),
  },
  {
    name: 'panel: recent published',
    run: (authorId) =>
      blogRepository.listByAuthor(authorId, PANEL_LIMITS.recentBlogs, {
        statuses: ['PUBLISHED'],
        order: 'published',
      }),
  },
  {
    name: 'panel: recent drafts',
    run: (authorId) =>
      blogRepository.listByAuthor(authorId, PANEL_LIMITS.drafts, {
        statuses: ['DRAFT'],
        order: 'updated',
      }),
  },
  {
    name: 'stats: blog counts by status',
    run: (authorId) => blogRepository.countByStatus(authorId),
  },
  {
    name: 'stats: follower count',
    run: (authorId) => followRepository.countFollowers(authorId),
  },
  {
    name: 'stats: following count',
    run: (authorId) => followRepository.countFollowing(authorId),
  },
  {
    name: 'activity: recent followers',
    run: (authorId) =>
      followRepository.getFollowers(authorId, { limit: PANEL_LIMITS.activity }),
  },
  {
    name: 'panel: bookmark library',
    run: (authorId) =>
      bookmarkRepository.getBookmarks(authorId, {
        limit: PANEL_LIMITS.bookmarks,
        sort: 'recent',
      }),
  },
  {
    name: 'stats: analytics totals (30d)',
    run: (authorId) =>
      analyticsRepository.getUserTotals(authorId, {
        startDate: new Date(Date.now() - 30 * 86_400_000),
        endDate: new Date(),
        granularity: 'day',
      }),
  },
];

/**
 * Makes Postgres publish the statistics the probes just generated.
 *
 * Not politeness — correctness, and the subtlest thing in this file. A backend
 * flushes its pending cumulative stats when a TRANSACTION ENDS (and at most once
 * a second), or when it exits. The probes run on pooled connections that then
 * sit idle, so nothing ever triggers that flush: reading
 * `pg_stat_user_indexes` straight afterwards returns the counters from BEFORE
 * the probes, and the report confidently declares every index unused — the exact
 * false alarm it exists to rule out. Waiting does not help either, because an
 * idle backend has no transaction end to flush at.
 *
 * Disconnecting does: the pool's backends exit and flush on the way out. Prisma
 * reconnects transparently for the read that follows. `pg_stat_force_next_flush`
 * is not enough on its own — it only affects the calling backend, and the probes
 * were spread across the pool.
 */
async function settleStats(): Promise<void> {
  await prisma.$disconnect();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
}

async function indexScanCounts(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ indexrelname: string; idx_scan: bigint }[]>`
    SELECT indexrelname, idx_scan
    FROM pg_stat_user_indexes
    WHERE schemaname = 'public'
  `;
  return new Map(rows.map((row) => [row.indexrelname, Number(row.idx_scan)]));
}

async function existingIndexes(): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
  `;
  return new Set(rows.map((row) => row.indexname));
}

/**
 * Builds a corpus large enough for the planner to prefer an index.
 *
 * Deliberately lopsided: one author with many posts and many comments, plus
 * noise from other authors. A uniform corpus would let a sequential scan look
 * reasonable on every query and prove nothing about the selective ones.
 */
async function seed(): Promise<string> {
  const url = process.env.DATABASE_URL ?? '';
  if (/neon\.tech|amazonaws|\.render\.com|supabase/i.test(url)) {
    throw new Error('--seed refuses to write to a hosted database. Point DATABASE_URL at a local one.');
  }

  const stamp = Date.now();
  const authors = [];
  for (let i = 0; i < 20; i++) {
    authors.push(
      await prisma.user.create({
        data: {
          email: `probe${stamp}-${i}@local.test`,
          username: `probe${stamp}-${i}`,
          name: `Probe ${i}`,
          passwordHash: 'not-a-real-hash',
        },
      })
    );
  }

  const subject = authors[0]!;

  for (const [index, author] of authors.entries()) {
    const blogCount = index === 0 ? 60 : 25;
    for (let b = 0; b < blogCount; b++) {
      const blog = await prisma.blog.create({
        data: {
          title: `Probe blog ${stamp}-${index}-${b}`,
          slug: `probe-${stamp}-${index}-${b}`,
          authorId: author.id,
          status: b % 5 === 0 ? 'DRAFT' : 'PUBLISHED',
          publishedAt: b % 5 === 0 ? null : new Date(Date.now() - b * 3_600_000),
        },
      });

      const commenter = authors[(index + 1) % authors.length]!;
      await prisma.comment.createMany({
        data: Array.from({ length: 20 }, (_, c) => ({
          blogId: blog.id,
          authorId: commenter.id,
          content: `probe comment ${c}`,
          path: '',
          createdAt: new Date(Date.now() - c * 60_000),
        })),
      });
    }
  }

  // Follows, bookmarks and analytics rows for the subject, in bulk. Without
  // them the audience, library and stats probes run against empty tables, the
  // planner correctly prefers a sequential scan, and the report cannot say
  // anything at all about four of the six indexes it checks.
  const others = authors.slice(1).map((author) => author.id);

  await prisma.follow.createMany({
    data: others.map((followerId) => ({ followerId, followingId: subject.id })),
    skipDuplicates: true,
  });
  await prisma.follow.createMany({
    data: others.map((followingId) => ({ followerId: subject.id, followingId })),
    skipDuplicates: true,
  });

  const otherBlogs = await prisma.blog.findMany({
    where: { authorId: { in: others } },
    select: { id: true },
    take: 200,
  });
  await prisma.bookmark.createMany({
    data: otherBlogs.map((blog) => ({ userId: subject.id, blogId: blog.id })),
    skipDuplicates: true,
  });

  const subjectBlogs = await prisma.blog.findMany({
    where: { authorId: subject.id },
    select: { id: true },
  });
  await prisma.blogAnalyticsDaily.createMany({
    data: subjectBlogs.flatMap((blog) =>
      Array.from({ length: 30 }, (_, day) => ({
        blogId: blog.id,
        authorId: subject.id,
        date: new Date(
          new Date(new Date().toISOString().slice(0, 10)).getTime() - day * 86_400_000
        ),
        views: 10 + day,
        uniqueViews: 5 + day,
        readStarts: 4,
        readCompletions: 2,
        totalReadingSeconds: 300,
        bookmarks: 1,
        unbookmarks: 0,
        comments: 1,
      }))
    ),
    skipDuplicates: true,
  });

  await prisma.$executeRawUnsafe('ANALYZE');
  console.log(
    `seeded 20 authors, ~570 blogs, ~11400 comments, ${others.length * 2} follows, ` +
      `${otherBlogs.length} bookmarks, ${subjectBlogs.length * 30} analytics rows; ` +
      `subject = ${subject.username}\n`
  );
  return subject.id;
}

/** The author with the most blogs — the one whose queries are worth timing. */
async function busiestAuthor(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ authorId: string }[]>`
    SELECT "authorId" FROM "Blog" GROUP BY "authorId" ORDER BY COUNT(*) DESC LIMIT 1
  `;
  return rows[0]?.authorId ?? null;
}

async function main(): Promise<void> {
  const present = await existingIndexes();

  console.log('── Indexes ─────────────────────────────────────────────');
  let missing = 0;
  for (const name of EXPECTED_INDEXES) {
    const ok = present.has(name);
    if (!ok) missing++;
    console.log(`${ok ? '  ok    ' : '  MISSING'} ${name}`);
  }
  if (missing > 0) {
    console.log(`\n${missing} index(es) missing — run \`npm run db:indexes\` (and \`prisma db push\`).`);
  }

  const authorId = SEED ? await seed() : await busiestAuthor();
  if (!authorId) {
    console.log('\nNo blogs in this database — nothing to probe. Re-run with --seed.');
    await shutdown();
    return;
  }

  // Settle first as well: the seed above is itself a large write, and its index
  // maintenance would otherwise land in the probes' delta.
  await settleStats();
  const before = await indexScanCounts();

  console.log('\n── Probes ──────────────────────────────────────────────');
  for (const probe of PROBES) {
    const started = process.hrtime.bigint();
    const rows = await probe.run(authorId);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const count = Array.isArray(rows) ? rows.length : rows instanceof Map ? rows.size : 1;
    console.log(`  ${probe.name.padEnd(32)} ${ms.toFixed(1).padStart(7)} ms  (${count} row(s))`);
  }

  await settleStats();
  const after = await indexScanCounts();

  console.log('\n── Index scans during the probes ───────────────────────');
  const touched = [...after.entries()]
    .map(([name, count]) => ({ name, delta: count - (before.get(name) ?? 0) }))
    .filter((row) => row.delta > 0)
    .sort((a, b) => b.delta - a.delta);

  if (touched.length === 0) {
    console.log('  none — every probe used a sequential scan.');
    console.log('  On a small table that is the planner being right. Re-run with --seed.');
  } else {
    for (const row of touched) console.log(`  ${String(row.delta).padStart(4)}  ${row.name}`);
  }

  const unused = EXPECTED_INDEXES.filter(
    (name) => present.has(name) && !touched.some((row) => row.name === name)
  );
  if (unused.length > 0) {
    console.log('\n  Expected but NOT scanned:');
    for (const name of unused) console.log(`    ${name}`);
    console.log('  (Some are only reachable from the Analytics module or from a');
    console.log('   count the planner answered another way — check against the');
    console.log('   probe list before treating one as a regression.)');
  }

  await shutdown();
}

async function shutdown(): Promise<void> {
  await prisma.$disconnect();
  redis.disconnect();
}

main().catch(async (err) => {
  console.error('dashboard index report failed:', err);
  await shutdown();
  process.exit(1);
});
