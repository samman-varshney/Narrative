/**
 * Ranking configuration.
 *
 * The weights live here, apart from the SQL that applies them, for three
 * reasons: they are the part most likely to be tuned; they are the part a unit
 * test can assert on without a database; and keeping them out of the query
 * template makes the scoring formula readable as a formula rather than as a
 * wall of string concatenation.
 *
 * ── The blog ranking ladder ─────────────────────────────────────────────────
 * The brief specifies a priority order. These weights implement it, and the
 * ordering of the constants below IS that specification:
 *
 *   1. exact title match        — an unambiguous "I meant this post"
 *   2. title relevance          — prefix match, then full-text rank on title/subtitle
 *   3. tag / category relevance — the post is *about* the thing asked for
 *   4. author relevance         — the post is *by* the person asked for
 *   5. recency                  — a tiebreaker, never a primary signal
 *
 * Content-body relevance is absent by design: the body is Tiptap JSON and is
 * deliberately not indexed in this phase. See docs/SEARCH_MODULE.md.
 *
 * ── Why these numbers ───────────────────────────────────────────────────────
 * Every component is normalized to [0, 1] before weighting — `ts_rank_cd` is
 * called with normalization flag 32 (`rank / (rank + 1)`), `similarity()` is
 * already bounded, and the boolean signals are 0 or 1. That makes the weights
 * directly comparable: a component's weight IS its maximum contribution, so the
 * ladder above can be read straight off the constants.
 *
 * The gaps are deliberate rather than fitted. EXACT_TITLE alone (6.0) outranks
 * every other component summed (3.0 + 2.5 + 1.2 + 1.5 + 1.0 + 0.8 = 10.0 only
 * if every one of them saturates simultaneously, which requires the query to
 * exactly prefix the title *and* match a tag *and* match the author). RECENCY
 * is deliberately the smallest: at 0.8 it can reorder near-ties without ever
 * promoting an irrelevant-but-fresh post above a relevant older one.
 */

/** Blog scoring weights, in the brief's priority order. */
export const BLOG_WEIGHTS = {
  /** `lower(title) = query`. The strongest signal there is. */
  EXACT_TITLE: 6.0,
  /** `lower(title) LIKE 'query%'` — an anchored prefix of the title. */
  TITLE_PREFIX: 3.0,
  /** `ts_rank_cd` over the weighted title(A)/subtitle(B) vector. */
  FULL_TEXT: 2.5,
  /** Trigram similarity of the title — what catches typos. */
  TITLE_FUZZY: 1.2,
  /** Best match across the blog's tags and categories. */
  TAXONOMY: 1.5,
  /** Match against the author's username or display name. */
  AUTHOR: 1.0,
  /** Exponential freshness decay. Tiebreaker only. */
  RECENCY: 0.8,
} as const;

/** User scoring weights. Handles are exact-matched far more often than names. */
export const USER_WEIGHTS = {
  EXACT_USERNAME: 5.0,
  USERNAME_PREFIX: 3.0,
  NAME_PREFIX: 2.0,
  USERNAME_FUZZY: 1.5,
  NAME_FUZZY: 1.0,
  /** A small, deliberate nudge so verified accounts win otherwise-exact ties. */
  VERIFIED: 0.5,
} as const;

/** Tag and category scoring weights. Same shape for both vocabularies. */
export const TERM_WEIGHTS = {
  EXACT_NAME: 5.0,
  NAME_PREFIX: 3.0,
  NAME_FUZZY: 1.5,
} as const;

/**
 * Half-life of the recency boost, in seconds (180 days).
 *
 * The boost is `exp(-age / RECENCY_DECAY_SECONDS)`, so a post published today
 * scores 1.0, one from 180 days ago scores ~0.37, and one from two years ago
 * ~0.02. Long enough that evergreen writing is not buried, short enough that a
 * fresh post wins a genuine tie.
 */
export const RECENCY_DECAY_SECONDS = 180 * 24 * 60 * 60;

/**
 * Maximum rows pulled from each candidate source before ranking.
 *
 * Retrieval is top-K, not exhaustive: each source contributes at most this many
 * rows, ordered by its own relevance measure, and ranking happens over the
 * union. This is what keeps a one-word query against a million-row table
 * bounded — without it, `title % 'javascript'` would score every matching row on
 * every page request.
 *
 * The consequence is a hard depth limit: no query can page past roughly
 * `CANDIDATE_LIMIT × (number of sources)` results. That is the same trade every
 * production search engine makes (Elasticsearch calls it `max_result_window`)
 * and is documented as a limitation rather than hidden.
 *
 * Each source's ordering is deterministic, so the truncation point is stable
 * across page requests — a cursor walk cannot see a row appear or vanish
 * because the cap fell differently the second time.
 */
export const CANDIDATE_LIMIT = 300;

/**
 * Rows pulled from a flat vocabulary (tags, categories, authors) before their
 * matches are expanded into blogs.
 *
 * Much smaller than CANDIDATE_LIMIT because these are the INPUT to an expansion,
 * not results in their own right: 25 matching tags already fan out to every blog
 * carrying any of them. Raising it multiplies join work for terms that, by
 * definition, matched the query less well than the first 25.
 */
export const VOCABULARY_MATCH_LIMIT = 25;

/**
 * Cheap-source candidate count below which the fuzzy trigram pass is worth
 * running.
 *
 * Trigram matching on a large table is the single most expensive part of blog
 * search — measured at ~360 ms against 53k rows when the planner chooses a
 * sequential scan, versus ~1 ms for the full-text and prefix sources. It is also
 * only ever *useful* when the cheap sources came up empty, i.e. when the user
 * misspelled something.
 *
 * So it is gated: the fuzzy CTE carries a one-time filter on the cheap-source
 * count, which Postgres evaluates once and, when false, skips the scan
 * altogether (`One-Time Filter: false` in the plan). Typo tolerance is preserved
 * exactly where it matters and costs nothing where it does not.
 */
export const FUZZY_FALLBACK_THRESHOLD = 10;
