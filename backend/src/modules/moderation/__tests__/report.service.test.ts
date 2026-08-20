import { Prisma } from '@prisma/client';
import { reportService } from '../report.service';
import { reportRepository } from '../report.repository';
import { auditRepository } from '../audit.repository';
import * as cache from '../moderation.cache';
import * as hydration from '../moderation.hydration';
import { runModerationTransaction } from '../moderation.transaction';
import { eventBus, EVENTS } from '../../../core/events/eventBus';

jest.mock('../report.repository');
jest.mock('../audit.repository');
jest.mock('../moderation.cache');
jest.mock('../moderation.hydration');
jest.mock('../moderation.transaction');
jest.mock('../../../core/events/eventBus', () => ({
  eventBus: { emit: jest.fn() },
  EVENTS: jest.requireActual('../../../core/events/eventBus').EVENTS,
}));

/**
 * The report lifecycle, with every collaborator mocked.
 *
 * The through-line of this suite is the property that makes reporting safe:
 * filing a report changes nothing. Nothing here hides content, and the tests
 * assert on what is NOT called as often as on what is.
 */

const repo = reportRepository as jest.Mocked<typeof reportRepository>;
const audit = auditRepository as jest.Mocked<typeof auditRepository>;
const guards = cache as jest.Mocked<typeof cache>;
const targets = hydration as jest.Mocked<typeof hydration>;
const tx = runModerationTransaction as jest.MockedFunction<typeof runModerationTransaction>;
const bus = eventBus as jest.Mocked<typeof eventBus>;

const REPORTER = 'reporter-1';
const MOD = { userId: 'mod-1', role: 'MODERATOR' };
const USER = { userId: 'user-1', role: 'USER' };

const report = (overrides: Partial<any> = {}): any => ({
  id: 'report-1',
  reporterId: REPORTER,
  source: 'USER',
  targetType: 'BLOG',
  targetId: 'blog-1',
  targetOwnerId: 'author-1',
  reason: 'SPAM',
  description: null,
  status: 'PENDING',
  assignedToId: null,
  assignedAt: null,
  resolvedById: null,
  resolvedAt: null,
  resolutionReason: null,
  metadata: null,
  createdAt: new Date('2026-08-20T10:00:00Z'),
  updatedAt: new Date('2026-08-20T10:00:00Z'),
  ...overrides,
});

const input = { targetType: 'BLOG' as const, targetId: 'blog-1', reason: 'SPAM' as const };

beforeEach(() => {
  jest.clearAllMocks();
  guards.claimReportSlot.mockResolvedValue(true);
  guards.releaseReportSlot.mockResolvedValue(undefined);
  targets.resolveTargetOwner.mockResolvedValue({ ownerId: 'author-1' });
  targets.loadUserCards.mockResolvedValue(new Map());
  targets.loadTarget.mockResolvedValue({ kind: 'MISSING', id: 'blog-1', targetType: 'BLOG' });
  repo.findOpenByReporterForTarget.mockResolvedValue(null);
  repo.findOpenAutomatedForTarget.mockResolvedValue(null);
  repo.create.mockResolvedValue(report());
  repo.findById.mockResolvedValue(report());
  repo.countOpenForTarget.mockResolvedValue(1);
  repo.page.mockImplementation((rows: any[], limit: number) => ({
    items: rows.slice(0, limit),
    hasNextPage: rows.length > limit,
    last: rows[Math.min(rows.length, limit) - 1] ?? null,
  }));
  audit.findForReport.mockResolvedValue([]);
  audit.record.mockResolvedValue({ id: 'action-1' } as never);
  // Run the transaction body against a stand-in client.
  tx.mockImplementation(async (fn: any) => fn({} as never));
});

