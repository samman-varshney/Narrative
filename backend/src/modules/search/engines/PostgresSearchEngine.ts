import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma';
import { AppError } from '../../../core/exceptions/AppError';
import { supportsTrigram } from '../search.query';
import {
  SCORE_SCALE,
  cursorFingerprint,
  decodeCursor,
  encodeCursor,
  type CursorPosition,
} from '../search.cursor';
import type {
  BlogHit,
  BlogSearchFilters,
  CategoryHit,
  EnginePage,
  NormalizedQuery,
  SearchPageRequest,
  SearchSort,
  SearchTermSummary,
  Suggestion,
  TagHit,
  UserHit,
} from '../search.types';
import type { ISearchEngine } from './ISearchEngine';
import {
  BLOG_WEIGHTS,
  CANDIDATE_LIMIT,
  VOCABULARY_MATCH_LIMIT,
  FUZZY_FALLBACK_THRESHOLD,
  RECENCY_DECAY_SECONDS,
  TERM_WEIGHTS,
  USER_WEIGHTS,
} from './ranking';

/**
 * PostgreSQL-backed search engine.
 *
 * Every line of search-specific SQL in this codebase lives in this file. That is
 * the whole point of the `ISearchEngine` seam: services, controllers and
 * validators above it contain no SQL, and replacing this class with an
 * OpenSearch implementation touches nothing else.
 *
 * ── Retrieval strategy: bounded top-K, not exhaustive scan ──────────────────
 * A naive "score every row, then sort" is fine on ten thousand blogs and fatal
 * on ten million. Instead each query runs as:
 *
 *   1. CANDIDATE GENERATION — several index-backed sources each contribute at
 *      most CANDIDATE_LIMIT rows, ordered by their own relevance measure:
 *
 *        fts            GIN over the weighted title(A)/subtitle(B) tsvector
 *        title_prefix   B-tree over lower(title) text_pattern_ops
 *        tag_match      Tag trigram/prefix -> BlogTag -> Blog
 *        category_match Category trigram/prefix -> BlogCategory -> Blog
 *        author_match   User trigram/prefix -> Blog by authorId
 *        title_fuzzy    GIN trigram over title  (GATED, see below)
 *
 *   2. RANKING — the union is scored once, in SQL, using `BLOG_WEIGHTS`.
 *
 *   3. KEYSET PAGE — the scored set is cut with a `(score, timestamp, id)`
 *      comparison and ordered deterministically.
 *
 * ── The gated fuzzy pass ────────────────────────────────────────────────────
 * `title % $q` is the most expensive source by an order of magnitude (measured
 * at ~360 ms over 53k rows when the planner picks a sequential scan, against
 * ~1-3 ms for the others). It is also only useful when the cheap sources found
 * nothing — i.e. when the user made a typo. So it carries a one-time filter on
 * the cheap-source count: Postgres evaluates it once and, when the cheap
 * sources already produced enough, reports `One-Time Filter: false` and never
 * touches the table. Typo tolerance where it matters, zero cost where it does
 * not.
 *
 * ── Index coupling ──────────────────────────────────────────────────────────
 * `BLOG_FTS_EXPRESSION` below must stay character-identical to the expression in
 * `prisma/sql/search_indexes.sql`. Postgres matches expression indexes
 * structurally; a stray change turns every full-text search into a sequential
 * scan with no error to notice. The visibility predicate is likewise emitted as
 * SQL LITERALS rather than bind parameters, because the planner can only prove a
 * partial index applies against constants.
 *
 * ── Injection safety ────────────────────────────────────────────────────────
 * All user-derived values are bound as parameters via `Prisma.sql` tagged
 * templates. `Prisma.raw` appears only around compile-time module constants and
 * fixed column names — never around anything reachable from a request.
 */

/** Text-search configuration. Must match `search_indexes.sql`. */
const FTS_CONFIG = 'english';

/**
 * The weighted full-text vector for a blog aliased `b`.
 * MUST match `blog_search_fts_idx` in prisma/sql/search_indexes.sql.
 */
const BLOG_FTS_EXPRESSION = `(
    setweight(to_tsvector('${FTS_CONFIG}', coalesce(b."title", '')), 'A') ||
    setweight(to_tsvector('${FTS_CONFIG}', coalesce(b."subtitle", '')), 'B')
  )`;

/**
 * The public-visibility predicate for a blog aliased `b`.
 *
 * Emitted as literals on purpose — see the note on partial indexes above. This
 * is also the module's single source of truth for "what the public may see":
 * drafts, archived posts, soft-deleted posts, and non-PUBLIC posts are excluded
 * here, once, for every query in the file.
 */
