import type {
  BlogHit,
  BlogSearchFilters,
  CategoryHit,
  EnginePage,
  NormalizedQuery,
  SearchPageRequest,
  Suggestion,
  TagHit,
  UserHit,
} from '../search.types';

/**
 * The retrieval + ranking backend behind the Search module.
 *
 * This is the seam that lets Postgres be replaced by OpenSearch, Meilisearch or
 * a vector index without the API, the controller, the validators, the cache, or
 * the history store changing at all. To keep that seam real rather than
 * decorative, the contract is stated in terms an external engine can satisfy:
 *
 *  - INPUTS are already normalized. An engine never sees raw user text, and is
 *    never responsible for length limits or escaping.
 *
 *  - PAGINATION is keyset, expressed through opaque cursors the engine mints
 *    and consumes. Nothing outside the engine may interpret a cursor's contents,
 *    so an engine that needs a different key (a Lucene `search_after`, say) is
 *    free to encode one.
 *
 *  - VISIBILITY IS THE ENGINE'S JOB, not a filter the caller remembers to pass.
 *    Every method here returns publicly visible content only: PUBLISHED +
 *    PUBLIC blogs by ACTIVE authors, ACTIVE non-private users. Making this part
 *    of the interface contract — rather than a `where` the service appends — is
 *    deliberate: a future engine cannot accidentally omit it and start serving
 *    drafts, and there is no "include private" parameter to be passed by
 *    mistake.
 *
 *  - SCORES are comparable within one result set and meaningless across
 *    engines, queries, or time. Nothing may persist or compare them globally.
 *
 * Implementations must be stateless and safe to share as a singleton.
 */
export interface ISearchEngine {
  /** Identifier for logs and diagnostics, e.g. `postgres`. */
  readonly name: string;

  searchBlogs(
    query: NormalizedQuery,
    page: SearchPageRequest,
    filters: BlogSearchFilters
  ): Promise<EnginePage<BlogHit>>;

  searchUsers(
    query: NormalizedQuery,
    page: SearchPageRequest
  ): Promise<EnginePage<UserHit>>;

  searchTags(
    query: NormalizedQuery,
    page: SearchPageRequest
  ): Promise<EnginePage<TagHit>>;

  searchCategories(
    query: NormalizedQuery,
    page: SearchPageRequest
  ): Promise<EnginePage<CategoryHit>>;

  /**
   * Typeahead completions drawn from the indexed vocabulary — tags, categories,
   * usernames, blog titles.
   *
   * Popularity-based suggestions are NOT sourced here: they come from recorded
   * search terms in Redis, which no search engine knows about. The service
   * merges the two.
   */
  suggest(query: NormalizedQuery, limit: number): Promise<Suggestion[]>;
}