describe('filing a report', () => {
  it('attributes the report to the authenticated reporter', async () => {
    await reportService.createReport(REPORTER, input);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ reporterId: REPORTER, source: 'USER' })
    );
  });

  it('denormalizes the target owner so the queue needs no per-row join', async () => {
    await reportService.createReport(REPORTER, input);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetOwnerId: 'author-1' })
    );
  });

  it('changes nothing about the content it reports', async () => {
    await reportService.createReport(REPORTER, input);

    // A report is a request for review. If filing one could hide anything, a
    // brigade would be the platform's moderation interface.
    expect(audit.record).not.toHaveBeenCalled();
    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith(
      EVENTS.REPORT_CREATED,
      expect.objectContaining({ reportId: 'report-1', reporterId: REPORTER })
    );
  });

  it('refuses a self-report on an account without any I/O', async () => {
    await expect(
      reportService.createReport(REPORTER, {
        targetType: 'USER',
        targetId: REPORTER,
        reason: 'SPAM',
      })
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'INVALID_TARGET' });

    expect(guards.claimReportSlot).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses a report on your own content, and frees the guard', async () => {
    targets.resolveTargetOwner.mockResolvedValue({ ownerId: REPORTER });

    await expect(reportService.createReport(REPORTER, input)).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'INVALID_TARGET',
    });

    // Nothing was stored, so the reporter must not be locked out of reporting
    // that target for the guard's whole TTL.
    expect(guards.releaseReportSlot).toHaveBeenCalledWith(REPORTER, 'BLOG', 'blog-1');
  });

  it('404s a target that does not exist, and frees the guard', async () => {
    targets.resolveTargetOwner.mockResolvedValue(null);

    await expect(reportService.createReport(REPORTER, input)).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'TARGET_NOT_FOUND',
    });
    expect(guards.releaseReportSlot).toHaveBeenCalled();
  });
});

describe('duplicate suppression', () => {
  it('answers a repeat submission from Redis, without touching the database', async () => {
    guards.claimReportSlot.mockResolvedValue(false);

    await expect(reportService.createReport(REPORTER, input)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'DUPLICATE_REPORT',
    });

    expect(repo.findOpenByReporterForTarget).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses a second report while the first is still open', async () => {
    repo.findOpenByReporterForTarget.mockResolvedValue(report({ status: 'REVIEWING' }));

    await expect(reportService.createReport(REPORTER, input)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'DUPLICATE_REPORT',
    });
  });

  it('turns the unique-index violation into the same 409', async () => {
    // Two simultaneous submissions both pass the pre-check; the partial unique
    // index settles it. From the reporter's side it is the same situation.
    repo.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '7',
      })
    );

    await expect(reportService.createReport(REPORTER, input)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'DUPLICATE_REPORT',
    });
  });

  it('releases the guard when the insert fails for any OTHER reason', async () => {
    repo.create.mockRejectedValue(new Error('connection reset'));

    await expect(reportService.createReport(REPORTER, input)).rejects.toThrow('connection reset');
    expect(guards.releaseReportSlot).toHaveBeenCalled();
  });
});

describe('automated reports', () => {
  it('files one with no reporter and the provider signals attached', async () => {
    repo.create.mockResolvedValue(report({ reporterId: null, source: 'AUTOMATED' }));

    await reportService.createAutomatedReport({
      targetType: 'BLOG',
      targetId: 'blog-1',
      targetOwnerId: 'author-1',
      reason: 'SPAM',
      description: 'Flagged automatically',
      metadata: { provider: 'rule-based', score: 0.9 },
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        reporterId: null,
        source: 'AUTOMATED',
        metadata: expect.objectContaining({ provider: 'rule-based' }),
      })
    );
  });

  it('does not file a second one while the first is still open', async () => {
    repo.findOpenAutomatedForTarget.mockResolvedValue(report({ source: 'AUTOMATED' }));

    const result = await reportService.createAutomatedReport({
      targetType: 'BLOG',
      targetId: 'blog-1',
      targetOwnerId: 'author-1',
      reason: 'SPAM',
      description: 'again',
      metadata: {},
    });

    expect(result).toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
  });
});