const PUBLIC_BLOG_PREDICATE = `b."status" = 'PUBLISHED' AND b."visibility" = 'PUBLIC'`;

/**
 * The text-search config as a SQL LITERAL, not a bind parameter.
 *
 * `websearch_to_tsquery` is overloaded on `(regconfig, text)` and `(text)`; an
 * untyped bind parameter leaves Postgres unable to resolve which. Emitting the
 * literal also keeps this identical in form to the config baked into
 * `blog_search_fts_idx`, which is what lets the planner match the expression
 * index at all.
 */
const TS_CONFIG = Prisma.raw(`'${FTS_CONFIG}'`);

const FTS = Prisma.raw(BLOG_FTS_EXPRESSION);
const PUBLIC_BLOG = Prisma.raw(PUBLIC_BLOG_PREDICATE);
const CANDIDATES = Prisma.raw(String(CANDIDATE_LIMIT));
const VOCABULARY = Prisma.raw(String(VOCABULARY_MATCH_LIMIT));

/**
 * Decimal places every score is rounded to, as a SQL fragment.
 *
 * Taken from the cursor module rather than hardcoded: the cursor carries the
 * score as fixed-scale decimal TEXT and compares it back as `numeric`, so the
 * rounding here and the scale there must agree exactly. Wiring them to one
 * constant makes that a fact rather than a comment.
 */
const ROUND_TO = Prisma.raw(String(SCORE_SCALE));

/** Row shape returned by the blog search query. */
interface BlogRow {
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  cover_image: string | null;
  reading_time: number;
  published_at: Date | null;
  sort_at: Date;
  /** Exact fixed-scale decimal text — the value the cursor carries. */
  score_key: string;
  author_id: string;
  author_username: string;
  author_name: string;
  author_avatar: string | null;
  author_verified: boolean;
}

interface UserRow {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  bio: string | null;
  is_verified: boolean;
  created_at: Date;
  score_key: string;
}

interface TermRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  blog_count: number;
  score_key: string;
}

interface SuggestionRow {
  text: string;
  source: string;
  slug: string | null;
}

/** Longest excerpt shipped per hit. Keeps a 100-item page's payload bounded. */
const MAX_EXCERPT_LENGTH = 200;

export class PostgresSearchEngine implements ISearchEngine {
  readonly name = 'postgres';

  // ---- Blogs --------------------------------------------------------------

