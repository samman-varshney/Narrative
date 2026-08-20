import { redis } from '../../../core/providers/redis';
import { env } from '../../../core/config/env';
import { AnalyticsBuffer } from '../analytics.buffer';
import { AnalyticsBlogResolver } from '../analytics.resolver';
import {
  MAX_READS_PER_WINDOW,
  MIN_READ_SECONDS,
  READ_DURATION_TOLERANCE,
  RedisAnalyticsIngestionService,
} from '../ingestion/RedisAnalyticsIngestionService';
import { blogBufferKey, uniqueViewersKey, userBufferKey } from '../analytics.keys';
import type { AnalyticsEvent } from '../analytics.types';
import { clearAnalyticsKeys } from './helpers';
import { reportingDateKey } from '../analytics.time';

/**
 * Ingestion behaviour against a REAL Redis.
 *
 * Mocked Redis would prove these paths call the commands we expect; only a real
 * one proves the guards actually hold. `SET NX` either claims a key or it does
 * not, and `MULTI` either consumes a session atomically or it does not — those
 * are the properties every number in this module rests on, and a mock would
 * happily agree with a broken implementation.
 *
 * The blog resolver is stubbed because it is the one dependency that reaches
 * PostgreSQL. Its own behaviour is covered by the flush integration tests.
 */

const BLOG_ID = 'blog-ingest-1';
const AUTHOR_ID = 'author-ingest-1';
const READER_ID = 'reader-ingest-1';
// Derived through the module's own helper, not a raw UTC slice: the bucket a
// view lands in follows `ANALYTICS_REPORTING_UTC_OFFSET_MINUTES`, so hardcoding
// UTC here would make every assertion below wrong for any operator who sets it.
const TODAY = reportingDateKey(new Date());

/** A resolver that answers from a fixture instead of the database. */
class StubResolver extends AnalyticsBlogResolver {
  constructor(private readonly readingTimeMinutes = 10) {
    super(redis);
  }

  override async resolve(blogId: string) {
    if (blogId === 'missing-blog') return null;
    return { authorId: AUTHOR_ID, readingTimeMinutes: this.readingTimeMinutes };
  }
}

function buildService(readingTimeMinutes = 10) {
  return new RedisAnalyticsIngestionService(
    redis,
    new AnalyticsBuffer(redis),
    new StubResolver(readingTimeMinutes)
  );
}

let counter = 0;
/** Unique per call, so tests never collide on the event-dedupe guard. */
const nextEventId = () => `evt-${Date.now()}-${++counter}`;

function viewEvent(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    eventId: nextEventId(),
    eventType: 'BLOG_VIEWED',
    occurredAt: new Date(),
    entityType: 'BLOG',
    entityId: BLOG_ID,
    ownerId: AUTHOR_ID,
    userId: READER_ID,
    ...overrides,
  };
}

function readEvent(
  eventType: 'BLOG_READ_STARTED' | 'BLOG_READ_COMPLETED',
  sessionId: string,
  overrides: Partial<AnalyticsEvent> & { durationSeconds?: number } = {}
): AnalyticsEvent {
  const { durationSeconds, ...rest } = overrides;
  return {
    eventId: nextEventId(),
    eventType,
    occurredAt: new Date(),
    entityType: 'BLOG',
    entityId: BLOG_ID,
    ownerId: AUTHOR_ID,
    userId: READER_ID,
    metadata: {
      kind: 'read',
      sessionId,
      ...(durationSeconds !== undefined && { durationSeconds }),
    },
    ...rest,
  };
}

/** Counters currently buffered for the blog's bucket today. */
async function blogCounters(blogId = BLOG_ID): Promise<Record<string, number>> {
  const hash = await redis.hgetall(blogBufferKey(blogId, TODAY));
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(hash)) {
    if (field === 'authorId') continue;
    out[field] = Number.parseInt(value, 10);
  }
  return out;
}