describe('the queue', () => {
  it('is refused to a regular user', async () => {
    await expect(
      reportService.listReports(USER, { sort: 'asc', limit: 25 } as never)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('defaults to open reports, oldest first — a work queue drains FIFO', async () => {
    repo.list.mockResolvedValue([report()]);

    await reportService.listReports(MOD, { sort: 'asc', limit: 25 } as never);

    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['PENDING', 'REVIEWING'] }),
      expect.objectContaining({ sort: 'asc', limit: 25 })
    );
  });

  it('fetches limit + 1 and only emits a cursor when there is another page', async () => {
    repo.list.mockResolvedValue([report({ id: 'a' })]);
    const page = await reportService.listReports(MOD, { sort: 'asc', limit: 25 } as never);

    expect(page.hasNextPage).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('hydrates every user on the page in ONE lookup', async () => {
    repo.list.mockResolvedValue([
      report({ id: 'a', reporterId: 'r1', targetOwnerId: 'o1' }),
      report({ id: 'b', reporterId: 'r2', targetOwnerId: 'o2' }),
    ]);

    await reportService.listReports(MOD, { sort: 'asc', limit: 25 } as never);

    // The N+1 a polymorphic target invites: two lookups per row, times a page.
    expect(targets.loadUserCards).toHaveBeenCalledTimes(1);
    expect(targets.loadUserCards).toHaveBeenCalledWith(
      expect.arrayContaining(['r1', 'o1', 'r2', 'o2'])
    );
  });

  it('excludes the report itself from its own "others have reported this" count', async () => {
    repo.countOpenForTarget.mockResolvedValue(3);
    const detail = await reportService.getReport(MOD, 'report-1');
    expect(detail.relatedOpenReports).toBe(2);
  });
});

describe('triage', () => {
  it('requires reports:review to claim', async () => {
    await expect(reportService.claimReport(USER, 'report-1')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repo.claim).not.toHaveBeenCalled();
  });

  it('writes the claim and its audit row in one transaction', async () => {
    repo.claim.mockResolvedValue(true);

    await reportService.claimReport(MOD, 'report-1');

    expect(tx).toHaveBeenCalledTimes(1);
    expect(repo.claim).toHaveBeenCalledWith('report-1', 'mod-1', expect.anything());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'mod-1', action: 'REPORT_CLAIMED' }),
      expect.anything()
    );
  });

  it('tells the losing moderator the report is already taken', async () => {
    // The conditional UPDATE matched no row: someone else claimed it first.
    repo.claim.mockResolvedValue(false);

    await expect(reportService.claimReport(MOD, 'report-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'REPORT_NOT_PENDING',
    });
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it('resolves and dismisses through the same guarded path', async () => {
    repo.close.mockResolvedValue(true);

    await reportService.resolveReport(MOD, 'report-1', { reason: 'hidden the post' });
    expect(repo.close).toHaveBeenCalledWith(
      'report-1',
      'RESOLVED',
      'mod-1',
      'hidden the post',
      expect.anything()
    );
    expect(bus.emit).toHaveBeenCalledWith(EVENTS.REPORT_RESOLVED, expect.any(Object));

    jest.clearAllMocks();
    tx.mockImplementation(async (fn: any) => fn({} as never));
    repo.close.mockResolvedValue(true);
    repo.findById.mockResolvedValue(report());
    repo.page.mockImplementation((rows: any[], limit: number) => ({
      items: rows,
      hasNextPage: false,
      last: null,
    }));
    audit.findForReport.mockResolvedValue([]);

    await reportService.dismissReport(MOD, 'report-1', {});
    expect(repo.close).toHaveBeenCalledWith('report-1', 'DISMISSED', 'mod-1', null, expect.anything());
    expect(bus.emit).toHaveBeenCalledWith(EVENTS.REPORT_DISMISSED, expect.any(Object));
  });

  it('refuses to overwrite a closed report', async () => {
    repo.close.mockResolvedValue(false);

    await expect(
      reportService.resolveReport(MOD, 'report-1', {})
    ).rejects.toMatchObject({ statusCode: 409, errorCode: 'REPORT_ALREADY_CLOSED' });
  });

  it('404s an unknown report', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(reportService.getReport(MOD, 'nope')).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'REPORT_NOT_FOUND',
    });
  });
});

describe('closing a report after an action', () => {
  it('never throws — the action already succeeded', async () => {
    repo.close.mockRejectedValue(new Error('database down'));

    await expect(
      reportService.closeAfterAction(MOD, 'report-1', 'hidden')
    ).resolves.toBeUndefined();
  });

  it('does nothing further when someone else already closed it', async () => {
    repo.close.mockResolvedValue(false);

    await reportService.closeAfterAction(MOD, 'report-1', 'hidden');

    expect(audit.record).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
  });
});