  async searchBlogs(
    query: NormalizedQuery,
    page: SearchPageRequest,
    filters: BlogSearchFilters
  ): Promise<EnginePage<BlogHit>> {
    const fingerprint = cursorFingerprint({
      query: query.normalized,
      sort: page.sort,
      filters,
    });
    const position = this.resolvePosition(page, fingerprint);

    const blogFilters = this.blogFilterClause(filters);
    const fuzzy = supportsTrigram(query);

    // Candidate sources. Each is index-backed, deterministically ordered, and
    // capped, so the union stays bounded no matter how common the term is.
    const sources: Prisma.Sql[] = [
      Prisma.sql`SELECT "id" FROM fts`,
      Prisma.sql`SELECT "id" FROM title_prefix`,
      Prisma.sql`SELECT "id" FROM tag_match`,
      Prisma.sql`SELECT "id" FROM category_match`,
      Prisma.sql`SELECT "id" FROM author_match`,
    ];

    const rows = await prisma.$queryRaw<BlogRow[]>`
      WITH
      fts AS (
        SELECT b."id",
               ts_rank_cd(${FTS}, websearch_to_tsquery(${TS_CONFIG}, ${query.raw}), 32) AS r
        FROM "Blog" b
        WHERE ${PUBLIC_BLOG}
          AND ${FTS} @@ websearch_to_tsquery(${TS_CONFIG}, ${query.raw})
          ${blogFilters}
        ORDER BY r DESC, b."id" DESC
        LIMIT ${CANDIDATES}
      ),
      title_prefix AS (
        SELECT b."id"
        FROM "Blog" b
        WHERE ${PUBLIC_BLOG}
          AND lower(b."title") LIKE ${query.prefixPattern} ESCAPE '\\'
          ${blogFilters}
        -- Shortest title first: the tightest prefix match is the best one.
        ORDER BY length(b."title") ASC, b."id" DESC
        LIMIT ${CANDIDATES}
      ),
      matched_tags AS (
        SELECT t."id",
               greatest(
                 similarity(t."name", ${query.normalized}),
                 CASE WHEN lower(t."name") LIKE ${query.prefixPattern} ESCAPE '\\' THEN 0.9 ELSE 0 END
               ) AS r
        FROM "Tag" t
        WHERE ${this.termMatchClause(Prisma.raw('t."name"'), query)}
        ORDER BY r DESC, t."id" DESC
        LIMIT ${VOCABULARY}
      ),
      tag_match AS (
        SELECT b."id", max(mt.r) AS r
        FROM matched_tags mt
        JOIN "BlogTag" bt ON bt."tagId" = mt."id"
        JOIN "Blog" b ON b."id" = bt."blogId"
        WHERE ${PUBLIC_BLOG} ${blogFilters}
        GROUP BY b."id"
        ORDER BY r DESC, b."id" DESC
        LIMIT ${CANDIDATES}
      ),
      matched_categories AS (
        SELECT c."id",
               greatest(
                 similarity(c."name", ${query.normalized}),
                 CASE WHEN lower(c."name") LIKE ${query.prefixPattern} ESCAPE '\\' THEN 0.9 ELSE 0 END
               ) AS r
        FROM "Category" c
        WHERE ${this.termMatchClause(Prisma.raw('c."name"'), query)}
        ORDER BY r DESC, c."id" DESC
        LIMIT ${VOCABULARY}
      ),
      category_match AS (
        SELECT b."id", max(mc.r) AS r
        FROM matched_categories mc
        JOIN "BlogCategory" bc ON bc."categoryId" = mc."id"
        JOIN "Blog" b ON b."id" = bc."blogId"
        WHERE ${PUBLIC_BLOG} ${blogFilters}
        GROUP BY b."id"
        ORDER BY r DESC, b."id" DESC
        LIMIT ${CANDIDATES}
      ),
      matched_authors AS (
        SELECT u."id",
               greatest(
                 similarity(u."username", ${query.normalized}),
                 similarity(u."name", ${query.normalized}),
                 CASE WHEN lower(u."username") = ${query.normalized} THEN 1.0 ELSE 0 END
               ) AS r
        FROM "User" u
        WHERE u."status" = 'ACTIVE'
          AND (
            ${this.termMatchClause(Prisma.raw('u."username"'), query)}
            OR ${this.termMatchClause(Prisma.raw('u."name"'), query)}
          )
        ORDER BY r DESC, u."id" DESC
        LIMIT ${VOCABULARY}
      ),
      author_match AS (
        SELECT b."id", max(ma.r) AS r
        FROM matched_authors ma
        JOIN "Blog" b ON b."authorId" = ma."id"
        WHERE ${PUBLIC_BLOG} ${blogFilters}
        GROUP BY b."id"
        ORDER BY r DESC, b."id" DESC
        LIMIT ${CANDIDATES}
      ),
      -- Referenced twice (once for the union, once by the fuzzy gate), so
      -- Postgres materializes it and the cheap sources run exactly once.
      cheap AS (
        ${Prisma.join(sources, ' UNION ')}
      ),
      title_fuzzy AS (
        SELECT b."id"
        FROM "Blog" b
        WHERE ${
          fuzzy
            ? Prisma.sql`(SELECT count(*) FROM cheap) < ${FUZZY_FALLBACK_THRESHOLD}
          AND ${PUBLIC_BLOG}
          AND b."title" % ${query.normalized}
          ${blogFilters}`
            : // Query is too short for trigrams to be meaningful; the anchored
              // prefix B-tree already covers it. Emitted as an unsatisfiable
              // predicate so the CTE still exists for the union below.
              Prisma.sql`false`
        }
        ORDER BY similarity(b."title", ${query.normalized}) DESC, b."id" DESC
        LIMIT ${CANDIDATES}
      ),
      candidates AS (
        SELECT "id" FROM cheap
        UNION
        SELECT "id" FROM title_fuzzy
      ),
      scored AS (
        SELECT
          b."id",
          b."title",
          b."slug",
          b."subtitle",
          b."coverImage"          AS cover_image,
          b."readingTimeMinutes"  AS reading_time,
          b."publishedAt"         AS published_at,
          coalesce(b."publishedAt", b."createdAt") AS sort_at,
          u."id"          AS author_id,
          u."username"    AS author_username,
          u."name"        AS author_name,
          u."avatar"      AS author_avatar,
          u."isVerified"  AS author_verified,
          round((
              ${Prisma.raw(String(BLOG_WEIGHTS.EXACT_TITLE))}
                * (CASE WHEN lower(b."title") = ${query.normalized} THEN 1 ELSE 0 END)
            + ${Prisma.raw(String(BLOG_WEIGHTS.TITLE_PREFIX))}
                * (CASE WHEN lower(b."title") LIKE ${query.prefixPattern} ESCAPE '\\' THEN 1 ELSE 0 END)
            + ${Prisma.raw(String(BLOG_WEIGHTS.FULL_TEXT))}   * coalesce(f.r, 0)
            + ${Prisma.raw(String(BLOG_WEIGHTS.TITLE_FUZZY))} * similarity(b."title", ${query.normalized})
            + ${Prisma.raw(String(BLOG_WEIGHTS.TAXONOMY))}
                * greatest(coalesce(tm.r, 0), coalesce(cm.r, 0))
            + ${Prisma.raw(String(BLOG_WEIGHTS.AUTHOR))}      * coalesce(am.r, 0)
            + ${Prisma.raw(String(BLOG_WEIGHTS.RECENCY))}     * ${this.recencyExpression(
              'coalesce(b."publishedAt", b."createdAt")'
            )}
          )::numeric, ${ROUND_TO}) AS score
        FROM candidates cd
        JOIN "Blog" b ON b."id" = cd."id"
        JOIN "User" u ON u."id" = b."authorId"
        LEFT JOIN fts f            ON f."id"  = b."id"
        LEFT JOIN tag_match tm     ON tm."id" = b."id"
        LEFT JOIN category_match cm ON cm."id" = b."id"
        LEFT JOIN author_match am  ON am."id" = b."id"
        -- Blogs by suspended or deleted authors never surface publicly. Every
        -- candidate source already enforced the blog-level visibility rules.
        WHERE u."status" = 'ACTIVE'
      )
      SELECT s.*, s."score"::text AS score_key
      FROM scored s
      WHERE true ${this.keysetPredicate(page.sort, BLOG_KEYSET, position)}
      ${this.keysetOrder(page.sort, BLOG_KEYSET)}
      LIMIT ${page.limit + 1}
    `;

    // Explicit type arguments: TS infers `TExtra` from `toHit`'s parameter
    // before it reaches `hydrate`, and would settle on `unknown`.
    return this.buildPage<BlogRow, BlogHit, BlogTaxonomy>(rows, page, fingerprint, {
      toHit: (row, taxonomy) => this.toBlogHit(row, taxonomy),
      timestampOf: (row) => row.sort_at,
      hydrate: (pageRows) => this.loadTaxonomy(pageRows.map((r) => r.id)),
    });
  }

