import { logger } from '../../../core/utils/logger';
import { moderationService } from '../moderation.service';
import { auditRepository } from '../audit.repository';
import { reportRepository } from '../report.repository';
import { reportService } from '../report.service';
import { blogService } from '../../blog/blog.service';
import { commentService } from '../../comment/comment.service';
import { userService } from '../../user/user.service';

jest.mock('../audit.repository');
jest.mock('../report.repository');
jest.mock('../report.service');
jest.mock('../../blog/blog.service');
jest.mock('../../comment/comment.service');
jest.mock('../../user/user.service');

/**
 * Administrative actions, with every collaborator mocked.
 *
 * What is under test is the ORCHESTRATION, and it has exactly three
 * responsibilities: authorize, delegate to the owning module, record what
 * happened. The tests are arranged around those three, because each has a
 * distinct failure mode — a missing permission check is a privilege escalation,
 * a direct write would be a boundary violation, and a missing audit row is an
 * action nobody can account for.
 */

const audit = auditRepository as jest.Mocked<typeof auditRepository>;
const reports = reportRepository as jest.Mocked<typeof reportRepository>;
const reportSvc = reportService as jest.Mocked<typeof reportService>;
const blogs = blogService as jest.Mocked<typeof blogService>;
const comments = commentService as jest.Mocked<typeof commentService>;
const users = userService as jest.Mocked<typeof userService>;

const MOD = { userId: 'mod-1', role: 'MODERATOR' };
const ADMIN = { userId: 'admin-1', role: 'ADMIN' };
const USER = { userId: 'user-1', role: 'USER' };

const BLOG_SNAPSHOT = {
  id: 'blog-1',
  title: 'A Post',
  slug: 'a-post',
  authorId: 'author-1',
  isHidden: true,
  hiddenAt: new Date('2026-08-20'),
} as never;

const COMMENT_SNAPSHOT = {
  id: 'comment-1',
  blogId: 'blog-1',
  authorId: 'author-1',
  content: 'text',
  isHidden: true,
} as never;

const USER_SUMMARY = {
  id: 'target-1',
  username: 'target',
  name: 'Target',
  avatar: null,
  role: 'USER',
  status: 'SUSPENDED',
  isVerified: false,
  suspendedAt: new Date('2026-08-20'),
  suspendedReason: 'spam',
  createdAt: new Date('2026-01-01'),
  _count: { blogs: 2, comments: 3, followers: 4 },
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  blogs.hideForModeration.mockResolvedValue(BLOG_SNAPSHOT);
  blogs.restoreFromModeration.mockResolvedValue(BLOG_SNAPSHOT);
  blogs.deleteForModeration.mockResolvedValue(BLOG_SNAPSHOT);
  comments.hideForModeration.mockResolvedValue(COMMENT_SNAPSHOT);
  comments.restoreFromModeration.mockResolvedValue(COMMENT_SNAPSHOT);
  comments.deleteForModeration.mockResolvedValue(COMMENT_SNAPSHOT);
  users.suspend.mockResolvedValue(USER_SUMMARY);
  users.unsuspend.mockResolvedValue(USER_SUMMARY);
  users.getModerationSummary.mockResolvedValue(USER_SUMMARY);
  users.getPublicUserCards.mockResolvedValue(new Map());
  audit.record.mockResolvedValue({ id: 'action-1' } as never);
});

describe('authorization', () => {
  it('refuses a regular user every action, before touching anything', async () => {
    await expect(moderationService.hideBlog(USER, 'blog-1', {})).rejects.toMatchObject({
      statusCode: 403,
    });

    expect(blogs.hideForModeration).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a moderator the administrator-only removals', async () => {
    await expect(moderationService.deleteBlog(MOD, 'blog-1', {})).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      moderationService.deleteComment(MOD, 'comment-1', {})
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(blogs.deleteForModeration).not.toHaveBeenCalled();
    expect(comments.deleteForModeration).not.toHaveBeenCalled();
  });

  it('allows an administrator what it refuses a moderator', async () => {
    await moderationService.deleteBlog(ADMIN, 'blog-1', {});
    expect(blogs.deleteForModeration).toHaveBeenCalledWith('blog-1', ADMIN, undefined);
  });

  it.each([
    ['hideBlog', () => moderationService.hideBlog(MOD, 'blog-1', {})],
    ['restoreBlog', () => moderationService.restoreBlog(MOD, 'blog-1', {})],
    ['hideComment', () => moderationService.hideComment(MOD, 'comment-1', {})],
    ['restoreComment', () => moderationService.restoreComment(MOD, 'comment-1', {})],
    ['suspendUser', () => moderationService.suspendUser(MOD, 'target-1', {})],
    ['unsuspendUser', () => moderationService.unsuspendUser(MOD, 'target-1', {})],
  ])('allows a moderator to %s', async (_name, run) => {
    await expect(run()).resolves.toBeDefined();
  });
});

