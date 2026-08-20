import { prisma } from '../../../core/database/prisma';
import { redis } from '../../../core/providers/redis';
import { resetDb, disconnectDb, makeUser, makeBlog } from '../../../test/db';
import { AnalyticsBuffer } from '../analytics.buffer';
import { AnalyticsBlogResolver } from '../analytics.resolver';
import { RedisAnalyticsIngestionService } from '../ingestion/RedisAnalyticsIngestionService';
import { PostgresAnalyticsStore } from '../store/PostgresAnalyticsStore';
import type { IAnalyticsStore } from '../store/IAnalyticsStore';
import { runFlush, runPrune } from '../analytics.worker';
import { currentGeneration, resetGenerationMemo } from '../analytics.cache';
import { DIRTY_SET_KEY, uniqueViewersKey } from '../analytics.keys';
import { clearAnalyticsKeys, todayKey } from './helpers';
import type { AnalyticsEvent } from '../analytics.types';

/**
 * The whole pipeline, end to end, against real Redis and real PostgreSQL:
 *
 *   analytics event → Redis buffer → atomic drain → batch UPSERT → daily rows
 *
 * This is the suite that matters most. Every individual piece is testable in
 * isolation and each one passes in isolation; the failures that actually cost
 * data live in the SEAMS — a drain that loses a concurrent increment, a retry
 * that double-counts, a HyperLogLog added where it should be taken as absolute.
 * None of those are visible without both stores present and real.
 */

const TODAY = todayKey();

let authorId: string;
let blogId: string;
let readerId: string;

const buffer = new AnalyticsBuffer(redis);
const store = new PostgresAnalyticsStore();

function ingestion() {
  return new RedisAnalyticsIngestionService(redis, buffer, new AnalyticsBlogResolver(redis));
}

let counter = 0;
const nextEventId = () => `flush-evt-${Date.now()}-${++counter}`;

function view(userId: string): AnalyticsEvent {
  return {
    eventId: nextEventId(),
    eventType: 'BLOG_VIEWED',
    occurredAt: new Date(),
    entityType: 'BLOG',
    entityId: blogId,
    ownerId: authorId,
    userId,
  };
}

/** The stored daily row for the blog, or null if nothing has been flushed. */
async function storedBlogRow() {
  return prisma.blogAnalyticsDaily.findUnique({
    where: { blogId_date: { blogId, date: new Date(`${TODAY}T00:00:00.000Z`) } },
  });
}