describe('RedisAnalyticsIngestionService', () => {
  beforeEach(async () => {
    await clearAnalyticsKeys();
  });

  afterAll(async () => {
    await clearAnalyticsKeys();
  });

  describe('event deduplication', () => {
    it('records an event once and ignores its redelivery', async () => {
      const service = buildService();
      const event = viewEvent();

      expect((await service.recordEvent(event)).outcome).toBe('recorded');
      // Same eventId — exactly what a BullMQ retry of the same job produces.
      expect((await service.recordEvent(event)).outcome).toBe('duplicate-event');

      expect((await blogCounters()).views).toBe(1);
    });

    it('treats two separate emissions of the same payload as two events', async () => {
      // The reason dedupe is keyed on eventId and not on a payload hash: a
      // bookmark → unbookmark → bookmark cycle produces byte-identical payloads
      // and must count twice.
      const service = buildService();

      await service.recordEvent({
        ...viewEvent(),
        eventType: 'BLOG_BOOKMARKED',
        userId: 'someone-else',
      });
      await service.recordEvent({
        ...viewEvent(),
        eventType: 'BLOG_BOOKMARKED',
        userId: 'someone-else',
      });

      expect((await blogCounters()).bookmarks).toBe(2);
    });
  });

  describe('view deduplication', () => {
    it('counts one view per reader per window, however many times they refresh', async () => {
      const service = buildService();

      expect((await service.recordEvent(viewEvent())).outcome).toBe('recorded');
      for (let i = 0; i < 5; i++) {
        expect((await service.recordEvent(viewEvent())).outcome).toBe('duplicate-view');
      }

      expect((await blogCounters()).views).toBe(1);
    });

    it('counts a different reader separately', async () => {
      const service = buildService();

      await service.recordEvent(viewEvent());
      await service.recordEvent(viewEvent({ userId: 'other-reader' }));

      expect((await blogCounters()).views).toBe(2);
    });

    it('treats an anonymous reader as their own identity', async () => {
      const service = buildService();

      await service.recordEvent(viewEvent({ userId: undefined, anonymousId: 'anon-aaaaaaaaaaaa' }));
      const repeat = await service.recordEvent(
        viewEvent({ userId: undefined, anonymousId: 'anon-aaaaaaaaaaaa' })
      );

      expect(repeat.outcome).toBe('duplicate-view');
      expect((await blogCounters()).views).toBe(1);
    });

    it('counts an unidentified view but never adds it to the unique set', async () => {
      const service = buildService();

      await service.recordEvent(viewEvent({ userId: undefined }));
      await service.recordEvent(viewEvent({ userId: undefined }));

      // Both counted — they really happened — but neither can be deduplicated
      // or attributed, so uniques UNDER-count rather than inventing an identity.
      expect((await blogCounters()).views).toBe(2);
      expect(await redis.exists(uniqueViewersKey(BLOG_ID, TODAY))).toBe(0);
    });

    it('adds identified readers to the day’s HyperLogLog', async () => {
      const service = buildService();

      await service.recordEvent(viewEvent({ userId: 'r1' }));
      await service.recordEvent(viewEvent({ userId: 'r2' }));
      await service.recordEvent(viewEvent({ userId: 'r3' }));

      expect(await redis.pfcount(uniqueViewersKey(BLOG_ID, TODAY))).toBe(3);
    });

    it('expires the dedupe window so the same reader counts again tomorrow', async () => {
      const service = buildService();
      await service.recordEvent(viewEvent());

      const keys = await redis.keys('analytics:v1:view:*');
      expect(keys).toHaveLength(1);

      const ttl = await redis.ttl(keys[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(env.ANALYTICS_VIEW_DEDUPE_SECONDS);
    });
  });

  describe('self-action filtering', () => {
    it('does not count an author viewing their own blog', async () => {
      const service = buildService();

      const result = await service.recordEvent(viewEvent({ userId: AUTHOR_ID }));

      // Otherwise a brand-new post shows "1 view" before anyone has read it.
      expect(result.outcome).toBe('self-action');
      expect(await blogCounters()).toEqual({});
    });

    it('does not count an author bookmarking or commenting on their own blog', async () => {
      const service = buildService();

      for (const eventType of ['BLOG_BOOKMARKED', 'BLOG_COMMENTED'] as const) {
        const result = await service.recordEvent(viewEvent({ eventType, userId: AUTHOR_ID }));
        expect(result.outcome).toBe('self-action');
      }

      expect(await blogCounters()).toEqual({});
    });
  });

  describe('unresolved owners', () => {
    it('drops an event for a blog that no longer exists', async () => {
      const service = buildService();

      // A normal race: the event was queued before the blog was deleted.
      const result = await service.recordEvent(
        viewEvent({ entityId: 'missing-blog', ownerId: undefined })
      );

      expect(result.outcome).toBe('unresolved-owner');
    });

    it('resolves the author when the event did not carry one', async () => {
      // Bookmark events are `{ blogId, userId }` — no author — so this path is
      // the only thing that makes bookmarks attributable to a dashboard.
      const service = buildService();

      const result = await service.recordEvent(
        viewEvent({ eventType: 'BLOG_BOOKMARKED', ownerId: undefined, userId: 'reader-x' })
      );

      expect(result.outcome).toBe('recorded');
      expect(await redis.hget(blogBufferKey(BLOG_ID, TODAY), 'authorId')).toBe(AUTHOR_ID);
    });
  });

  describe('reading sessions', () => {
    it('records a start and its matching completion', async () => {
      const service = buildService();

      expect((await service.recordEvent(readEvent('BLOG_READ_STARTED', 'sess-1'))).outcome).toBe(
        'recorded'
      );
      expect(
        (await service.recordEvent(readEvent('BLOG_READ_COMPLETED', 'sess-1', { durationSeconds: 300 })))
          .outcome
      ).toBe('recorded');

      const counters = await blogCounters();
      expect(counters.readStarts).toBe(1);
      expect(counters.readCompletions).toBe(1);
      expect(counters.totalReadingSeconds).toBeGreaterThan(0);
    });

    it('refuses a completion with no matching start', async () => {
      const service = buildService();

      const result = await service.recordEvent(
        readEvent('BLOG_READ_COMPLETED', 'never-started', { durationSeconds: 300 })
      );

      // Ordering enforcement: without it, a client could post completions in a
      // loop and every one would count as a finished read.
      expect(result.outcome).toBe('out-of-order');
      expect((await blogCounters()).readCompletions).toBeUndefined();
    });

    it('refuses a SECOND completion for the same session', async () => {
      const service = buildService();
      await service.recordEvent(readEvent('BLOG_READ_STARTED', 'sess-2'));
      await service.recordEvent(readEvent('BLOG_READ_COMPLETED', 'sess-2', { durationSeconds: 60 }));

      const second = await service.recordEvent(
        readEvent('BLOG_READ_COMPLETED', 'sess-2', { durationSeconds: 60 })
      );

      // The session marker was consumed by the first completion.
      expect(second.outcome).toBe('out-of-order');
      expect((await blogCounters()).readCompletions).toBe(1);
    });

    it('refuses to complete another reader’s session', async () => {
      const service = buildService();
      await service.recordEvent(readEvent('BLOG_READ_STARTED', 'sess-3'));

      const result = await service.recordEvent(
        readEvent('BLOG_READ_COMPLETED', 'sess-3', {
          userId: 'a-different-reader',
          durationSeconds: 60,
        })
      );

      // The session key is scoped by identity as well as session id, so a
      // guessed id belonging to someone else is worthless.
      expect(result.outcome).toBe('out-of-order');
    });

    it('refuses a read event with no identity to tie a session to', async () => {
      const service = buildService();

      const result = await service.recordEvent(
        readEvent('BLOG_READ_STARTED', 'sess-4', { userId: undefined })
      );

      expect(result.outcome).toBe('invalid');
    });

    it('caps how many sessions one reader may open on one blog', async () => {
      const service = buildService();

      for (let i = 0; i < MAX_READS_PER_WINDOW; i++) {
        const result = await service.recordEvent(readEvent('BLOG_READ_STARTED', `bulk-${i}`));
        expect(result.outcome).toBe('recorded');
      }

      // Session ids are client-minted, so without this cap a script could open
      // unlimited reads and inflate the author's completion rate.
      const overflow = await service.recordEvent(readEvent('BLOG_READ_STARTED', 'bulk-overflow'));
      expect(overflow.outcome).toBe('invalid');
    });
  });

  describe('reading duration validation', () => {
    it('rejects a duration too short to be a read', async () => {
      const service = buildService();
      await service.recordEvent(readEvent('BLOG_READ_STARTED', 'short'));

      const result = await service.recordEvent(
        readEvent('BLOG_READ_COMPLETED', 'short', { durationSeconds: MIN_READ_SECONDS - 1 })
      );

      expect(result.outcome).toBe('invalid');
      expect((await blogCounters()).readCompletions).toBeUndefined();
    });

    it('clamps an inflated duration instead of discarding the completion', async () => {
      // 10-minute post, so the plausible ceiling is 40 minutes. The read is real
      // — only the number attached to it is not — so the completion still counts.
      const service = buildService(10);
      await service.recordEvent(readEvent('BLOG_READ_STARTED', 'inflated'));

      const result = await service.recordEvent(
        readEvent('BLOG_READ_COMPLETED', 'inflated', { durationSeconds: 60 * 60 * 3 })
      );

      expect(result.outcome).toBe('recorded');

      const counters = await blogCounters();
      expect(counters.readCompletions).toBe(1);
      expect(counters.totalReadingSeconds).toBeLessThanOrEqual(
        10 * 60 * READ_DURATION_TOLERANCE
      );
    });

    it('clamps to the SERVER-measured elapsed time, which a client cannot inflate', async () => {
      // Start and completion arrive in the same instant, so however long the
      // client claims, the true upper bound is ~0 seconds. This is the strongest
      // of the three bounds and the reason a forged duration cannot land.
      const service = buildService(60);
      await service.recordEvent(readEvent('BLOG_READ_STARTED', 'instant'));

      await service.recordEvent(
        readEvent('BLOG_READ_COMPLETED', 'instant', { durationSeconds: 1_800 })
      );

      const counters = await blogCounters();
      expect(counters.readCompletions).toBe(1);
      expect(counters.totalReadingSeconds).toBeLessThanOrEqual(2);
    });

    it('falls back to the server measurement when no duration is claimed', async () => {
      const service = buildService();
      await service.recordEvent(readEvent('BLOG_READ_STARTED', 'noclaim'));

      const result = await service.recordEvent(readEvent('BLOG_READ_COMPLETED', 'noclaim'));

      // Elapsed is ~0 here, which is below MIN_READ_SECONDS — correctly rejected
      // rather than counted as a zero-second read.
      expect(result.outcome).toBe('invalid');
    });
  });

  describe('user-scoped counters', () => {
    it('credits a follow to the user being followed', async () => {
      const service = buildService();

      await service.recordEvent({
        eventId: nextEventId(),
        eventType: 'USER_FOLLOWED',
        occurredAt: new Date(),
        entityType: 'USER',
        entityId: 'followed-user',
        ownerId: 'followed-user',
        userId: 'the-follower',
      });

      const hash = await redis.hgetall(userBufferKey('followed-user', TODAY));
      expect(hash.followersGained).toBe('1');
    });

    it('records gains and losses as separate counters', async () => {
      const service = buildService();
      const base = {
        occurredAt: new Date(),
        entityType: 'USER' as const,
        entityId: 'growth-user',
        ownerId: 'growth-user',
      };

      await service.recordEvent({ ...base, eventId: nextEventId(), eventType: 'USER_FOLLOWED' });
      await service.recordEvent({ ...base, eventId: nextEventId(), eventType: 'USER_FOLLOWED' });
      await service.recordEvent({ ...base, eventId: nextEventId(), eventType: 'USER_UNFOLLOWED' });

      // A day that gained two and lost one is a different fact from a day that
      // gained one — which a single net counter could not express.
      const hash = await redis.hgetall(userBufferKey('growth-user', TODAY));
      expect(hash.followersGained).toBe('2');
      expect(hash.followersLost).toBe('1');
    });
  });

  describe('batch ingestion', () => {
    it('reports an outcome per event and applies the same guards', async () => {
      const service = buildService();
      const shared = viewEvent();

      const results = await service.recordBatch([
        shared,
        shared,
        viewEvent({ userId: 'batch-reader-2' }),
      ]);

      expect(results.map((r) => r.outcome)).toEqual([
        'recorded',
        'duplicate-event',
        'recorded',
      ]);
    });
  });
});