  // ---- Users --------------------------------------------------------------

  async searchUsers(
    query: NormalizedQuery,
    page: SearchPageRequest
  ): Promise<EnginePage<UserHit>> {
    const fingerprint = cursorFingerprint({ query: query.normalized, sort: page.sort });
    const position = this.resolvePosition(page, fingerprint);

    const rows = await prisma.$queryRaw<UserRow[]>`
      WITH scored AS (
        SELECT
          u."id",
          u."username",
          u."name",
          u."avatar",
          u."bio",
          u."isVerified" AS is_verified,
          u."createdAt"  AS created_at,
          round((
              ${Prisma.raw(String(USER_WEIGHTS.EXACT_USERNAME))}
                * (CASE WHEN lower(u."username") = ${query.normalized} THEN 1 ELSE 0 END)
            + ${Prisma.raw(String(USER_WEIGHTS.USERNAME_PREFIX))}
                * (CASE WHEN lower(u."username") LIKE ${query.prefixPattern} ESCAPE '\\' THEN 1 ELSE 0 END)
            + ${Prisma.raw(String(USER_WEIGHTS.NAME_PREFIX))}
                * (CASE WHEN lower(u."name") LIKE ${query.prefixPattern} ESCAPE '\\' THEN 1 ELSE 0 END)
            + ${Prisma.raw(String(USER_WEIGHTS.USERNAME_FUZZY))} * similarity(u."username", ${query.normalized})
            + ${Prisma.raw(String(USER_WEIGHTS.NAME_FUZZY))}     * similarity(u."name", ${query.normalized})
            + ${Prisma.raw(String(USER_WEIGHTS.VERIFIED))}
                * (CASE WHEN u."isVerified" THEN 1 ELSE 0 END)
          )::numeric, ${ROUND_TO}) AS score
        FROM "User" u
        LEFT JOIN "UserSettings" us ON us."userId" = u."id"
        -- Privacy gate. Suspended and deleted accounts are invisible, and so are
        -- accounts that opted into a private profile: surfacing those in a
        -- ranked list would make the directory enumerable, which is exactly what
        -- the setting exists to prevent. They remain reachable by exact
        -- username through the User module's profile endpoint, which applies its
        -- own minimal-disclosure rules.
        WHERE u."status" = 'ACTIVE'
          AND coalesce(us."isPrivate", false) = false
          AND (
            ${this.termMatchClause(Prisma.raw('u."username"'), query)}
            OR ${this.termMatchClause(Prisma.raw('u."name"'), query)}
          )
      )
      SELECT s.*, s."score"::text AS score_key
      FROM scored s
      WHERE true ${this.keysetPredicate(page.sort, USER_KEYSET, position)}
      ${this.keysetOrder(page.sort, USER_KEYSET)}
      LIMIT ${page.limit + 1}
    `;

    return this.buildPage(rows, page, fingerprint, {
      toHit: (row) => ({
        id: row.id,
        username: row.username,
        name: row.name,
        avatar: row.avatar,
        bio: row.bio,
        isVerified: row.is_verified,
        score: Number(row.score_key),
      }),
      timestampOf: (row) => row.created_at,
    });
  }

