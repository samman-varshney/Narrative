import { logger } from '../../core/utils/logger';
import { activeSearchEngine } from './engines';
import type { ISearchEngine } from './engines/ISearchEngine';
import { withCache, type CacheScope } from './search.cache';
import { searchHistoryStore } from './search.history';
import { normalizeQuery } from './search.query';
import { searchTermsStore } from './search.terms';
import type {
  BlogHit,
  BlogSearchFilters,
  CategoryHit,
  EnginePage,
  GlobalSearchResult,
  NormalizedQuery,
  SearchHistoryEntry,
  SearchPageRequest,
  Suggestion,
  TagHit,
  UserHit,
} from './search.types';
import type {
  BlogSearchQuery,
  EntitySearchQuery,
  GlobalSearchQuery,
  SuggestionsQuery,
} from './search.validator';

/**
 * Search orchestration.
 *
 * The service owns everything that is true regardless of which engine is
 * running: normalizing the query, deciding what may be cached, recording the
 * side effects (history, popularity), and assembling the cross-entity overview.
 * It owns no SQL and no ranking — those live behind `ISearchEngine`.
 *
 * ── The viewer parameter ────────────────────────────────────────────────────
 * `viewerId` never reaches the engine and never varies the results. It exists
 * only to attribute the two side effects that are per-user (history) or
 * aggregate (popularity). That is deliberate and load-bearing: because results
 * do not depend on the viewer, one cached entry is correct for every caller, and
 * there is no path by which a cache key could omit an authorization dimension it
 * needed. If personalized ranking is ever added, the cache key must gain the
 * viewer id in the same change — see docs/SEARCH_MODULE.md.
 */
export class SearchService {
  constructor(private readonly engine: ISearchEngine = activeSearchEngine) {}

  // ---- Entity searches ----------------------------------------------------

  async searchBlogs(
    input: BlogSearchQuery,
    viewerId?: string
  ): Promise<EnginePage<BlogHit>> {
    const query = normalizeQuery(input.q);
    const filters = toBlogFilters(input);
    const page = toPageRequest(input);

    const result = await this.cached('blogs', query, page, filters, () =>
      this.engine.searchBlogs(query, page, filters)
    );

    this.recordSearch(query, result.items.length, viewerId);
    return result;
  }

  async searchUsers(
    input: EntitySearchQuery,
    viewerId?: string
  ): Promise<EnginePage<UserHit>> {
    const query = normalizeQuery(input.q);
    const page = toPageRequest(input);

    const result = await this.cached('users', query, page, undefined, () =>
      this.engine.searchUsers(query, page)
    );

    this.recordSearch(query, result.items.length, viewerId);
    return result;
  }

  async searchTags(input: EntitySearchQuery): Promise<EnginePage<TagHit>> {
    const query = normalizeQuery(input.q);
    const page = toPageRequest(input);
    return this.cached('tags', query, page, undefined, () =>
      this.engine.searchTags(query, page)
    );
  }

  async searchCategories(input: EntitySearchQuery): Promise<EnginePage<CategoryHit>> {
    const query = normalizeQuery(input.q);
    const page = toPageRequest(input);
    return this.cached('categories', query, page, undefined, () =>
      this.engine.searchCategories(query, page)
    );
  }

  /**
   * Cross-entity overview for the search dropdown.
   *
   * Deliberately NOT cursor-paginated: it is a fixed, capped slice of each
   * entity type, and "page 2 of a mixture of blogs, users and tags" is not a
   * coherent thing to ask for. Deep paging is done per entity, on the dedicated
   * endpoints.
   *
   * The four engine calls run concurrently — they are independent reads, and
   * serializing them would make the most latency-sensitive endpoint in the
   * module the slowest.
   */
  async globalSearch(
    input: GlobalSearchQuery,
    viewerId?: string
  ): Promise<GlobalSearchResult> {
    const query = normalizeQuery(input.q);
    const page: SearchPageRequest = { limit: input.limit, sort: 'relevance' };

    const result = await withCache(
      'global',
      { q: query.normalized, limit: input.limit },
      async () => {
        const [blogs, users, tags, categories] = await Promise.all([
          this.engine.searchBlogs(query, page, {}),
          this.engine.searchUsers(query, page),
          this.engine.searchTags(query, page),
          this.engine.searchCategories(query, page),
        ]);

        return {
          query: query.normalized,
          blogs: blogs.items,
          users: users.items,
          tags: tags.items,
          categories: categories.items,
        } satisfies GlobalSearchResult;
      }
    );

    const total =
      result.blogs.length + result.users.length + result.tags.length + result.categories.length;
    this.recordSearch(query, total, viewerId);

    return result;
  }

