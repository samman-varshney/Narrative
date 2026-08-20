import { onBlogPublished, onCommentCreated } from '../subscribers/content.subscriber';
import * as cache from '../moderation.cache';
import { reportService } from '../report.service';
import { activeContentModerationProvider } from '../providers';
import { blogService } from '../../blog/blog.service';
import { commentService } from '../../comment/comment.service';

jest.mock('../moderation.cache');
jest.mock('../report.service');
jest.mock('../../blog/blog.service');
jest.mock('../../comment/comment.service');

/**
 * Automated evaluation.
 *
 * The assertions are arranged around the ceiling this feature deliberately has:
 * the strongest thing an automated verdict can do is FILE A REPORT. Several
 * tests exist only to prove the absence of anything stronger.
 */

const guards = cache as jest.Mocked<typeof cache>;
const reports = reportService as jest.Mocked<typeof reportService>;
const blogs = blogService as jest.Mocked<typeof blogService>;
const comments = commentService as jest.Mocked<typeof commentService>;

const SPAM =
  'MAKE MONEY FAST verify your wallet https://a.example https://b.example https://c.example https://d.example free gift card click here to claim';

const blogSnapshot = (overrides: Partial<any> = {}): any => ({
  id: 'blog-1',
  title: 'Post',
  slug: 'post',
  subtitle: null,
  excerpt: 'a perfectly ordinary post about database indexes',
  status: 'PUBLISHED',
  visibility: 'PUBLIC',
  isHidden: false,
  hiddenAt: null,
  authorId: 'author-1',
  publishedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const commentSnapshot = (overrides: Partial<any> = {}): any => ({
  id: 'comment-1',
  blogId: 'blog-1',
  authorId: 'author-1',
  content: 'a perfectly ordinary comment',
  isHidden: false,
  isDeleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  guards.claimAutomatedSlot.mockResolvedValue(true);
  reports.createAutomatedReport.mockResolvedValue({ id: 'report-1' } as never);
  blogs.getModerationSnapshot.mockResolvedValue(blogSnapshot());
  comments.getModerationSnapshot.mockResolvedValue(commentSnapshot());
});

describe('what it does with spam', () => {
  it('files a report — and only a report — for a spam blog', async () => {
    blogs.getModerationSnapshot.mockResolvedValue(blogSnapshot({ excerpt: SPAM }));

    await onBlogPublished({ blogId: 'blog-1' });

    expect(reports.createAutomatedReport).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'BLOG',
        targetId: 'blog-1',
        targetOwnerId: 'author-1',
        reason: 'SPAM',
      })
    );

    // Nothing here can hide anything. That is the ceiling, and it is the
    // difference between this and "my post vanished and there was nobody to ask".
    expect(blogs.hideForModeration).not.toHaveBeenCalled();
    expect(blogs.deleteForModeration).not.toHaveBeenCalled();
  });

  it('records the provider, the score and the signals for the moderator', async () => {
    comments.getModerationSnapshot.mockResolvedValue(commentSnapshot({ content: SPAM }));

    await onCommentCreated({ commentId: 'comment-1' });

    const call = reports.createAutomatedReport.mock.calls[0]![0];
    expect(call.description).toContain('rule-based');
    expect(call.metadata).toMatchObject({
      provider: 'rule-based',
      score: expect.any(Number),
      signals: expect.arrayContaining(['many-links']),
    });
  });
});

describe('what it leaves alone', () => {
  it('files nothing for an ordinary post', async () => {
    await onBlogPublished({ blogId: 'blog-1' });
    expect(reports.createAutomatedReport).not.toHaveBeenCalled();
  });

  it('does not consume the guard for content it did not flag', async () => {
    // Otherwise a post edited from harmless into spam would never be scanned.
    await onBlogPublished({ blogId: 'blog-1' });
    expect(guards.claimAutomatedSlot).not.toHaveBeenCalled();
  });

  it('skips content a moderator has already acted on', async () => {
    blogs.getModerationSnapshot.mockResolvedValue(
      blogSnapshot({ excerpt: SPAM, isHidden: true })
    );
    await onBlogPublished({ blogId: 'blog-1' });

    // Re-flagging a decided case puts it back in the queue for no reason.
    expect(reports.createAutomatedReport).not.toHaveBeenCalled();
  });

  it('skips a deleted comment', async () => {
    comments.getModerationSnapshot.mockResolvedValue(
      commentSnapshot({ content: SPAM, isDeleted: true })
    );
    await onCommentCreated({ commentId: 'comment-1' });
    expect(reports.createAutomatedReport).not.toHaveBeenCalled();
  });

  it('respects the per-target guard, so a republish loop files one report', async () => {
    blogs.getModerationSnapshot.mockResolvedValue(blogSnapshot({ excerpt: SPAM }));
    guards.claimAutomatedSlot.mockResolvedValue(false);

    await onBlogPublished({ blogId: 'blog-1' });
    expect(reports.createAutomatedReport).not.toHaveBeenCalled();
  });
});

describe('failure is contained', () => {
  it('swallows a provider failure rather than failing the publish job', async () => {
    jest
      .spyOn(activeContentModerationProvider, 'evaluate')
      .mockRejectedValueOnce(new Error('provider exploded'));

    await expect(onBlogPublished({ blogId: 'blog-1' })).resolves.toBeUndefined();
  });

  it('swallows a vanished target', async () => {
    blogs.getModerationSnapshot.mockResolvedValue(null);
    await expect(onBlogPublished({ blogId: 'gone' })).resolves.toBeUndefined();
    expect(reports.createAutomatedReport).not.toHaveBeenCalled();
  });

  it('swallows a report-service failure', async () => {
    blogs.getModerationSnapshot.mockResolvedValue(blogSnapshot({ excerpt: SPAM }));
    reports.createAutomatedReport.mockRejectedValue(new Error('database down'));

    await expect(onBlogPublished({ blogId: 'blog-1' })).resolves.toBeUndefined();
  });

  it('ignores a malformed event payload', async () => {
    await expect(onBlogPublished({})).resolves.toBeUndefined();
    await expect(onCommentCreated({})).resolves.toBeUndefined();
    expect(blogs.getModerationSnapshot).not.toHaveBeenCalled();
    expect(comments.getModerationSnapshot).not.toHaveBeenCalled();
  });
});
