import { AppError } from '../../../core/exceptions/AppError';
import { AnalyticsService } from '../analytics.service';
import { AnalyticsRepository, type AnalyticsTotals } from '../analytics.repository';
import { blogService } from '../../blog/blog.service';
import { followRepository } from '../../follow/follow.repository';
import { resetGenerationMemo } from '../analytics.cache';
import { clearAnalyticsKeys } from './helpers';
import type { IAnalyticsIngestionService } from '../ingestion/IAnalyticsIngestionService';

/**
 * Service-layer behaviour: authorization, derived statistics, cursor handling.
 *
 * The repository and the sibling modules are mocked; SQL correctness is proven
 * in analytics.db.test.ts. What is under test here is the reasoning the service
 * does on top of the numbers — which is where a rate can be quietly wrong, or an
 * authorization check can quietly not run.
 *
 * The cache is left REAL (pointing at the test Redis) rather than mocked,
 * because it wraps every one of these methods. Mocking it away would mean none
 * of these tests exercise the path production actually takes.
 */

jest.mock('../../blog/blog.service', () => ({
  blogService: {
    getBlogMeta: jest.fn(),
    countBlogsByStatus: jest.fn(),
    canView: jest.fn(),
  },
}));

jest.mock('../../follow/follow.repository', () => ({
  followRepository: { countFollowers: jest.fn() },
}));

const mockedBlogService = blogService as jest.Mocked<typeof blogService>;
const mockedFollowRepository = followRepository as jest.Mocked<typeof followRepository>;

const AUTHOR: Parameters<AnalyticsService['getBlogOverview']>[1] = {
  userId: 'author-1',
  role: 'USER',
};
const ADMIN = { userId: 'admin-1', role: 'ADMIN' };
const STRANGER = { userId: 'stranger-1', role: 'USER' };

const BLOG_META = {
  id: 'blog-1',
  authorId: 'author-1',
  status: 'PUBLISHED' as const,
  visibility: 'PUBLIC' as const,
  title: 'A Post',
  slug: 'a-post',
  readingTimeMinutes: 8,
  publishedAt: new Date('2026-08-01T00:00:00.000Z'),
};

const totals = (overrides: Partial<AnalyticsTotals> = {}): AnalyticsTotals => ({
  views: 0,
  uniqueReaderDays: 0,
  readStarts: 0,
  readCompletions: 0,
  totalReadingSeconds: 0,
  bookmarks: 0,
  unbookmarks: 0,
  comments: 0,
  ...overrides,
});

