/**
 * Moderation index verification.
 *
 * Answers the only question that matters about an index set: are the indexes
 * actually being used, or is Postgres quietly reading the table and sorting?
 *
 * A `CREATE INDEX` that succeeded proves nothing here, for two specific
 * reasons. `report_open_queue_idx` and `report_open_unique_idx` are PARTIAL, so
 * the planner can only use them when the query's status predicate matches the
 * index's — and that predicate is written twice, once in
 * `moderation.config.ts` and once in `prisma/sql/moderation_indexes.sql`. Let
 * those drift and the queue silently becomes a sequential scan plus a sort, on
 * the one table that grows forever.
 *
 * This script:
 *
 *   1. checks every expected index exists;
 *   2. snapshots `pg_stat_user_indexes.idx_scan`;
 *   3. runs each moderation read through the REPOSITORY that owns it;
 *   4. re-reads the counters and reports which indexes were touched, and how
 *      long each query took.
 *
 * Run it after any change to the moderation queries or to
 * prisma/sql/moderation_indexes.sql:
 *
 *     DATABASE_URL=<url> npx tsx scripts/moderation-index-report.ts
 *
 * On an empty or tiny table the planner will legitimately prefer a sequential
 * scan — an unused index there is a prompt to seed data, not a bug. Pass
 * `--seed` to build a synthetic backlog first (refuses to touch a hosted
 * database, and only ever writes to the database in DATABASE_URL):
 *
 *     DATABASE_URL=<local test url> npx tsx scripts/moderation-index-report.ts --seed
 */
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { prisma } from '../src/core/database/prisma';
import { redis } from '../src/core/providers/redis';
import { auditRepository } from '../src/modules/moderation/audit.repository';
import { reportRepository } from '../src/modules/moderation/report.repository';
import { OVERVIEW_ACTIVITY_DAYS } from '../src/modules/moderation/moderation.config';

/**
 * Indexes the moderation reads depend on.
 *
 * The two partial ones come from `prisma/sql/moderation_indexes.sql`; the rest
 * are declared in the Prisma schema and named by its convention.
 */
const EXPECTED_INDEXES = [
  'report_open_queue_idx',
  'report_open_unique_idx',
  'Report_status_createdAt_id_idx',
  'Report_createdAt_id_idx',
  'Report_targetType_targetId_status_idx',
  'Report_targetOwnerId_createdAt_id_idx',
  'Report_assignedToId_status_createdAt_idx',
  'ModerationAction_createdAt_id_idx',
  'ModerationAction_targetType_targetId_createdAt_idx',
  'ModerationAction_actorId_createdAt_idx',
  'ModerationAction_action_createdAt_idx',
  'ModerationAction_subjectUserId_createdAt_idx',
];

const SEED = process.argv.includes('--seed');

interface Probe {
  name: string;
  run: (ctx: { moderatorId: string; ownerId: string; targetId: string }) => Promise<unknown>;
}

