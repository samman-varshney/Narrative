import { prisma } from '../../../core/database/prisma';
import { redis } from '../../../core/providers/redis';
import { resetGenerationMemo } from '../feed.cache';

/**
 * Shared fixtures for the feed suites.
 *
 * The test Redis is a real one (logical DB 1, per jest.setup.js) and is shared
 * with the rate limiters and BullMQ, so `FLUSHDB` would take out unrelated
 * state. Cleanup is scoped to the feed keyspace instead — `SCAN`, never `KEYS`,
 * for the same reason the production code avoids it.
 */
export async function clearFeedKeys(): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'feed:v1:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');

  // The generation counter is memoized in-process for a few seconds; without
  // this a suite would keep using the generation it read before the flush and
  // write into a keyspace it just deleted.
  resetGenerationMemo();
}

/** Midnight UTC today — the reporting day live analytics rows land in. */
export function todayLabel(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** A LABEL `days` before today. */
export function daysAgoLabel(days: number): Date {
  const label = todayLabel();
  label.setUTCDate(label.getUTCDate() - days);
  return label;
}

/**
 * Writes a day of analytics for a blog — the rows the flush worker would have
 * written. Feed never writes these; it only reads them through the Analytics
 * module, so seeding them directly is how a ranking test states its premise.
 */
export async function makeAnalyticsDay(
  blogId: string,
  authorId: string,
  metrics: Partial<{
    date: Date;
    views: number;
    uniqueViews: number;
    readStarts: number;
    readCompletions: number;
    totalReadingSeconds: number;
    bookmarks: number;
    unbookmarks: number;
    comments: number;
  }> = {}
) {
  const { date, ...counters } = metrics;
  return prisma.blogAnalyticsDaily.create({
    data: {
      blogId,
      authorId,
      date: date ?? todayLabel(),
      views: counters.views ?? 0,
      uniqueViews: counters.uniqueViews ?? 0,
      readStarts: counters.readStarts ?? 0,
      readCompletions: counters.readCompletions ?? 0,
      totalReadingSeconds: counters.totalReadingSeconds ?? 0,
      bookmarks: counters.bookmarks ?? 0,
      unbookmarks: counters.unbookmarks ?? 0,
      comments: counters.comments ?? 0,
    },
  });
}

/** A comment on a blog, for the public engagement count on a feed card. */
export async function makeComment(blogId: string, authorId: string) {
  return prisma.comment.create({
    data: { blogId, authorId, content: 'A comment' },
  });
}
