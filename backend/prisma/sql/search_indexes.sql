-- Search & Discovery indexes.
--
-- None of this is expressible in Prisma's schema language: GIN indexes, trigram
-- operator classes, expression indexes over `to_tsvector`, and partial-index
-- WHERE clauses all live outside it. `prisma db push` therefore never creates
-- them, and every environment must run `npm run db:indexes` or production will
-- run a different index set than dev — exactly the drift that hides a sequential
-- scan until deploy day.
--
-- Every statement is idempotent (`IF NOT EXISTS`), so this is safe to re-run.
--
-- PRODUCTION NOTE: `CREATE INDEX` takes an ACCESS EXCLUSIVE lock for the
-- duration of the build. On a live database with a large "Blog"/"User" table,
-- run these once by hand with `CREATE INDEX CONCURRENTLY` instead (it cannot run
-- inside a transaction, and leaves an INVALID index behind if it fails, which is
-- why the automated bootstrap path below does not use it).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- Trigram matching: powers partial matching, typo tolerance, and the `%`
-- similarity operator used for fuzzy blog-title / username / tag lookups.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Blog
-- ---------------------------------------------------------------------------
-- Every Blog index below is PARTIAL on (status = PUBLISHED AND visibility =
-- PUBLIC). Public search never looks at anything else, so indexing drafts,
-- archived posts, deleted posts and private posts would only inflate the index
-- and slow every build. The engine's SQL repeats that predicate as a literal
-- (never as a bind parameter) so the planner can prove the partial index
-- applies — parameterising it would silently disqualify all of these.

-- Weighted full-text vector over title (A) and subtitle (B). An EXPRESSION
-- index rather than a stored generated column: `prisma db push` reconciles the
-- table against schema.prisma and would DROP a column it does not know about,
-- so a generated column would vanish on every sync and have to be rebuilt.
-- An index is invisible to that reconciliation.
--
-- The two-argument `to_tsvector(regconfig, text)` form is required — it is
-- IMMUTABLE, while the one-argument form depends on `default_text_search_config`
-- and is only STABLE, which Postgres refuses to index.
--
-- The identical expression is built in code by BLOG_FTS_EXPRESSION
-- (search/engines/PostgresSearchEngine.ts). If one changes, change both, or the
-- planner stops matching the index and silently falls back to a seq scan.
CREATE INDEX IF NOT EXISTS blog_search_fts_idx
  ON "Blog" USING GIN ((
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("subtitle", '')), 'B')
  ))
  WHERE "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC';

-- Trigram index over the title: serves `title % $q` (fuzzy / typo tolerance)
-- and `title ILIKE '%q%'` (substring). pg_trgm lowercases internally, so the
-- raw column is indexed rather than lower(title) — a lower() expression here
-- would NOT be used by the `%` operator.
CREATE INDEX IF NOT EXISTS blog_search_title_trgm_idx
  ON "Blog" USING GIN ("title" gin_trgm_ops)
  WHERE "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC';

-- B-tree over lower(title) with text_pattern_ops: serves exact-title equality
-- and anchored prefix matching (`lower(title) LIKE 'jav%'`). Trigram indexes
-- need >= 3 characters to help at all, so this is what keeps one- and
-- two-character typeahead queries off a sequential scan.
CREATE INDEX IF NOT EXISTS blog_search_title_lower_idx
  ON "Blog" (lower("title") text_pattern_ops)
  WHERE "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC';

-- Newest/oldest sorts and the recency component of the relevance score read
-- publishedAt over the same public subset. Blog already carries a
-- (status, publishedAt) composite; this partial variant is far smaller and
-- ordered exactly the way the `sort=newest` cursor walks it.
CREATE INDEX IF NOT EXISTS blog_search_published_idx
  ON "Blog" ("publishedAt" DESC, "id" DESC)
  WHERE "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC';

-- ---------------------------------------------------------------------------
-- User
-- ---------------------------------------------------------------------------
-- Not partial: `status` is not the only gate (UserSettings.isPrivate also
-- excludes rows, and it lives in another table), so a partial predicate could
-- not be proven by the planner for the whole filter anyway.

CREATE INDEX IF NOT EXISTS user_search_username_trgm_idx
  ON "User" USING GIN ("username" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS user_search_name_trgm_idx
  ON "User" USING GIN ("name" gin_trgm_ops);

-- Anchored prefix + exact match on the handle ("@gra" -> "grace").
CREATE INDEX IF NOT EXISTS user_search_username_lower_idx
  ON "User" (lower("username") text_pattern_ops);

CREATE INDEX IF NOT EXISTS user_search_name_lower_idx
  ON "User" (lower("name") text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Tag / Category
-- ---------------------------------------------------------------------------
-- Small vocabularies today, but they are read on every suggestions request —
-- the hottest search endpoint — so they are indexed like the big tables.

CREATE INDEX IF NOT EXISTS tag_search_name_trgm_idx
  ON "Tag" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS tag_search_name_lower_idx
  ON "Tag" (lower("name") text_pattern_ops);

CREATE INDEX IF NOT EXISTS category_search_name_trgm_idx
  ON "Category" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS category_search_name_lower_idx
  ON "Category" (lower("name") text_pattern_ops);