const PROBES: Probe[] = [
  {
    name: 'queue: open, oldest first',
    run: () =>
      reportRepository.list(
        { statuses: ['PENDING', 'REVIEWING'] },
        { limit: 25, sort: 'asc' }
      ),
  },
  {
    name: 'queue: open, page 2 (keyset)',
    run: async () => {
      const first = await reportRepository.list(
        { statuses: ['PENDING', 'REVIEWING'] },
        { limit: 25, sort: 'asc' }
      );
      const last = first[first.length - 1];
      if (!last) return [];
      return reportRepository.list(
        { statuses: ['PENDING', 'REVIEWING'] },
        { limit: 25, sort: 'asc', position: { createdAt: last.createdAt, id: last.id } }
      );
    },
  },
  {
    name: 'queue: filtered by reason',
    run: () =>
      reportRepository.list(
        { statuses: ['PENDING'], reason: 'SPAM' },
        { limit: 25, sort: 'asc' }
      ),
  },
  {
    name: 'queue: one moderator\'s claimed work',
    run: ({ moderatorId }) =>
      reportRepository.list(
        { statuses: ['REVIEWING'], assignedToId: moderatorId },
        { limit: 25, sort: 'desc' }
      ),
  },
  {
    name: 'queue: everything about one account',
    run: ({ ownerId }) =>
      reportRepository.list({ targetOwnerId: ownerId }, { limit: 25, sort: 'desc' }),
  },
  {
    name: 'duplicate check: open reports for a target',
    run: ({ targetId }) => reportRepository.countOpenForTarget('BLOG', targetId),
  },
  {
    name: 'overview: pending count',
    run: () => reportRepository.countByStatus('PENDING'),
  },
  {
    name: 'overview: oldest open report',
    run: () => reportRepository.oldestOpenAt(),
  },
  {
    name: 'overview: open grouped by reason',
    run: () => reportRepository.groupOpenByReason(),
  },
  {
    name: 'history: newest first',
    run: () => auditRepository.list({}, { limit: 25, sort: 'desc' }),
  },
  {
    name: 'history: one account\'s record',
    run: ({ ownerId }) => auditRepository.findForSubject(ownerId, 25),
  },
  {
    name: 'history: one target',
    run: ({ targetId }) => auditRepository.findForTarget('BLOG', targetId, 25),
  },
  {
    name: 'history: filtered by action',
    run: () => auditRepository.list({ action: 'CONTENT_HIDDEN' }, { limit: 25, sort: 'desc' }),
  },
  {
    name: 'overview: throughput by action',
    run: () =>
      auditRepository.countByActionSince(
        new Date(Date.now() - OVERVIEW_ACTIVITY_DAYS * 86_400_000)
      ),
  },
];

/**
 * Makes Postgres publish the statistics the probes just generated.
 *
 * Not politeness — correctness. A backend flushes its pending cumulative stats
 * when a TRANSACTION ENDS (and at most once a second), or when it exits. The
 * probes run on pooled connections that then sit idle, so nothing triggers that
 * flush and reading `pg_stat_user_indexes` straight afterwards returns the
 * counters from BEFORE the probes — the exact false alarm this report exists to
 * rule out. Disconnecting makes the backends exit and flush on the way out.
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
 * Builds a backlog large enough for the planner to prefer an index.
 *
 * Deliberately lopsided, and in the direction real moderation data is: mostly
 * CLOSED reports with a small open queue on top. A corpus that was half open
 * would make the partial index look pointless — its whole value is that the open
 * set stays small while history grows without bound.
 */