  // ---- Tags & categories --------------------------------------------------

  searchTags(query: NormalizedQuery, page: SearchPageRequest): Promise<EnginePage<TagHit>> {
    return this.searchVocabulary(query, page, 'tag');
  }

  searchCategories(
    query: NormalizedQuery,
    page: SearchPageRequest
  ): Promise<EnginePage<CategoryHit>> {
    return this.searchVocabulary(query, page, 'category');
  }

  /**
   * Shared implementation for the two flat vocabularies.
   *
   * `blogCount` is computed in the OUTER select, after the page has been cut, so
   * the per-term counting join runs for at most `limit + 1` rows instead of every
   * matching term. On a popular tag that join walks thousands of BlogTag rows;
   * doing it before the LIMIT would make a 20-item page pay for the entire
   * vocabulary.
   */
  private async searchVocabulary<T extends TagHit>(
    query: NormalizedQuery,
    page: SearchPageRequest,
    kind: 'tag' | 'category'
  ): Promise<EnginePage<T>> {
    const fingerprint = cursorFingerprint({
      query: query.normalized,
      sort: page.sort,
      filters: { kind },
    });
    const position = this.resolvePosition(page, fingerprint);

    const table = Prisma.raw(kind === 'tag' ? '"Tag"' : '"Category"');
    const linkTable = Prisma.raw(kind === 'tag' ? '"BlogTag"' : '"BlogCategory"');
    const linkColumn = Prisma.raw(kind === 'tag' ? '"tagId"' : '"categoryId"');

    const rows = await prisma.$queryRaw<TermRow[]>`
      WITH scored AS (
        SELECT
          e."id",
          e."name",
          e."slug",
          e."createdAt" AS created_at,
          round((
              ${Prisma.raw(String(TERM_WEIGHTS.EXACT_NAME))}
                * (CASE WHEN lower(e."name") = ${query.normalized} THEN 1 ELSE 0 END)
            + ${Prisma.raw(String(TERM_WEIGHTS.NAME_PREFIX))}
                * (CASE WHEN lower(e."name") LIKE ${query.prefixPattern} ESCAPE '\\' THEN 1 ELSE 0 END)
            + ${Prisma.raw(String(TERM_WEIGHTS.NAME_FUZZY))} * similarity(e."name", ${query.normalized})
          )::numeric, ${ROUND_TO}) AS score
        FROM ${table} e
        WHERE ${this.termMatchClause(Prisma.raw('e."name"'), query)}
      ),
      pageRows AS (
        SELECT s.*, s."score"::text AS score_key
        FROM scored s
        WHERE true ${this.keysetPredicate(page.sort, TERM_KEYSET, position)}
        ${this.keysetOrder(page.sort, TERM_KEYSET)}
        LIMIT ${page.limit + 1}
      )
      SELECT p.*,
             (
               SELECT count(*)::int
               FROM ${linkTable} lt
               JOIN "Blog" b ON b."id" = lt."blogId"
               WHERE lt.${linkColumn} = p."id" AND ${PUBLIC_BLOG}
             ) AS blog_count
      FROM pageRows p
      ${this.keysetOrder(page.sort, TERM_KEYSET, 'p')}
    `;

    return this.buildPage(rows, page, fingerprint, {
      toHit: (row) =>
        ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          blogCount: Number(row.blog_count ?? 0),
          score: Number(row.score_key),
        }) as T,
      timestampOf: (row) => row.created_at,
    });
  }

  // ---- Suggestions --------------------------------------------------------

  async suggest(query: NormalizedQuery, limit: number): Promise<Suggestion[]> {
    // Each source is capped at the requested limit rather than a fraction of it,
    // so a query that only matches tags still fills the list.
    const perSource = Prisma.raw(String(Math.max(1, Math.min(limit, 20))));

    const rows = await prisma.$queryRaw<SuggestionRow[]>`
      WITH merged AS (
        (
          SELECT t."name" AS text, 'TAG' AS source, t."slug" AS slug,
                 ${this.vocabularyScore(Prisma.raw('t."name"'), query)} AS score
          FROM "Tag" t
          WHERE ${this.termMatchClause(Prisma.raw('t."name"'), query)}
          ORDER BY score DESC, t."name" ASC
          LIMIT ${perSource}
        )
        UNION ALL
        (
          SELECT c."name" AS text, 'CATEGORY' AS source, c."slug" AS slug,
                 ${this.vocabularyScore(Prisma.raw('c."name"'), query)} AS score
          FROM "Category" c
          WHERE ${this.termMatchClause(Prisma.raw('c."name"'), query)}
          ORDER BY score DESC, c."name" ASC
          LIMIT ${perSource}
        )
        UNION ALL
        (
          SELECT u."username" AS text, 'USER' AS source, u."username" AS slug,
                 ${this.vocabularyScore(Prisma.raw('u."username"'), query)} AS score
          FROM "User" u
          LEFT JOIN "UserSettings" us ON us."userId" = u."id"
          WHERE u."status" = 'ACTIVE'
            AND coalesce(us."isPrivate", false) = false
            AND ${this.termMatchClause(Prisma.raw('u."username"'), query)}
          ORDER BY score DESC, u."username" ASC
          LIMIT ${perSource}
        )
        UNION ALL
        (
          SELECT b."title" AS text, 'BLOG' AS source, b."slug" AS slug,
                 ${this.vocabularyScore(Prisma.raw('b."title"'), query)} AS score
          FROM "Blog" b
          WHERE ${PUBLIC_BLOG}
            AND ${this.termMatchClause(Prisma.raw('b."title"'), query)}
          ORDER BY score DESC, length(b."title") ASC, b."id" DESC
          LIMIT ${perSource}
        )
      )
      SELECT text, source, slug
      FROM merged
      ORDER BY score DESC, length(text) ASC, text ASC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      text: row.text,
      source: row.source as Suggestion['source'],
      ...(row.slug ? { slug: row.slug } : {}),
    }));
  }

  // ---- SQL fragment builders ---------------------------------------------

  /**
   * "This column matches the query" — an anchored prefix match, plus trigram
   * similarity when the query is long enough for trigrams to mean anything.
   *
   * Both halves are index-backed (a `text_pattern_ops` B-tree and a
   * `gin_trgm_ops` GIN respectively). For one- and two-character queries the
   * trigram half is omitted entirely: pg_trgm would produce only padded prefix
   * grams, which matches almost everything and scans almost everything.
   */
  private termMatchClause(column: Prisma.Sql, query: NormalizedQuery): Prisma.Sql {
    const prefix = Prisma.sql`lower(${column}) LIKE ${query.prefixPattern} ESCAPE '\\'`;
    if (!supportsTrigram(query)) return prefix;
    return Prisma.sql`(${prefix} OR ${column} % ${query.normalized})`;
  }

  /** Shared name-relevance expression for the suggestion sources. */
  private vocabularyScore(column: Prisma.Sql, query: NormalizedQuery): Prisma.Sql {
    return Prisma.sql`greatest(
      CASE WHEN lower(${column}) = ${query.normalized} THEN 1.0 ELSE 0 END,
      CASE WHEN lower(${column}) LIKE ${query.prefixPattern} ESCAPE '\\' THEN 0.9 ELSE 0 END,
      similarity(${column}, ${query.normalized})
    )`;
  }

  /**
   * Exponential freshness decay in [0, 1].
   *
   * `now()` is quantized to the day. Left at full resolution the score would
   * drift by a hair between two requests of the same paginated walk, and a
   * keyset cursor comparing `score = :score` would start skipping or repeating
   * rows. Day granularity makes the score stable for the entire life of any
   * realistic pagination session.
   *
   * `greatest(0, ...)` guards a future-dated `publishedAt`, which would
   * otherwise produce a boost above 1.
   */
  private recencyExpression(timestampSql: string): Prisma.Sql {
    return Prisma.raw(`exp(
              -greatest(0, extract(epoch FROM (date_trunc('day', now()) - ${timestampSql})))
              / ${RECENCY_DECAY_SECONDS}.0
            )`);
  }

  /**
   * Structured blog filters, referencing ONLY the `b` alias so the same fragment
   * can be pasted into every candidate CTE.
   *
   * Applying filters during candidate generation rather than after it is
   * load-bearing: with a `?author=` filter, an unfiltered candidate pass could
   * spend its whole CANDIDATE_LIMIT budget on posts by other authors and return
   * an empty page while matches existed.
   */
  private blogFilterClause(filters: BlogSearchFilters): Prisma.Sql {
    const clauses: Prisma.Sql[] = [];

    if (filters.author) {
      // EXISTS rather than a join so the fragment stays alias-local.
      clauses.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "User" fu
        WHERE fu."id" = b."authorId" AND lower(fu."username") = ${filters.author.toLowerCase()}
      )`);
    }
    if (filters.tags?.length) {
      clauses.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "BlogTag" ft
        JOIN "Tag" ftg ON ftg."id" = ft."tagId"
        WHERE ft."blogId" = b."id" AND ftg."slug" IN (${Prisma.join(filters.tags)})
      )`);
    }
    if (filters.categories?.length) {
      clauses.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "BlogCategory" fc
        JOIN "Category" fcg ON fcg."id" = fc."categoryId"
        WHERE fc."blogId" = b."id" AND fcg."slug" IN (${Prisma.join(filters.categories)})
      )`);
    }
    if (filters.from) clauses.push(Prisma.sql`b."publishedAt" >= ${filters.from}`);
    if (filters.to) clauses.push(Prisma.sql`b."publishedAt" <= ${filters.to}`);
    if (filters.minReadingTime !== undefined) {
      clauses.push(Prisma.sql`b."readingTimeMinutes" >= ${filters.minReadingTime}`);
    }
    if (filters.maxReadingTime !== undefined) {
      clauses.push(Prisma.sql`b."readingTimeMinutes" <= ${filters.maxReadingTime}`);
    }

    if (clauses.length === 0) return Prisma.empty;
    return Prisma.sql` AND ${Prisma.join(clauses, ' AND ')}`;
  }

  /** `ORDER BY` for a keyset walk. Always ends on the id, so the order is total. */
  private keysetOrder(sort: SearchSort, cols: KeysetColumns, alias?: string): Prisma.Sql {
    const q = (column: string) => (alias ? `${alias}."${column}"` : `"${column}"`);
    if (sort === 'relevance') {
      return Prisma.raw(
        `ORDER BY ${q(cols.score)} DESC, ${q(cols.timestamp)} DESC, ${q(cols.id)} DESC`
      );
    }
    const direction = sort === 'oldest' ? 'ASC' : 'DESC';
    return Prisma.raw(
      `ORDER BY ${q(cols.timestamp)} ${direction}, ${q(cols.id)} ${direction}`
    );
  }

  /**
   * The keyset cut. A row-value comparison rather than the usual
   * `ts < :ts OR (ts = :ts AND id < :id)` expansion: it is the same semantics,
   * but Postgres evaluates it as one tuple comparison and it cannot be written
   * subtly wrong.
   */
  private keysetPredicate(
    sort: SearchSort,
    cols: KeysetColumns,
    position?: CursorPosition
  ): Prisma.Sql {
    if (!position) return Prisma.empty;

    const operator = Prisma.raw(sort === 'oldest' ? '>' : '<');
    const score = Prisma.raw(`"${cols.score}"`);
    const timestamp = Prisma.raw(`"${cols.timestamp}"`);
    const id = Prisma.raw(`"${cols.id}"`);

    if (sort === 'relevance') {
      return Prisma.sql` AND (${score}, ${timestamp}, ${id}) ${operator} (${position.score}::numeric, ${position.timestamp}::timestamptz, ${position.id}::text)`;
    }
    return Prisma.sql` AND (${timestamp}, ${id}) ${operator} (${position.timestamp}::timestamptz, ${position.id}::text)`;
  }

  // ---- Page assembly ------------------------------------------------------

  /**
   * Validates the incoming cursor against the fingerprint of THIS query.
   *
   * A relevance cursor without a score is structurally impossible to honour —
   * it means the cursor was minted for a different sort — so it is rejected as
   * invalid rather than silently degraded into an unbounded scan.
   */
  private resolvePosition(
    page: SearchPageRequest,
    fingerprint: string
  ): CursorPosition | undefined {
    if (!page.cursor) return undefined;
    const position = decodeCursor(page.cursor, fingerprint);
    if (page.sort === 'relevance' && position.score === null) {
      throw new AppError('Invalid or expired search cursor', 400, 'INVALID_CURSOR');
    }
    return position;
  }

  /**
   * Trims the sentinel row, mints the next cursor, and maps rows to hits.
   *
   * `hydrate` runs AFTER trimming, so the extra row fetched to detect
   * `hasMore` never triggers a taxonomy lookup for a blog nobody will see.
   */
  private async buildPage<TRow extends { id: string; score_key: string }, THit, TExtra>(
    rows: TRow[],
    page: SearchPageRequest,
    fingerprint: string,
    mapper: {
      toHit: (row: TRow, extra: TExtra) => THit;
      timestampOf: (row: TRow) => Date;
      hydrate?: (rows: TRow[]) => Promise<TExtra>;
    }
  ): Promise<EnginePage<THit>> {
    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;

    const extra = mapper.hydrate
      ? await mapper.hydrate(pageRows)
      : (undefined as unknown as TExtra);

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            fingerprint,
            score: page.sort === 'relevance' ? last.score_key : null,
            timestamp: mapper.timestampOf(last),
            id: last.id,
          })
        : null;

    return { items: pageRows.map((row) => mapper.toHit(row, extra)), nextCursor, hasMore };
  }

  /**
   * Loads tags and categories for one page of blogs in two queries total.
   *
   * The obvious alternative — a `LEFT JOIN` inside the ranking query — would
   * multiply every scored row by its tag count before the LIMIT, and the
   * equally obvious per-row lookup is a textbook N+1. Two batched reads over an
   * already-trimmed id list is neither.
   */
  private async loadTaxonomy(blogIds: string[]): Promise<BlogTaxonomy> {
    const empty: BlogTaxonomy = { tags: new Map(), categories: new Map() };
    if (blogIds.length === 0) return empty;

    const [tagLinks, categoryLinks] = await Promise.all([
      prisma.blogTag.findMany({
        where: { blogId: { in: blogIds } },
        select: { blogId: true, tag: { select: { id: true, name: true, slug: true } } },
        orderBy: { addedAt: 'asc' },
      }),
      prisma.blogCategory.findMany({
        where: { blogId: { in: blogIds } },
        select: {
          blogId: true,
          category: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { addedAt: 'asc' },
      }),
    ]);

    for (const link of tagLinks) {
      push(empty.tags, link.blogId, link.tag);
    }
    for (const link of categoryLinks) {
      push(empty.categories, link.blogId, link.category);
    }
    return empty;
  }

  private toBlogHit(row: BlogRow, taxonomy: BlogTaxonomy): BlogHit {
    return {
      id: row.id,
      title: row.title,
      slug: row.slug,
      excerpt: truncate(row.subtitle, MAX_EXCERPT_LENGTH),
      coverImage: row.cover_image,
      author: {
        id: row.author_id,
        username: row.author_username,
        name: row.author_name,
        avatar: row.author_avatar,
        isVerified: row.author_verified,
      },
      tags: taxonomy.tags.get(row.id) ?? [],
      categories: taxonomy.categories.get(row.id) ?? [],
      readingTimeMinutes: Number(row.reading_time),
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
      score: Number(row.score_key),
    };
  }
}

/** Which output columns form the keyset for a given query. */
interface KeysetColumns {
  score: string;
  timestamp: string;
  id: string;
}

const BLOG_KEYSET: KeysetColumns = { score: 'score', timestamp: 'sort_at', id: 'id' };
const USER_KEYSET: KeysetColumns = { score: 'score', timestamp: 'created_at', id: 'id' };
const TERM_KEYSET: KeysetColumns = { score: 'score', timestamp: 'created_at', id: 'id' };

interface BlogTaxonomy {
  tags: Map<string, SearchTermSummary[]>;
  categories: Map<string, SearchTermSummary[]>;
}

function push(map: Map<string, SearchTermSummary[]>, key: string, value: SearchTermSummary) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export const postgresSearchEngine = new PostgresSearchEngine();