describe('delegation — moderation never writes another module\'s data', () => {
  it('hides a blog through the Blog module, passing the actor through unchanged', async () => {
    await moderationService.hideBlog(MOD, 'blog-1', { reason: 'spam' });
    expect(blogs.hideForModeration).toHaveBeenCalledWith('blog-1', MOD, 'spam');
  });

  it('suspends through the User module', async () => {
    await moderationService.suspendUser(MOD, 'target-1', { reason: 'abuse' });
    expect(users.suspend).toHaveBeenCalledWith('target-1', MOD, 'abuse');
  });

  it('records the audit row only AFTER the owning module succeeded', async () => {
    blogs.hideForModeration.mockRejectedValueOnce(
      Object.assign(new Error('already hidden'), { statusCode: 409 })
    );

    await expect(moderationService.hideBlog(MOD, 'blog-1', {})).rejects.toThrow();

    // An audit row for an action that did not happen is worse than no row: it
    // makes every other row untrustworthy.
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('the audit record', () => {
  it('attributes the action to the authenticated actor', async () => {
    await moderationService.hideBlog(MOD, 'blog-1', { reason: 'spam' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'mod-1',
        action: 'CONTENT_HIDDEN',
        targetType: 'BLOG',
        targetId: 'blog-1',
        reason: 'spam',
      })
    );
  });

  it('records the affected account, so one query answers "this user\'s record"', async () => {
    await moderationService.hideComment(MOD, 'comment-1', {});

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: 'author-1' })
    );
  });

  it.each([
    ['hideBlog', () => moderationService.hideBlog(ADMIN, 'blog-1', {}), 'CONTENT_HIDDEN'],
    ['restoreBlog', () => moderationService.restoreBlog(ADMIN, 'blog-1', {}), 'CONTENT_RESTORED'],
    ['deleteBlog', () => moderationService.deleteBlog(ADMIN, 'blog-1', {}), 'CONTENT_DELETED'],
    ['hideComment', () => moderationService.hideComment(ADMIN, 'comment-1', {}), 'CONTENT_HIDDEN'],
    ['restoreComment', () => moderationService.restoreComment(ADMIN, 'comment-1', {}), 'CONTENT_RESTORED'],
    ['deleteComment', () => moderationService.deleteComment(ADMIN, 'comment-1', {}), 'CONTENT_DELETED'],
    ['suspendUser', () => moderationService.suspendUser(ADMIN, 'target-1', {}), 'USER_SUSPENDED'],
    ['unsuspendUser', () => moderationService.unsuspendUser(ADMIN, 'target-1', {}), 'USER_UNSUSPENDED'],
  ])('%s writes exactly one audit row, of the right kind', async (_name, run, action) => {
    await run();

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action }));
  });

  it('does not fail the request when the audit write fails', async () => {
    // The content is ALREADY hidden at this point. Reporting failure would tell
    // the moderator to do it again. The compensating control is the error log.
    audit.record.mockRejectedValueOnce(new Error('database down'));

    await expect(moderationService.hideBlog(MOD, 'blog-1', {})).resolves.toBeDefined();
  });

  it('logs the whole entry loudly when it cannot be written', async () => {
    // The known limitation: the owning module's write has committed and this one
    // has not. This log line is then the ONLY surviving trace of the decision,
    // so it has to carry enough to reconstruct the row by hand — and a stable
    // `event` key to alert on, because a non-zero rate means the audit log is no
    // longer complete. See docs/MODERATION_MODULE.md § Known limitations.
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    audit.record.mockRejectedValueOnce(new Error('database down'));

    await moderationService.hideBlog(MOD, 'blog-1', { reason: 'spam', reportId: 'r-1' });

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'moderation.audit_write_failed',
        actorId: 'mod-1',
        action: 'CONTENT_HIDDEN',
        targetType: 'BLOG',
        targetId: 'blog-1',
        subjectUserId: 'author-1',
        reportId: 'r-1',
        reason: 'spam',
        err: expect.any(Error),
      }),
      expect.stringContaining('ACTION PERFORMED BUT NOT AUDITED')
    );
    error.mockRestore();
  });
});

describe('acting straight from a report', () => {
  it('closes the linked report after the action', async () => {
    await moderationService.hideBlog(MOD, 'blog-1', { reason: 'spam', reportId: 'r-1' });

    expect(reportSvc.closeAfterAction).toHaveBeenCalledWith(MOD, 'r-1', 'spam');
  });

  it('leaves the queue alone for a direct action with no report', async () => {
    await moderationService.hideBlog(MOD, 'blog-1', {});
    expect(reportSvc.closeAfterAction).not.toHaveBeenCalled();
  });
});

describe('read surfaces', () => {
  beforeEach(() => {
    reports.countByStatus.mockResolvedValue(3);
    reports.oldestOpenAt.mockResolvedValue(new Date('2026-08-01'));
    reports.groupOpenByReason.mockResolvedValue([{ reason: 'SPAM', count: 3 }]);
    reports.groupOpenByTargetType.mockResolvedValue([{ targetType: 'BLOG', count: 3 }]);
    reports.countOpenForOwner.mockResolvedValue(2);
    audit.countByActionSince.mockResolvedValue([{ action: 'CONTENT_HIDDEN', count: 5 }]);
    audit.recent.mockResolvedValue([]);
    audit.findForSubject.mockResolvedValue([]);
  });

  it('refuses the overview to a regular user', async () => {
    await expect(moderationService.getOverview(USER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('bounds the overview to open work and a recent window', async () => {
    const overview = await moderationService.getOverview(MOD);

    expect(overview.queue).toEqual({ pending: 3, reviewing: 3, oldestOpenAt: expect.any(Date) });
    expect(overview.activityWindowDays).toBeGreaterThan(0);

    // The activity window is a bounded range scan, never "all history".
    const since = audit.countByActionSince.mock.calls[0][0];
    expect(since.getTime()).toBeGreaterThan(Date.now() - 31 * 86_400_000);
  });

  it("reads a user's record across everything they own, not just their account row", async () => {
    await moderationService.getUserModeration(MOD, 'target-1');

    // `findForSubject`, not `findForTarget`: actions against their BLOGS and
    // COMMENTS are what "does this person have a history" actually means.
    expect(audit.findForSubject).toHaveBeenCalledWith('target-1', expect.any(Number));
    expect(audit.findForTarget).not.toHaveBeenCalled();
  });

  it('requires the history permission specifically', async () => {
    const query = { sort: 'desc' as const, limit: 25 };
    await expect(
      moderationService.getHistory({ userId: 'u', role: 'USER' }, query as never)
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