async function seed(): Promise<{ moderatorId: string; ownerId: string; targetId: string }> {
  const url = process.env.DATABASE_URL ?? '';
  if (/neon\.tech|amazonaws|\.render\.com|supabase/i.test(url)) {
    throw new Error('--seed refuses to write to a hosted database. Point DATABASE_URL at a local one.');
  }

  const stamp = Date.now();
  const user = (suffix: string, role: 'USER' | 'MODERATOR') =>
    prisma.user.create({
      data: {
        email: `mod-probe${stamp}-${suffix}@local.test`,
        username: `mod-probe${stamp}-${suffix}`,
        name: `Probe ${suffix}`,
        passwordHash: 'not-a-real-hash',
        role,
      },
    });

  const moderator = await user('mod', 'MODERATOR');
  const owner = await user('owner', 'USER');
  const reporters: { id: string }[] = [];
  for (let i = 0; i < 50; i++) reporters.push(await user(`r${i}`, 'USER'));

  const REASONS = ['SPAM', 'HARASSMENT', 'HATE_SPEECH', 'MISINFORMATION', 'OTHER'] as const;
  const day = 86_400_000;

  // 20 000 closed reports spread over two years, then 300 open ones on top.
  const closed = Array.from({ length: 20_000 }, (_, i) => ({
    reporterId: reporters[i % reporters.length]!.id,
    source: 'USER' as const,
    targetType: (i % 3 === 0 ? 'COMMENT' : 'BLOG') as 'BLOG' | 'COMMENT',
    targetId: `seed-target-${i % 500}`,
    targetOwnerId: i % 7 === 0 ? owner.id : `seed-owner-${i % 50}`,
    reason: REASONS[i % REASONS.length]!,
    status: (i % 2 === 0 ? 'RESOLVED' : 'DISMISSED') as 'RESOLVED' | 'DISMISSED',
    resolvedById: moderator.id,
    resolvedAt: new Date(Date.now() - (i % 700) * day),
    createdAt: new Date(Date.now() - (i % 700) * day - 3_600_000),
  }));

  const open = Array.from({ length: 300 }, (_, i) => ({
    reporterId: reporters[i % reporters.length]!.id,
    source: 'USER' as const,
    targetType: 'BLOG' as const,
    // Distinct per reporter+target, or the partial unique index refuses them.
    targetId: `seed-open-${i}`,
    targetOwnerId: i % 5 === 0 ? owner.id : `seed-owner-${i % 50}`,
    reason: REASONS[i % REASONS.length]!,
    status: (i % 4 === 0 ? 'REVIEWING' : 'PENDING') as 'PENDING' | 'REVIEWING',
    assignedToId: i % 4 === 0 ? moderator.id : null,
    createdAt: new Date(Date.now() - i * 3_600_000),
  }));

  await prisma.report.createMany({ data: [...closed, ...open], skipDuplicates: true });

  const ACTIONS = [
    'CONTENT_HIDDEN',
    'CONTENT_RESTORED',
    'USER_SUSPENDED',
    'REPORT_CLAIMED',
    'REPORT_RESOLVED',
  ] as const;

  await prisma.moderationAction.createMany({
    data: Array.from({ length: 20_000 }, (_, i) => ({
      actorId: moderator.id,
      action: ACTIONS[i % ACTIONS.length]!,
      targetType: (i % 3 === 0 ? 'COMMENT' : 'BLOG') as 'BLOG' | 'COMMENT',
      targetId: `seed-target-${i % 500}`,
      subjectUserId: i % 7 === 0 ? owner.id : `seed-owner-${i % 50}`,
      createdAt: new Date(Date.now() - (i % 700) * day),
    })),
  });

  await prisma.$executeRawUnsafe('ANALYZE');
  console.log(
    `seeded ${closed.length} closed + ${open.length} open reports and 20000 audit rows; ` +
      `moderator = ${moderator.username}\n`
  );

  return { moderatorId: moderator.id, ownerId: owner.id, targetId: 'seed-target-1' };
}

/** Probe context from whatever is already in the database. */
async function existingContext(): Promise<
  { moderatorId: string; ownerId: string; targetId: string } | null
> {
  const report = await prisma.report.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!report) return null;

  const moderator = await prisma.user.findFirst({
    where: { role: { in: ['MODERATOR', 'ADMIN'] } },
    select: { id: true },
  });

  return {
    moderatorId: moderator?.id ?? report.reporterId ?? 'none',
    ownerId: report.targetOwnerId ?? 'none',
    targetId: report.targetId,
  };
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

  const ctx = SEED ? await seed() : await existingContext();
  if (!ctx) {
    console.log('\nNo reports in this database — nothing to probe. Re-run with --seed.');
    await shutdown();
    return;
  }

  // Settle first as well: the seed above is a large write, and its index
  // maintenance would otherwise land in the probes' delta.
  await settleStats();
  const before = await indexScanCounts();

  console.log('\n── Probes ──────────────────────────────────────────────');
  for (const probe of PROBES) {
    const started = process.hrtime.bigint();
    const rows = await probe.run(ctx);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const count = Array.isArray(rows) ? rows.length : typeof rows === 'number' ? rows : 1;
    console.log(`  ${probe.name.padEnd(38)} ${ms.toFixed(1).padStart(7)} ms  (${count} row(s))`);
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
    console.log('  (`report_open_unique_idx` is only touched by an INSERT, and a');
    console.log('   composite the planner answered from a narrower partial index');
    console.log('   is not a regression — check against the probe list first.)');
  }

  await shutdown();
}

async function shutdown(): Promise<void> {
  await prisma.$disconnect();
  redis.disconnect();
}

main().catch(async (err) => {
  console.error('moderation index report failed:', err);
  await shutdown();
  process.exit(1);
});