describe('analytics flush pipeline (real Redis + PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDb();
    await clearAnalyticsKeys();
    resetGenerationMemo();

    const author = await makeUser();
    const reader = await makeUser();
    const blog = await makeBlog(author.id, { readingTimeMinutes: 10 });

    authorId = author.id;
    readerId = reader.id;
    blogId = blog.id;
  });

  afterAll(async () => {
    await clearAnalyticsKeys();
    await disconnectDb();
  });

  it('moves buffered views into a daily row', async () => {
    const service = ingestion();
    await service.recordEvent(view(readerId));
    await service.recordEvent(view('reader-2'));
    await service.recordEvent(view('reader-3'));

    // Nothing in PostgreSQL yet — that is the whole point of the buffer.
    expect(await storedBlogRow()).toBeNull();

    const summary = await runFlush(buffer, store);

    expect(summary.blogRows).toBe(1);
    const row = await storedBlogRow();
    expect(row).toMatchObject({ blogId, authorId, views: 3, uniqueViews: 3 });
  });

  it('leaves the buffer empty and the bucket clean after a flush', async () => {
    const service = ingestion();
    await service.recordEvent(view(readerId));

    await runFlush(buffer, store);

    expect(await redis.scard(DIRTY_SET_KEY)).toBe(0);
    expect(await buffer.pendingBuckets()).toBe(0);
  });

  it('ADDS the second flush’s views to the first flush’s row', async () => {
    const service = ingestion();

    await service.recordEvent(view('reader-a'));
    await runFlush(buffer, store);

    await service.recordEvent(view('reader-b'));
    await runFlush(buffer, store);

    // Counters are deltas: the row must accumulate, not be overwritten by the
    // latest batch — which `createMany(skipDuplicates)` would have done.
    expect((await storedBlogRow())?.views).toBe(2);
  });

  it('takes uniqueViews as an ABSOLUTE, so repeated flushes cannot multiply it', async () => {
    const service = ingestion();
    await service.recordEvent(view('reader-a'));
    await service.recordEvent(view('reader-b'));

    await runFlush(buffer, store);
    expect((await storedBlogRow())?.uniqueViews).toBe(2);

    // The HyperLogLog is day-cumulative and survives a drain, so a third reader
    // makes the day's total 3 — not 2 + 3.
    await service.recordEvent(view('reader-c'));
    await runFlush(buffer, store);

    expect((await storedBlogRow())?.uniqueViews).toBe(3);
    expect((await storedBlogRow())?.views).toBe(3);
  });

  it('never lets uniqueViews exceed views', async () => {
    // A reader who refreshes is deduplicated out of `views` but is already in
    // the HyperLogLog. If the HLL were re-added rather than taken as absolute,
    // uniques would drift above views — a visibly impossible number.
    const service = ingestion();

    await service.recordEvent(view('reader-a'));
    await service.recordEvent(view('reader-a'));
    await runFlush(buffer, store);
    await service.recordEvent(view('reader-a'));
    await runFlush(buffer, store);

    const row = await storedBlogRow();
    expect(row?.uniqueViews).toBeLessThanOrEqual(row!.views);
  });

  it('flushes an empty buffer without writing anything', async () => {
    const summary = await runFlush(buffer, store);

    expect(summary).toEqual({ blogRows: 0, userRows: 0, ownersInvalidated: 0 });
    expect(await prisma.blogAnalyticsDaily.count()).toBe(0);
  });

  it('carries reading metrics through to the row', async () => {
    const service = ingestion();

    await service.recordEvent({
      eventId: nextEventId(),
      eventType: 'BLOG_READ_STARTED',
      occurredAt: new Date(),
      entityType: 'BLOG',
      entityId: blogId,
      ownerId: authorId,
      userId: readerId,
      metadata: { kind: 'read', sessionId: 'flush-session-1' },
    });

    // A completion a moment later, so the server-measured elapsed time clears
    // the minimum.
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    await service.recordEvent({
      eventId: nextEventId(),
      eventType: 'BLOG_READ_COMPLETED',
      occurredAt: new Date(),
      entityType: 'BLOG',
      entityId: blogId,
      ownerId: authorId,
      userId: readerId,
      metadata: { kind: 'read', sessionId: 'flush-session-1', durationSeconds: 400 },
    });

    await runFlush(buffer, store);

    const row = await storedBlogRow();
    expect(row?.readStarts).toBe(1);
    expect(row?.readCompletions).toBe(1);
    // Clamped to the ~1s the server actually observed, not the claimed 400.
    expect(row?.totalReadingSeconds).toBeLessThan(10);
  });

  it('writes user-scoped metrics to their own table', async () => {
    const service = ingestion();
    const base = {
      occurredAt: new Date(),
      entityType: 'USER' as const,
      entityId: authorId,
      ownerId: authorId,
    };

    await service.recordEvent({ ...base, eventId: nextEventId(), eventType: 'USER_FOLLOWED' });
    await service.recordEvent({ ...base, eventId: nextEventId(), eventType: 'USER_FOLLOWED' });
    await service.recordEvent({ ...base, eventId: nextEventId(), eventType: 'USER_UNFOLLOWED' });
    await service.recordEvent({ ...base, eventId: nextEventId(), eventType: 'BLOG_PUBLISHED' });

    const summary = await runFlush(buffer, store);

    expect(summary.userRows).toBe(1);
    const row = await prisma.userAnalyticsDaily.findUnique({
      where: { userId_date: { userId: authorId, date: new Date(`${TODAY}T00:00:00.000Z`) } },
    });
    expect(row).toMatchObject({ followersGained: 2, followersLost: 1, blogsPublished: 1 });
  });

  describe('atomic drain', () => {
    it('hands a bucket to exactly one of two concurrent drains', async () => {
      const service = ingestion();
      for (let i = 0; i < 5; i++) await service.recordEvent(view(`reader-${i}`));

      // Two workers racing. Without the Lua drain, both would read the same
      // hash and both would write it — doubling the day's views.
      const [first, second] = await Promise.all([buffer.drain(500), buffer.drain(500)]);

      const total = first.length + second.length;
      expect(total).toBe(1);
    });

    it('re-marks a bucket dirty when an increment lands after a drain', async () => {
      const service = ingestion();
      await service.recordEvent(view('reader-a'));

      await buffer.drain(500);
      expect(await redis.scard(DIRTY_SET_KEY)).toBe(0);

      // SPOP happens BEFORE the hash is read, so a view arriving now re-adds the
      // member and is picked up next cycle rather than stranded.
      await service.recordEvent(view('reader-b'));
      expect(await redis.scard(DIRTY_SET_KEY)).toBe(1);
    });

    it('does not delete the HyperLogLog, which must span the whole day', async () => {
      const service = ingestion();
      await service.recordEvent(view('reader-a'));

      await buffer.drain(500);

      expect(await redis.exists(uniqueViewersKey(blogId, TODAY))).toBe(1);
    });
  });

  describe('failure handling', () => {
    /** A store whose blog upsert always fails, as a database outage would. */
    const failingStore: IAnalyticsStore = {
      upsertBlogDaily: async () => {
        throw new Error('simulated PostgreSQL outage');
      },
      upsertUserDaily: async () => 0,
      pruneBefore: async () => ({ blogRows: 0, userRows: 0 }),
    };

    it('restores drained counters to Redis when the write fails', async () => {
      const service = ingestion();
      await service.recordEvent(view('reader-a'));
      await service.recordEvent(view('reader-b'));

      await expect(runFlush(buffer, failingStore)).rejects.toThrow('simulated PostgreSQL outage');

      // The deltas were already out of Redis and lived only in memory. If they
      // were not handed back, the retry would drain an empty buffer and both
      // views would be gone with nothing logged.
      expect(await redis.scard(DIRTY_SET_KEY)).toBe(1);
    });

    it('loses nothing across an outage and a successful retry', async () => {
      const service = ingestion();
      await service.recordEvent(view('reader-a'));
      await service.recordEvent(view('reader-b'));

      await expect(runFlush(buffer, failingStore)).rejects.toThrow();
      await runFlush(buffer, store);

      expect((await storedBlogRow())?.views).toBe(2);
    });

    it('does not double-count when views arrive DURING a failed flush', async () => {
      const service = ingestion();
      await service.recordEvent(view('reader-a'));

      await expect(runFlush(buffer, failingStore)).rejects.toThrow();

      // Restore is additive, so a view that landed while the flush was failing
      // sums with the returned delta rather than replacing or duplicating it.
      await service.recordEvent(view('reader-b'));
      await runFlush(buffer, store);

      expect((await storedBlogRow())?.views).toBe(2);
    });
  });

  describe('cache invalidation', () => {
    it('bumps the generation only for authors it wrote', async () => {
      const service = ingestion();
      const other = await makeUser();

      const before = await currentGeneration(authorId);
      const otherBefore = await currentGeneration(other.id);

      await service.recordEvent(view(readerId));
      await runFlush(buffer, store);
      resetGenerationMemo();

      expect(await currentGeneration(authorId)).toBe(before + 1);
      // An untouched author keeps their cache. Scope-wide invalidation would
      // throw away every cached report on the platform, every flush.
      expect(await currentGeneration(other.id)).toBe(otherBefore);
    });

    it('does not bump anything when there was nothing to flush', async () => {
      const before = await currentGeneration(authorId);

      await runFlush(buffer, store);
      resetGenerationMemo();

      expect(await currentGeneration(authorId)).toBe(before);
    });
  });

  describe('retention', () => {
    it('deletes rows past the retention window and keeps recent ones', async () => {
      const old = new Date();
      old.setUTCDate(old.getUTCDate() - 500);

      await store.upsertBlogDaily([
        {
          blogId,
          authorId,
          date: old.toISOString().slice(0, 10),
          views: 5,
          uniqueViews: 5,
          readStarts: 0,
          readCompletions: 0,
          totalReadingSeconds: 0,
          bookmarks: 0,
          unbookmarks: 0,
          comments: 0,
        },
        {
          blogId,
          authorId,
          date: TODAY,
          views: 7,
          uniqueViews: 7,
          readStarts: 0,
          readCompletions: 0,
          totalReadingSeconds: 0,
          bookmarks: 0,
          unbookmarks: 0,
          comments: 0,
        },
      ]);

      await runPrune(store);

      const remaining = await prisma.blogAnalyticsDaily.findMany({ where: { blogId } });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.views).toBe(7);
    });
  });

  describe('cascade behaviour', () => {
    it('removes a blog’s aggregates when the blog is hard-deleted', async () => {
      const service = ingestion();
      await service.recordEvent(view(readerId));
      await runFlush(buffer, store);

      await prisma.blog.delete({ where: { id: blogId } });

      // Aggregates must not outlive their subject as unreachable orphan rows.
      expect(await prisma.blogAnalyticsDaily.count({ where: { blogId } })).toBe(0);
    });
  });
});
