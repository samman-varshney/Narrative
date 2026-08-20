import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma';
import {
  disconnectDb,
  makeModerationAction,
  makeReport,
  makeUser,
  resetDb,
} from '../../../test/db';
import { auditRepository } from '../audit.repository';
import { OPEN_REPORT_STATUSES } from '../moderation.config';
import { cursorFingerprint, decodeCursor, encodeCursor } from '../moderation.cursor';
import { reportRepository } from '../report.repository';

/**
 * The moderation tables, against real SQL.
 *
 * Everything in this file is invisible to a mocked Prisma client, and every one
 * of these is a place where this module would be wrong in a way that only shows
 * up in production:
 *
 *   the partial unique index      duplicate suppression that permits a legitimate
 *                                 re-report after closure
 *   conditional updates           two moderators, one report
 *   keyset pagination             no skipped and no repeated rows, including
 *                                 across rows sharing a timestamp
 *   the append-only trigger       an audit log that cannot be edited, by anyone,
 *                                 including this codebase
 *   index usage                   verified with query plans, not assumed
 */

let moderator: { id: string };
let other: { id: string };
let reporter: { id: string };

beforeAll(async () => {
  await resetDb();
  moderator = await makeUser({ username: 'db-mod', role: 'MODERATOR' });
  other = await makeUser({ username: 'db-mod-2', role: 'MODERATOR' });
  reporter = await makeUser({ username: 'db-reporter' });
});

