-- Feed & Explore indexes.
--
-- Partial indexes are not expressible in Prisma's schema language, so
-- `prisma db push` never creates these. Every environment must run
-- `npm run db:indexes` or production will run a different index set than dev —
-- exactly the drift that hides a sequential scan until deploy day.
--
-- Every statement is idempotent, so this is safe to re-run.
--
-- PRODUCTION NOTE: `CREATE INDEX` takes an ACCESS EXCLUSIVE lock for the
-- duration of the build. On a live database with a large "Blog" table, run these
-- once by hand with `CREATE INDEX CONCURRENTLY` instead (it cannot run inside a
-- transaction and leaves an INVALID index behind if it fails, which is why the
-- automated bootstrap path below does not use it).

-- ---------------------------------------------------------------------------
-- Retired definitions
-- ---------------------------------------------------------------------------
-- Both indexes below were partial on `visibility IN ('PUBLIC', 'MEMBERS_ONLY')`,
-- from an earlier revision in which the Following feed surfaced members-only
-- posts. Feeds are now PUBLIC-only across the board (see feed.eligibility.ts),
-- which makes the first redundant with the Search index and the second wrong.
--
-- Dropped explicitly rather than left to `IF NOT EXISTS`: that clause matches on
-- NAME, so a re-run would silently keep an index whose PREDICATE no longer
-- matches the query and quietly stop being used. A no-op once they are gone.
DROP INDEX IF EXISTS blog_feed_published_idx;
DROP INDEX IF EXISTS blog_feed_author_published_idx;

-- ---------------------------------------------------------------------------
-- Shared with Search
-- ---------------------------------------------------------------------------
-- All four feeds walk PUBLISHED + PUBLIC blogs in publication order, which is
-- EXACTLY what `blog_search_published_idx` already indexes (see
-- search_indexes.sql):
--
--   ("publishedAt" DESC, "id" DESC) WHERE status = 'PUBLISHED' AND visibility = 'PUBLIC'
--
-- It is deliberately NOT duplicated here — two identical indexes double the
-- write cost of every publish for no read benefit. It is recorded instead: that
-- index now has two dependants, and dropping it with the Search module would
-- silently turn public discovery into a sequential scan as well.
--
-- This is also why there is no feed-specific index for the Latest, Explore or
-- Trending feeds, nor for the Following feed's "viewer follows many authors"
-- plan: all four are served by that one index.

-- ---------------------------------------------------------------------------
-- Following feed — the per-author plan
-- ---------------------------------------------------------------------------
-- The following feed is a semi-join against the follow graph, ordered by
-- publication time. Postgres has two good plans for it and the right one depends
-- on how many authors the viewer follows:
--
--   MANY follows — walk blogs in publication order and filter by the follow set,
--                  stopping as soon as the page is full. The more authors
--                  followed, the sooner that happens. Served by
--                  `blog_search_published_idx` above.
--
--   FEW follows  — walk each followed author's own posts. Needs `authorId` as
--                  the leading column, which is what this index provides. The
--                  existing `Blog_authorId_status_idx` (schema.prisma) can serve
--                  the same plan, but it is not partial on visibility and does
--                  not carry `publishedAt`, so it re-checks every row and cannot
--                  be scanned index-only.
CREATE INDEX IF NOT EXISTS blog_feed_author_public_idx
  ON "Blog" ("authorId", "publishedAt" DESC, "id" DESC)
  WHERE "status" = 'PUBLISHED' AND "visibility" = 'PUBLIC';

-- ---------------------------------------------------------------------------
-- Trending / Explore engagement candidates
-- ---------------------------------------------------------------------------
-- The Analytics module's discovery ranking scans "BlogAnalyticsDaily" over a
-- window and groups by blog. That range scan is served by the existing
-- @@index([date]) declared in schema.prisma — a window is a few days of rows,
-- and the leading column IS the date because, uniquely among analytics queries,
-- this one is not scoped to an author or a blog. No additional index is needed,
-- and one keyed on anything else would not help a query with no other predicate.
