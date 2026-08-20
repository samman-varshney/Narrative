import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';
import type { SearchHistoryEntry } from './search.types';

/**
 * Per-user recent searches.
 *
 * ── Redis, not PostgreSQL ───────────────────────────────────────────────────
 * Persisting every query a user ever typed would build, row by row, a permanent
 * record of what people looked for — the highest-sensitivity, lowest-value table
 * in the system. Redis gives the feature what it actually needs (a short list,
 * newest first) and gives the user something Postgres would not: the data ages
 * out on its own.
 *
 * Each user's history is a capped Redis list with a rolling TTL:
 *
 *     search:history:v1:<userId>  ->  [ {"q":"...","at":"..."}, ... ]
 *
 * bounded to MAX_ENTRIES and expiring HISTORY_TTL_SECONDS after the last search.
 * An account that stops searching stops having a history, with no sweep job.
 *
 * ── Never on the critical path ──────────────────────────────────────────────
 * Recording is fire-and-forget and every method swallows Redis failures. A
 * search must succeed when the history store is down; the feature is additive
 * and is not permitted to become a dependency of the main flow.
 */

const KEY_PREFIX = 'search:history:v1';

/** Newest-first entries kept per user. */
export const MAX_HISTORY_ENTRIES = 20;

/** Idle lifetime of a user's history. Refreshed on every recorded search. */
export const HISTORY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function historyKey(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export class SearchHistoryStore {
  /**
   * Records a search for a user.
   *
   * Re-searching a term MOVES it to the top rather than adding a duplicate —
   * `LREM` before `LPUSH` — so a user who checks the same thing five times a day
   * does not lose the rest of their history to it.
   */
  async record(userId: string, query: string): Promise<void> {
    const key = historyKey(userId);
    const entry: SearchHistoryEntry = {
      query,
      searchedAt: new Date().toISOString(),
    };

    try {
      // Existing copies of this query carry a different timestamp, so they
      // cannot be matched by value — the list is re-read and rewritten instead.
      // Bounded to MAX_HISTORY_ENTRIES, so this is a handful of small strings.
      const existing = await redis.lrange(key, 0, MAX_HISTORY_ENTRIES - 1);
      const survivors = existing.filter((raw) => parseEntry(raw)?.query !== query);

      const pipeline = redis.pipeline();
      pipeline.del(key);
      pipeline.rpush(key, JSON.stringify(entry), ...survivors);
      pipeline.ltrim(key, 0, MAX_HISTORY_ENTRIES - 1);
      pipeline.expire(key, HISTORY_TTL_SECONDS);
      await pipeline.exec();
    } catch (err) {
      logger.warn({ err, userId }, 'search: failed to record search history');
    }
  }

  /** Newest-first history for a user. Returns `[]` on any failure. */
  async list(userId: string, limit = MAX_HISTORY_ENTRIES): Promise<SearchHistoryEntry[]> {
    try {
      const raw = await redis.lrange(historyKey(userId), 0, limit - 1);
      return raw
        .map(parseEntry)
        .filter((entry): entry is SearchHistoryEntry => entry !== null);
    } catch (err) {
      logger.warn({ err, userId }, 'search: failed to read search history');
      return [];
    }
  }

  /**
   * Clears a user's history. Returns how many entries were removed so the
   * endpoint can report it — a "cleared 0 items" response is a meaningfully
   * different answer from "cleared 12".
   */
  async clear(userId: string): Promise<number> {
    const key = historyKey(userId);
    try {
      const size = await redis.llen(key);
      await redis.del(key);
      return size;
    } catch (err) {
      logger.warn({ err, userId }, 'search: failed to clear search history');
      return 0;
    }
  }
}

function parseEntry(raw: string): SearchHistoryEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SearchHistoryEntry>;
    if (typeof parsed.query !== 'string' || typeof parsed.searchedAt !== 'string') {
      return null;
    }
    return { query: parsed.query, searchedAt: parsed.searchedAt };
  } catch {
    return null;
  }
}

export const searchHistoryStore = new SearchHistoryStore();