afterAll(async () => {
  await resetDb();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// Duplicate suppression
// ---------------------------------------------------------------------------

describe('the partial unique index on open reports', () => {
  beforeEach(async () => {
    await prisma.report.deleteMany({});
  });

  it('refuses a second OPEN report from the same reporter about the same target', async () => {
    await reportRepository.create({
      reporterId: reporter.id,
      source: 'USER',
      targetType: 'BLOG',
      targetId: 'blog-x',
      targetOwnerId: 'author-x',
      reason: 'SPAM',
      description: null,
    });

    await expect(
      reportRepository.create({
        reporterId: reporter.id,
        source: 'USER',
        targetType: 'BLOG',
        targetId: 'blog-x',
        targetOwnerId: 'author-x',
        reason: 'HARASSMENT',
        description: null,
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('ALLOWS a fresh report once the first is closed', async () => {
    const first = await makeReport({
      reporterId: reporter.id,
      targetId: 'blog-y',
      status: 'PENDING',
    });
    await reportRepository.close(first.id, 'DISMISSED', moderator.id, 'not actionable');

    // The whole reason the index is partial: someone who resumed the same
    // behaviour after a dismissal must be reportable again.
    await expect(
      reportRepository.create({
        reporterId: reporter.id,
        source: 'USER',
        targetType: 'BLOG',
        targetId: 'blog-y',
        targetOwnerId: 'author-y',
        reason: 'SPAM',
        description: null,
      })
    ).resolves.toBeDefined();
  });

  it('does not collide two different reporters on one target', async () => {
    const second = await makeUser({ username: 'db-reporter-2' });

    await reportRepository.create({
      reporterId: reporter.id,
      source: 'USER',
      targetType: 'BLOG',
      targetId: 'blog-z',
      targetOwnerId: 'author-z',
      reason: 'SPAM',
      description: null,
    });

    await expect(
      reportRepository.create({
        reporterId: second.id,
        source: 'USER',
        targetType: 'BLOG',
        targetId: 'blog-z',
        targetOwnerId: 'author-z',
        reason: 'SPAM',
        description: null,
      })
    ).resolves.toBeDefined();
  });

  it('does not constrain AUTOMATED reports, which have no reporter', async () => {
    // Two NULL reporterIds do not collide in a unique index anyway; the index
    // also excludes them explicitly. Their guard is the open-automated check.
    for (const reason of ['SPAM', 'SPAM'] as const) {
      await expect(
        reportRepository.create({
          reporterId: null,
          source: 'AUTOMATED',
          targetType: 'COMMENT',
          targetId: 'comment-a',
          targetOwnerId: 'author-a',
          reason,
          description: null,
        })
      ).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('two moderators, one report', () => {
  beforeEach(async () => {
    await prisma.report.deleteMany({});
  });

  it('lets exactly one claim succeed', async () => {
    const report = await makeReport({ reporterId: reporter.id, status: 'PENDING' });

    const results = await Promise.all([
      reportRepository.claim(report.id, moderator.id),
      reportRepository.claim(report.id, other.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const stored = await reportRepository.findById(report.id);
    expect(stored?.status).toBe('REVIEWING');
    // Whoever won owns it; the loser did not overwrite the assignment.
    expect([moderator.id, other.id]).toContain(stored?.assignedToId);
  });

  it('lets exactly one resolution stick', async () => {
    const report = await makeReport({ reporterId: reporter.id, status: 'REVIEWING' });

    const results = await Promise.all([
      reportRepository.close(report.id, 'RESOLVED', moderator.id, 'hidden the post'),
      reportRepository.close(report.id, 'DISMISSED', other.id, 'looks fine to me'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const stored = await reportRepository.findById(report.id);
    expect(['RESOLVED', 'DISMISSED']).toContain(stored?.status);
    // The resolution and its author agree — no interleaving of one moderator's
    // status with another's note.
    if (stored?.status === 'RESOLVED') {
      expect(stored.resolvedById).toBe(moderator.id);
      expect(stored.resolutionReason).toBe('hidden the post');
    } else {
      expect(stored?.resolvedById).toBe(other.id);
      expect(stored?.resolutionReason).toBe('looks fine to me');
    }
  });

  it('refuses to claim a report that is already closed', async () => {
    const report = await makeReport({ reporterId: reporter.id, status: 'RESOLVED' });
    await expect(reportRepository.claim(report.id, moderator.id)).resolves.toBe(false);
  });

  it('refuses to re-close a closed report', async () => {
    const report = await makeReport({ reporterId: reporter.id, status: 'DISMISSED' });
    await expect(
      reportRepository.close(report.id, 'RESOLVED', moderator.id, 'changed my mind')
    ).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The queue: pagination and filtering
// ---------------------------------------------------------------------------

describe('the moderation queue', () => {
  const TOTAL = 60;
  const base = new Date('2026-08-01T00:00:00.000Z');

  beforeAll(async () => {
    await prisma.report.deleteMany({});

    for (let i = 0; i < TOTAL; i++) {
      await makeReport({
        reporterId: reporter.id,
        targetType: i % 3 === 0 ? 'COMMENT' : 'BLOG',
        targetId: `target-${i}`,
        targetOwnerId: `owner-${i % 5}`,
        reason: i % 2 === 0 ? 'SPAM' : 'HARASSMENT',
        status: 'PENDING',
        // Deliberately COARSE: five reports share every timestamp, which is what
        // makes the `id` tiebreaker load-bearing rather than decorative.
        createdAt: new Date(base.getTime() + Math.floor(i / 5) * 60_000),
      });
    }
  });

  const walk = async (limit: number, filters = {}) => {
    const fingerprint = cursorFingerprint({ ...filters, sort: 'asc' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const position = cursor ? decodeCursor(cursor, fingerprint) : undefined;
      const rows = await reportRepository.list(filters, { limit, sort: 'asc', position });
      const { items, hasNextPage, last } = reportRepository.page(rows, limit);

      seen.push(...items.map((r) => r.id));
      cursor = hasNextPage && last ? encodeCursor(last, fingerprint) : null;
      pages++;
    } while (cursor && pages < 100);

    return { seen, pages };
  };

  it('walks every report exactly once, with no duplicates and no gaps', async () => {
    const { seen } = await walk(7, { statuses: ['PENDING'] });

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it('is stable across rows that share a timestamp', async () => {
    // Without the `id` tiebreaker the five rows in each minute could come back
    // in any order between pages — the classic keyset bug.
    const first = await walk(3, { statuses: ['PENDING'] });
    const second = await walk(11, { statuses: ['PENDING'] });

    expect(first.seen).toEqual(second.seen);
  });

  it('walks oldest-first for the default queue order', async () => {
    const rows = await reportRepository.list({ statuses: ['PENDING'] }, { limit: 5, sort: 'asc' });
    const times = rows.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('reverses cleanly for the newest-first view', async () => {
    const rows = await reportRepository.list({ statuses: ['PENDING'] }, { limit: 5, sort: 'desc' });
    const times = rows.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('does not repeat a row when new reports arrive mid-walk', async () => {
    // The failure OFFSET pagination has and a keyset does not.
    const fingerprint = cursorFingerprint({ statuses: ['PENDING'], sort: 'asc' });
    const firstRows = await reportRepository.list(
      { statuses: ['PENDING'] },
      { limit: 10, sort: 'asc' }
    );
    const firstPage = reportRepository.page(firstRows, 10);

    // Something jumps the queue: an OLDER report is filed while we page.
    await makeReport({
      reporterId: reporter.id,
      targetId: 'late-arrival',
      status: 'PENDING',
      createdAt: new Date(base.getTime() - 60_000),
    });

    const nextRows = await reportRepository.list(
      { statuses: ['PENDING'] },
      { limit: 10, sort: 'asc', position: decodeCursor(encodeCursor(firstPage.last!, fingerprint), fingerprint) }
    );

    const overlap = nextRows.filter((r) => firstPage.items.some((f) => f.id === r.id));
    expect(overlap).toHaveLength(0);

    await prisma.report.deleteMany({ where: { targetId: 'late-arrival' } });
  });

  it.each([
    ['target type', { targetType: 'COMMENT' as const }, (r: any) => r.targetType === 'COMMENT'],
    ['reason', { reason: 'HARASSMENT' as const }, (r: any) => r.reason === 'HARASSMENT'],
    ['target owner', { targetOwnerId: 'owner-2' }, (r: any) => r.targetOwnerId === 'owner-2'],
  ])('filters by %s', async (_label, filters, predicate) => {
    const rows = await reportRepository.list(filters, { limit: 100, sort: 'asc' });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(predicate)).toBe(true);
  });

  it('filters by date range', async () => {
    const from = new Date(base.getTime() + 5 * 60_000);
    const rows = await reportRepository.list({ from }, { limit: 100, sort: 'asc' });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.createdAt >= from)).toBe(true);
  });

  it('combines a date range WITH the keyset without either winning', async () => {
    const from = new Date(base.getTime() + 2 * 60_000);
    const fingerprint = cursorFingerprint({ from, sort: 'asc' });

    const firstRows = await reportRepository.list({ from }, { limit: 4, sort: 'asc' });
    const first = reportRepository.page(firstRows, 4);
    const nextRows = await reportRepository.list(
      { from },
      { limit: 4, sort: 'asc', position: decodeCursor(encodeCursor(first.last!, fingerprint), fingerprint) }
    );

    expect(nextRows.every((r) => r.createdAt >= from)).toBe(true);
    expect(nextRows.some((r) => first.items.some((f) => f.id === r.id))).toBe(false);
  });

  it('counts the open backlog and its oldest entry', async () => {
    const pending = await reportRepository.countByStatus('PENDING');
    const oldest = await reportRepository.oldestOpenAt();

    expect(pending).toBe(TOTAL);
    expect(oldest?.getTime()).toBe(base.getTime());
  });

  it('groups the open queue by reason and by target type', async () => {
    const byReason = await reportRepository.groupOpenByReason();
    const byType = await reportRepository.groupOpenByTargetType();

    expect(byReason.reduce((sum, row) => sum + row.count, 0)).toBe(TOTAL);
    expect(byType.reduce((sum, row) => sum + row.count, 0)).toBe(TOTAL);
  });
});

// ---------------------------------------------------------------------------
// Audit integrity
// ---------------------------------------------------------------------------

describe('the audit log is append-only, enforced by the database', () => {
  it('refuses an UPDATE, even issued directly through Prisma', async () => {
    const action = await makeModerationAction(moderator.id, { reason: 'original' });

    // Not "there is no update method" — an actual attempt, made the way a
    // careless future caller would make it.
    await expect(
      prisma.moderationAction.update({
        where: { id: action.id },
        data: { reason: 'rewritten' },
      })
    ).rejects.toThrow();

    const stored = await prisma.moderationAction.findUnique({ where: { id: action.id } });
    expect(stored?.reason).toBe('original');
  });

  it('refuses a DELETE', async () => {
    const action = await makeModerationAction(moderator.id);

    await expect(
      prisma.moderationAction.delete({ where: { id: action.id } })
    ).rejects.toThrow();

    expect(await prisma.moderationAction.findUnique({ where: { id: action.id } })).not.toBeNull();
  });

  it('refuses a bulk UPDATE, which is how a tampering script would do it', async () => {
    await makeModerationAction(moderator.id);

    await expect(
      prisma.$executeRawUnsafe('UPDATE "ModerationAction" SET "reason" = \'tampered\'')
    ).rejects.toThrow();
  });

  it('still allows appending', async () => {
    await expect(makeModerationAction(moderator.id)).resolves.toBeDefined();
  });
});

describe('audit queries', () => {
  let subject: { id: string };

  beforeAll(async () => {
    // Nothing is cleaned up here, and nothing can be: the append-only trigger
    // refuses DELETE, which is exactly the property the suite above proves. The
    // assertions below are therefore scoped to ids this block created, or
    // expressed as lower bounds.
    subject = await makeUser({ username: 'db-subject' });

    await makeModerationAction(moderator.id, {
      action: 'CONTENT_HIDDEN',
      targetType: 'BLOG',
      targetId: 'blog-1',
      subjectUserId: subject.id,
    });
    await makeModerationAction(moderator.id, {
      action: 'USER_SUSPENDED',
      targetType: 'USER',
      targetId: subject.id,
      subjectUserId: subject.id,
    });
    await makeModerationAction(other.id, {
      action: 'CONTENT_HIDDEN',
      targetType: 'COMMENT',
      targetId: 'comment-1',
      subjectUserId: 'someone-else',
    });
  });

  it("gathers one account's whole record, across their content and their account", async () => {
    const rows = await auditRepository.findForSubject(subject.id, 50);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action).sort()).toEqual(['CONTENT_HIDDEN', 'USER_SUSPENDED']);
  });

  it('gathers everything done to one piece of content', async () => {
    const rows = await auditRepository.findForTarget('BLOG', 'blog-1', 50);
    expect(rows).toHaveLength(1);
  });

  it('counts recent throughput by action', async () => {
    const rows = await auditRepository.countByActionSince(new Date(Date.now() - 60_000));
    const hidden = rows.find((r) => r.action === 'CONTENT_HIDDEN');
    const suspended = rows.find((r) => r.action === 'USER_SUSPENDED');

    // Lower bounds: the append-only log still holds every row the integrity
    // suite above wrote, and no test can remove them.
    expect(hidden?.count).toBeGreaterThanOrEqual(2);
    expect(suspended?.count).toBeGreaterThanOrEqual(1);
  });

  it('returns newest-first for the history feed', async () => {
    const rows = await auditRepository.recent(10);
    const times = rows.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

// ---------------------------------------------------------------------------
// Query plans
// ---------------------------------------------------------------------------

describe('index usage, verified with query plans', () => {
  /**
   * Postgres will happily sequential-scan a small table because that IS the
   * cheaper plan there. The planner is told to prefer indexes for the duration
   * of these checks, which is what makes the assertion meaningful on a test
   * database with a few hundred rows: it proves a usable index EXISTS for the
   * shape of the query, which is the thing a missing index would break.
   */
  const explain = async (sql: string): Promise<string> => {
    await prisma.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN ${sql}`
    );
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  };

  it('serves the open queue from the partial index, not a scan', async () => {
    const plan = await prisma.$transaction(async () =>
      explain(
        `SELECT * FROM "Report"
         WHERE "status" IN ('PENDING','REVIEWING')
         ORDER BY "createdAt" ASC, "id" ASC
         LIMIT 25`
      )
    );

    expect(plan).toMatch(/Index (Only )?Scan|Bitmap/);
    expect(plan).toContain('report_open_queue_idx');
  });

  it('serves the duplicate check from an index', async () => {
    const plan = await prisma.$transaction(async () =>
      explain(
        `SELECT * FROM "Report"
         WHERE "targetType" = 'BLOG' AND "targetId" = 'blog-1'
           AND "status" IN ('PENDING','REVIEWING')`
      )
    );

    expect(plan).toMatch(/Index (Only )?Scan|Bitmap/);
  });

  it("serves one account's audit record from an index", async () => {
    const plan = await prisma.$transaction(async () =>
      explain(
        `SELECT * FROM "ModerationAction"
         WHERE "subjectUserId" = 'whoever'
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT 25`
      )
    );

    expect(plan).toMatch(/Index (Only )?Scan|Bitmap/);
  });

  it('serves the history feed from the (createdAt, id) index', async () => {
    const plan = await prisma.$transaction(async () =>
      explain(
        `SELECT * FROM "ModerationAction"
         ORDER BY "createdAt" DESC, "id" DESC
         LIMIT 25`
      )
    );

    expect(plan).toMatch(/Index (Only )?Scan/);
  });
});

// ---------------------------------------------------------------------------
// The config and the SQL must agree
// ---------------------------------------------------------------------------

describe('open-status definition', () => {
  it('matches the predicate the partial indexes were built with', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>(
      Prisma.sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'report_open_queue_idx'`
    );

    expect(rows).toHaveLength(1);
    // Two expressions of one rule — TypeScript's and the index's. If they drift,
    // the queue silently stops using the index it was designed around.
    for (const status of OPEN_REPORT_STATUSES) {
      expect(rows[0]!.indexdef).toContain(status);
    }
  });
});