  // ---- Suggestions --------------------------------------------------------

  /**
   * Typeahead suggestions, merged from two very different sources.
   *
   * Popular terms come first when they exist: a term other people actually
   * searched for is a better completion than an arbitrary tag that happens to
   * share a prefix. Vocabulary suggestions (tags, categories, usernames, blog
   * titles) fill the rest.
   *
   * De-duplication is case-insensitive on the suggestion text, so "React" the
   * tag and "react" the popular term collapse into one row rather than
   * occupying two slots in a ten-item list.
   */
  async suggest(input: SuggestionsQuery): Promise<Suggestion[]> {
    const query = normalizeQuery(input.q);

    return withCache(
      'suggestions',
      { q: query.normalized, limit: input.limit },
      async () => {
        const [popular, vocabulary] = await Promise.all([
          searchTermsStore.popular(query.normalized, input.limit),
          this.engine.suggest(query, input.limit),
        ]);

        const seen = new Set<string>();
        const merged: Suggestion[] = [];

        for (const suggestion of [...popular, ...vocabulary]) {
          const key = suggestion.text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(suggestion);
          if (merged.length >= input.limit) break;
        }

        return merged;
      }
    );
  }

  // ---- History ------------------------------------------------------------

  listHistory(userId: string, limit: number): Promise<SearchHistoryEntry[]> {
    return searchHistoryStore.list(userId, limit);
  }

  clearHistory(userId: string): Promise<number> {
    return searchHistoryStore.clear(userId);
  }

  // ---- Internals ----------------------------------------------------------

  /**
   * Wraps an engine call in the read-through cache.
   *
   * The cursor is part of the key, so each page caches separately — which is
   * what makes a cache hit possible at all for a user paging through results
   * that someone else already walked.
   */
  private cached<T>(
    scope: CacheScope,
    query: NormalizedQuery,
    page: SearchPageRequest,
    filters: BlogSearchFilters | undefined,
    loader: () => Promise<T>
  ): Promise<T> {
    return withCache(
      scope,
      {
        q: query.normalized,
        sort: page.sort,
        limit: page.limit,
        cursor: page.cursor ?? null,
        filters: filters ?? null,
      },
      loader
    );
  }

  /**
   * Fire-and-forget side effects of a search.
   *
   * Both writes are deliberately un-awaited: neither result nor latency of the
   * search may depend on them, and a Redis hiccup must not turn a working search
   * into a 500. The stores swallow their own errors; the `.catch` here is the
   * belt to that braces, guarding against an unhandled rejection taking the
   * process down.
   *
   * Only searches that FOUND something are counted (`resultCount` gates the
   * write inside the store), and only authenticated searches get history.
   */
  private recordSearch(query: NormalizedQuery, resultCount: number, viewerId?: string): void {
    const onError = (err: unknown) =>
      logger.warn({ err }, 'search: side-effect recording failed');

    void searchTermsStore.record(query.normalized, resultCount).catch(onError);

    if (viewerId) {
      void searchHistoryStore.record(viewerId, query.normalized).catch(onError);
    }
  }
}

function toPageRequest(input: {
  cursor?: string;
  limit: number;
  sort: SearchPageRequest['sort'];
}): SearchPageRequest {
  return {
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: input.limit,
    sort: input.sort,
  };
}

/**
 * Maps the validated query string onto the engine's filter shape.
 *
 * Only keys the caller actually supplied are present — `undefined` entries would
 * change the canonicalized cache key and cursor fingerprint for a request that
 * is semantically identical to one without them.
 */
function toBlogFilters(input: BlogSearchQuery): BlogSearchFilters {
  return {
    ...(input.author ? { author: input.author } : {}),
    ...(input.tag?.length ? { tags: input.tag } : {}),
    ...(input.category?.length ? { categories: input.category } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.minReadingTime !== undefined ? { minReadingTime: input.minReadingTime } : {}),
    ...(input.maxReadingTime !== undefined ? { maxReadingTime: input.maxReadingTime } : {}),
  };
}

export const searchService = new SearchService();