/** A repository double with every method stubbed to an empty result. */
function stubRepository(overrides: Partial<AnalyticsRepository> = {}): AnalyticsRepository {
  return {
    getBlogTotals: jest.fn().mockResolvedValue(totals()),
    getBlogViewsSeries: jest.fn().mockResolvedValue([]),
    getBlogEngagementSeries: jest.fn().mockResolvedValue([]),
    getUserTotals: jest.fn().mockResolvedValue(totals()),
    getUserViewsSeries: jest.fn().mockResolvedValue([]),
    getUserEngagementSeries: jest.fn().mockResolvedValue([]),
    getUserFollowerTotals: jest
      .fn()
      .mockResolvedValue({ followersGained: 0, followersLost: 0, blogsPublished: 0 }),
    getUserFollowerSeries: jest.fn().mockResolvedValue([]),
    getTopBlogs: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as AnalyticsRepository;
}

const stubIngestion = (): jest.Mocked<IAnalyticsIngestionService> => ({
  recordEvent: jest.fn().mockResolvedValue({ outcome: 'recorded' }),
  recordBatch: jest.fn().mockResolvedValue([]),
});

/** Query defaults for the SERIES endpoints, which take a granularity. */
const QUERY = { granularity: 'day' as const };

/**
 * Query defaults for the TOTALS endpoints (`overview`, `reading`).
 *
 * Deliberately has no `granularity`: those endpoints collapse the range into a
 * single set of totals, so the parameter would be a knob that does nothing —
 * and the type reflects that.
 */
const TOTALS_QUERY = {};

describe('AnalyticsService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // Cache keys embed a generation and a digest of the query; clearing both the
    // keyspace and the memo keeps each test's reads independent.
    await clearAnalyticsKeys();
    resetGenerationMemo();

    mockedBlogService.getBlogMeta.mockResolvedValue(BLOG_META as never);
    mockedBlogService.countBlogsByStatus.mockResolvedValue({
      DRAFT: 1,
      PUBLISHED: 2,
      ARCHIVED: 1,
      DELETED: 3,
    });
    mockedBlogService.canView.mockReturnValue(true);
    mockedFollowRepository.countFollowers.mockResolvedValue(42);
  });

  afterAll(clearAnalyticsKeys);

  describe('blog authorization', () => {
    it('lets an author read their own blog’s analytics', async () => {
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      const overview = await service.getBlogOverview('blog-1', AUTHOR, TOTALS_QUERY);

      expect(overview.blogId).toBe('blog-1');
    });

    it('lets an ADMIN read any blog’s analytics', async () => {
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      await expect(service.getBlogOverview('blog-1', ADMIN, TOTALS_QUERY)).resolves.toBeDefined();
    });

    it('refuses a stranger with 404, never 403', async () => {
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      // 403 would confirm the id is real. For a DRAFT that is exactly the fact
      // its author relies on us not to leak, and the Blog module's own read path
      // takes the same position.
      const error = await service.getBlogOverview('blog-1', STRANGER, TOTALS_QUERY).catch((e) => e);

      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(404);
      expect(error.errorCode).toBe('BLOG_NOT_FOUND');
    });

    it('gives an identical error for a blog that does not exist', async () => {
      mockedBlogService.getBlogMeta.mockResolvedValue(null);
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      const error = await service.getBlogOverview('nope', AUTHOR, TOTALS_QUERY).catch((e) => e);

      expect(error.statusCode).toBe(404);
      expect(error.errorCode).toBe('BLOG_NOT_FOUND');
    });

    it('never queries analytics for a blog the caller may not see', async () => {
      const repository = stubRepository();
      const service = new AnalyticsService(repository, stubIngestion());

      await service.getBlogOverview('blog-1', STRANGER, TOTALS_QUERY).catch(() => undefined);

      expect(repository.getBlogTotals).not.toHaveBeenCalled();
    });

    it('applies the same check to every per-blog endpoint', async () => {
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      for (const call of [
        () => service.getBlogViews('blog-1', STRANGER, QUERY),
        () => service.getBlogEngagement('blog-1', STRANGER, QUERY),
        () => service.getBlogReading('blog-1', STRANGER, TOTALS_QUERY),
      ]) {
        await expect(call()).rejects.toMatchObject({ statusCode: 404 });
      }
    });
  });

  describe('user reports are scoped to the token', () => {
    it('reads the requester’s own id, never one from the request', async () => {
      const repository = stubRepository();
      const service = new AnalyticsService(repository, stubIngestion());

      await service.getUserViews(AUTHOR, QUERY);

      expect(repository.getUserViewsSeries).toHaveBeenCalledWith('author-1', expect.anything());
    });
  });

  describe('reading statistics', () => {
    it('computes the average over COMPLETED reads', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getBlogTotals: jest
            .fn()
            .mockResolvedValue(totals({ readCompletions: 4, totalReadingSeconds: 1_000 })),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const { reading } = await service.getBlogReading('blog-1', AUTHOR, TOTALS_QUERY);

      expect(reading.averageReadingSeconds).toBe(250);
    });

    it('computes completion and read-through rates', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getBlogTotals: jest
            .fn()
            .mockResolvedValue(totals({ views: 200, readStarts: 100, readCompletions: 25 })),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const { reading } = await service.getBlogReading('blog-1', AUTHOR, TOTALS_QUERY);

      // completion = completions / starts; read-through = completions / views.
      expect(reading.completionRate).toBe(0.25);
      expect(reading.readThroughRate).toBe(0.125);
    });

    it('reports null, not zero, when a rate has no denominator', async () => {
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      const { reading } = await service.getBlogReading('blog-1', AUTHOR, TOTALS_QUERY);

      // "No completion rate because nobody opened it" and "a 0% completion rate"
      // are different facts. Collapsing them puts a red 0% on a post that has
      // simply not been read yet.
      expect(reading.completionRate).toBeNull();
      expect(reading.readThroughRate).toBeNull();
      expect(reading.averageReadingSeconds).toBeNull();
    });

    it('does not round a rate away to nothing', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getBlogTotals: jest
            .fn()
            .mockResolvedValue(totals({ readStarts: 10_000, readCompletions: 3 })),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const { reading } = await service.getBlogReading('blog-1', AUTHOR, TOTALS_QUERY);

      expect(reading.completionRate).toBe(0.0003);
    });

    it('exposes the post’s own estimate alongside the measurement', async () => {
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      const result = await service.getBlogReading('blog-1', AUTHOR, TOTALS_QUERY);

      // So a client can chart measured-against-expected without a second call.
      expect(result.estimatedReadingMinutes).toBe(8);
    });
  });

  describe('overview composition', () => {
    it('reads blog and follower counts LIVE, not from aggregates', async () => {
      const repository = stubRepository();
      const service = new AnalyticsService(repository, stubIngestion());

      const overview = await service.getUserOverview(AUTHOR, TOTALS_QUERY);

      // Summed deltas drift permanently and invisibly the moment one is lost.
      // The headline number has to be exactly right.
      expect(overview.followers).toBe(42);
      expect(overview.publishedBlogs).toBe(2);
      expect(mockedFollowRepository.countFollowers).toHaveBeenCalledWith('author-1');
    });

    it('excludes DELETED blogs from the total', async () => {
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      const overview = await service.getUserOverview(AUTHOR, TOTALS_QUERY);

      // 1 draft + 2 published + 1 archived; the 3 deleted are trash, not work.
      expect(overview.totalBlogs).toBe(4);
    });

    it('reports net bookmarks alongside the gross count', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getUserTotals: jest.fn().mockResolvedValue(totals({ bookmarks: 10, unbookmarks: 4 })),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const overview = await service.getUserOverview(AUTHOR, TOTALS_QUERY);

      expect(overview.bookmarks).toBe(10);
      expect(overview.netBookmarks).toBe(6);
    });
  });

  /**
   * The rule these pin: an exact unique-reader count exists only for a window of
   * one day, because distinct readers are counted with one HyperLogLog per day
   * and two days' counts cannot be added without double-counting whoever
   * returned. Anything wider reports reader-days and `null`.
   *
   * Worth testing at this layer rather than only end-to-end, because the failure
   * mode is a plausible number rather than an error — the previous shape summed
   * daily uniques and published the result as "unique views", inflating a 30-day
   * dashboard by every returning reader.
   */
  describe('unique readers vs reader-days', () => {
    const viewsTotals = totals({ views: 100, uniqueReaderDays: 60 });

    it('withholds the exact count over a multi-day range', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getUserTotals: jest.fn().mockResolvedValue(viewsTotals),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const overview = await service.getUserOverview(AUTHOR, {
        startDate: '2026-08-01',
        endDate: '2026-08-10',
      });

      expect(overview.uniqueReaderDays).toBe(60);
      expect(overview.uniqueViews).toBeNull();
    });

    it('reports the exact count when the range is a single day', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getUserTotals: jest.fn().mockResolvedValue(viewsTotals),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const overview = await service.getUserOverview(AUTHOR, {
        startDate: '2026-08-01',
        endDate: '2026-08-01',
      });

      expect(overview.uniqueViews).toBe(60);
      expect(overview.uniqueReaderDays).toBe(60);
    });

    it('withholds the exact count per-bucket above daily granularity', async () => {
      const getUserViewsSeries = jest
        .fn()
        .mockResolvedValue([
          { date: new Date('2026-07-27T00:00:00.000Z'), views: 40, uniqueReaderDays: 25 },
        ]);
      const service = new AnalyticsService(
        stubRepository({ getUserViewsSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const weekly = await service.getUserViews(AUTHOR, {
        granularity: 'week',
        startDate: '2026-07-27',
        endDate: '2026-08-10',
      });
      const daily = await service.getUserViews(AUTHOR, {
        granularity: 'day',
        startDate: '2026-07-27',
        endDate: '2026-08-10',
      });

      // Same column, same value, different meaning — which is exactly why they
      // are different fields.
      expect(weekly.points[0]?.uniqueReaderDays).toBe(25);
      expect(weekly.points[0]?.uniqueViews).toBeNull();
      expect(daily.points[0]?.uniqueViews).toBe(25);
    });

    it('ranks top blogs by reader-days, since no per-day figure exists to rank on', async () => {
      const getTopBlogs = jest.fn().mockResolvedValue([]);
      const service = new AnalyticsService(
        stubRepository({ getTopBlogs } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      await service.getUserTopBlogs(AUTHOR, {
        ...QUERY,
        metric: 'uniqueReaderDays',
        limit: 10,
      });

      expect(getTopBlogs).toHaveBeenCalledWith(
        'author-1',
        expect.anything(),
        'uniqueReaderDays',
        10,
        undefined
      );
    });
  });

  describe('top blogs', () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_unused, i) => ({
        blogId: `blog-${i}`,
        title: `Post ${i}`,
        slug: `post-${i}`,
        publishedAt: null,
        views: 100 - i,
        uniqueReaderDays: 50,
        netBookmarks: 1,
        comments: 0,
        readCompletions: 0,
        metricValue: 100 - i,
      }));

    it('trims the sentinel row and reports hasNextPage', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getTopBlogs: jest.fn().mockResolvedValue(rows(4)),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const result = await service.getUserTopBlogs(AUTHOR, {
        ...QUERY,
        metric: 'views',
        limit: 3,
      });

      // limit + 1 fetched; the extra row is the has-more signal, never content.
      expect(result.items).toHaveLength(3);
      expect(result.hasNextPage).toBe(true);
      expect(result.nextCursor).toBeTruthy();
    });

    it('returns no cursor on the last page', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getTopBlogs: jest.fn().mockResolvedValue(rows(2)),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const result = await service.getUserTopBlogs(AUTHOR, {
        ...QUERY,
        metric: 'views',
        limit: 3,
      });

      expect(result.hasNextPage).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('rejects a cursor minted for a different metric', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getTopBlogs: jest.fn().mockResolvedValue(rows(4)),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const first = await service.getUserTopBlogs(AUTHOR, {
        ...QUERY,
        metric: 'views',
        limit: 3,
      });

      // Paging a views ranking into a comments ranking would compare 100
      // against a comment-count distribution and return an arbitrary slice.
      await expect(
        service.getUserTopBlogs(AUTHOR, {
          ...QUERY,
          metric: 'comments',
          limit: 3,
          cursor: first.nextCursor!,
        })
      ).rejects.toMatchObject({ errorCode: 'INVALID_CURSOR' });
    });

    it('rejects another author’s cursor', async () => {
      const service = new AnalyticsService(
        stubRepository({
          getTopBlogs: jest.fn().mockResolvedValue(rows(4)),
        } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const first = await service.getUserTopBlogs(AUTHOR, {
        ...QUERY,
        metric: 'views',
        limit: 3,
      });

      await expect(
        service.getUserTopBlogs(
          { userId: 'someone-else', role: 'USER' },
          { ...QUERY, metric: 'views', limit: 3, cursor: first.nextCursor! }
        )
      ).rejects.toMatchObject({ errorCode: 'INVALID_CURSOR' });
    });

    it('validates the cursor BEFORE consulting the cache', async () => {
      const getTopBlogs = jest.fn().mockResolvedValue([]);
      const service = new AnalyticsService(
        stubRepository({ getTopBlogs } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      await expect(
        service.getUserTopBlogs(AUTHOR, {
          ...QUERY,
          metric: 'views',
          limit: 3,
          cursor: 'total-garbage',
        })
      ).rejects.toMatchObject({ errorCode: 'INVALID_CURSOR' });

      // A bad cursor must be a 400, not a cache miss that quietly returns page
      // one as though the client had never paged at all.
      expect(getTopBlogs).not.toHaveBeenCalled();
    });
  });

  describe('reading telemetry ingestion', () => {
    const input = {
      event: 'BLOG_READ_STARTED' as const,
      sessionId: 'session-aaaaaaaaaaaa',
      anonymousId: 'anon-aaaaaaaaaaaaa',
    };

    it('hands a well-formed analytics event to the ingestion service', async () => {
      const ingestion = stubIngestion();
      const service = new AnalyticsService(stubRepository(), ingestion);

      await service.recordReadingProgress('blog-1', input, undefined, 'evt-1');

      expect(ingestion.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt-1',
          eventType: 'BLOG_READ_STARTED',
          entityType: 'BLOG',
          entityId: 'blog-1',
          ownerId: 'author-1',
          anonymousId: 'anon-aaaaaaaaaaaaa',
          metadata: { kind: 'read', sessionId: 'session-aaaaaaaaaaaa' },
        })
      );
    });

    it('stamps the event with SERVER time', async () => {
      const ingestion = stubIngestion();
      const service = new AnalyticsService(stubRepository(), ingestion);
      const before = Date.now();

      await service.recordReadingProgress('blog-1', input, undefined, 'evt-1');

      // A client-supplied timestamp decides which DAY the read lands in, so
      // trusting it would let a caller write into any bucket — including days
      // that have already been reported on.
      const occurredAt = ingestion.recordEvent.mock.calls[0]?.[0].occurredAt as Date;
      expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('prefers the authenticated user over a supplied anonymous id', async () => {
      const ingestion = stubIngestion();
      const service = new AnalyticsService(stubRepository(), ingestion);

      await service.recordReadingProgress('blog-1', input, STRANGER, 'evt-1');

      // Otherwise a signed-in reader could attribute their reading to someone
      // else's anonymous identity.
      const event = ingestion.recordEvent.mock.calls[0]?.[0];
      expect(event?.userId).toBe('stranger-1');
      expect(event?.anonymousId).toBeUndefined();
    });

    it('tells an anonymous caller that anonymousId is required', async () => {
      const ingestion = stubIngestion();
      const service = new AnalyticsService(stubRepository(), ingestion);
      const { anonymousId: _omitted, ...withoutId } = input;

      // A defect in the caller's own request, not a fact about what was
      // counted — so reporting it leaks nothing, and its absence would leave a
      // broken client sending no-ops and seeing 202 forever.
      await expect(
        service.recordReadingProgress('blog-1', withoutId, undefined, 'evt-1')
      ).rejects.toMatchObject({ statusCode: 400, errorCode: 'ANONYMOUS_ID_REQUIRED' });
      expect(ingestion.recordEvent).not.toHaveBeenCalled();
    });

    it('does not require anonymousId from a signed-in caller', async () => {
      const ingestion = stubIngestion();
      const service = new AnalyticsService(stubRepository(), ingestion);
      const { anonymousId: _omitted, ...withoutId } = input;

      await expect(
        service.recordReadingProgress('blog-1', withoutId, STRANGER, 'evt-1')
      ).resolves.toBeUndefined();
    });

    it('refuses telemetry for a blog the reader cannot see', async () => {
      mockedBlogService.canView.mockReturnValue(false);
      const ingestion = stubIngestion();
      const service = new AnalyticsService(stubRepository(), ingestion);

      // Without this the endpoint is an id-enumeration oracle for every blog.
      await expect(
        service.recordReadingProgress('blog-1', input, undefined, 'evt-1')
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(ingestion.recordEvent).not.toHaveBeenCalled();
    });

    it('refuses telemetry for a blog that does not exist', async () => {
      mockedBlogService.getBlogMeta.mockResolvedValue(null);
      const service = new AnalyticsService(stubRepository(), stubIngestion());

      await expect(
        service.recordReadingProgress('nope', input, undefined, 'evt-1')
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('does not surface a rejected event to the caller', async () => {
      const ingestion = stubIngestion();
      ingestion.recordEvent.mockResolvedValue({ outcome: 'duplicate-event' });
      const service = new AnalyticsService(stubRepository(), ingestion);

      // A client that could tell "counted" from "deduplicated" could probe the
      // dedupe state, and there is nothing useful it would do with the answer.
      await expect(
        service.recordReadingProgress('blog-1', input, undefined, 'evt-1')
      ).resolves.toBeUndefined();
    });
  });

  describe('caching', () => {
    it('serves a repeated identical request from cache', async () => {
      const getUserViewsSeries = jest.fn().mockResolvedValue([]);
      const service = new AnalyticsService(
        stubRepository({ getUserViewsSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      await service.getUserViews(AUTHOR, { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' });
      await service.getUserViews(AUTHOR, { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' });

      expect(getUserViewsSeries).toHaveBeenCalledTimes(1);
    });

    it('does not share an entry across different ranges', async () => {
      const getUserViewsSeries = jest.fn().mockResolvedValue([]);
      const service = new AnalyticsService(
        stubRepository({ getUserViewsSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      await service.getUserViews(AUTHOR, { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' });
      await service.getUserViews(AUTHOR, { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-11' });

      expect(getUserViewsSeries).toHaveBeenCalledTimes(2);
    });

    it('does not share an entry across granularities', async () => {
      const getUserViewsSeries = jest.fn().mockResolvedValue([]);
      const service = new AnalyticsService(
        stubRepository({ getUserViewsSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const base = { startDate: '2026-08-01', endDate: '2026-08-10' };
      await service.getUserViews(AUTHOR, { ...base, granularity: 'day' });
      await service.getUserViews(AUTHOR, { ...base, granularity: 'week' });

      expect(getUserViewsSeries).toHaveBeenCalledTimes(2);
    });

    it('returns an IDENTICAL, well-formed payload on a cache hit', async () => {
      // The regression this exists for: a cached value round-trips through
      // JSON, which turns every Date into a string. Caching raw database rows
      // worked on the miss and threw `row.date.toISOString is not a function`
      // on every hit — so the endpoint failed only on its second call, which no
      // test using an empty result set could ever see.
      const getUserViewsSeries = jest.fn().mockResolvedValue([
        { date: new Date('2026-08-01T00:00:00.000Z'), views: 5, uniqueReaderDays: 3 },
        { date: new Date('2026-08-02T00:00:00.000Z'), views: 7, uniqueReaderDays: 4 },
      ]);
      const service = new AnalyticsService(
        stubRepository({ getUserViewsSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const params = { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' };
      const miss = await service.getUserViews(AUTHOR, params);
      const hit = await service.getUserViews(AUTHOR, params);

      expect(getUserViewsSeries).toHaveBeenCalledTimes(1);
      expect(hit.points).toEqual(miss.points);
      expect(hit.points[0]).toEqual({
        date: '2026-08-01',
        views: 5,
        uniqueReaderDays: 3,
        uniqueViews: 3,
      });
    });

    it('returns a well-formed engagement series on a cache hit', async () => {
      const getUserEngagementSeries = jest.fn().mockResolvedValue([
        {
          date: new Date('2026-08-01T00:00:00.000Z'),
          bookmarks: 4,
          unbookmarks: 1,
          netBookmarks: 3,
          comments: 2,
        },
      ]);
      const service = new AnalyticsService(
        stubRepository({ getUserEngagementSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const params = { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' };
      await service.getUserEngagement(AUTHOR, params);
      const hit = await service.getUserEngagement(AUTHOR, params);

      expect(hit.points[0]?.date).toBe('2026-08-01');
    });

    it('returns a well-formed follower series on a cache hit', async () => {
      const getUserFollowerSeries = jest
        .fn()
        .mockResolvedValue([
          { date: new Date('2026-08-01T00:00:00.000Z'), gained: 3, lost: 1, net: 2 },
        ]);
      const service = new AnalyticsService(
        stubRepository({ getUserFollowerSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const params = { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' };
      await service.getUserFollowers(AUTHOR, params);
      const hit = await service.getUserFollowers(AUTHOR, params);

      expect(hit.points[0]?.date).toBe('2026-08-01');
      expect(hit.currentFollowers).toBe(42);
    });

    it('returns well-formed top blogs on a cache hit', async () => {
      // `publishedAt` is the Date here, and it is nullable — both shapes have to
      // survive the round trip.
      const getTopBlogs = jest.fn().mockResolvedValue([
        {
          blogId: 'blog-1',
          title: 'A Post',
          slug: 'a-post',
          publishedAt: new Date('2026-08-01T00:00:00.000Z'),
          views: 10,
          uniqueReaderDays: 8,
          netBookmarks: 1,
          comments: 0,
          readCompletions: 0,
          metricValue: 10,
        },
      ]);
      const service = new AnalyticsService(
        stubRepository({ getTopBlogs } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const params = { ...QUERY, metric: 'views' as const, limit: 10 };
      const miss = await service.getUserTopBlogs(AUTHOR, params);
      const hit = await service.getUserTopBlogs(AUTHOR, params);

      expect(getTopBlogs).toHaveBeenCalledTimes(1);
      expect(hit.items).toEqual(miss.items);
      expect(hit.items[0]?.publishedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(hit.hasNextPage).toBe(false);
    });

    it('is JSON-serializable on both miss and hit', async () => {
      const getUserViewsSeries = jest
        .fn()
        .mockResolvedValue([
          { date: new Date('2026-08-01T00:00:00.000Z'), views: 5, uniqueReaderDays: 3 },
        ]);
      const service = new AnalyticsService(
        stubRepository({ getUserViewsSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const params = { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' };
      const miss = await service.getUserViews(AUTHOR, params);
      const hit = await service.getUserViews(AUTHOR, params);

      expect(JSON.stringify(miss.points)).toBe(JSON.stringify(hit.points));
    });

    it('does not leak one author’s report to another', async () => {
      const getUserViewsSeries = jest.fn().mockResolvedValue([]);
      const service = new AnalyticsService(
        stubRepository({ getUserViewsSeries } as Partial<AnalyticsRepository>),
        stubIngestion()
      );

      const range = { ...QUERY, startDate: '2026-08-01', endDate: '2026-08-10' };
      await service.getUserViews(AUTHOR, range);
      await service.getUserViews({ userId: 'author-2', role: 'USER' }, range);

      expect(getUserViewsSeries).toHaveBeenCalledTimes(2);
      expect(getUserViewsSeries).toHaveBeenLastCalledWith('author-2', expect.anything());
    });
  });
});
