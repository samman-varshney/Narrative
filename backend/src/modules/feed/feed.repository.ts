import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import { FEED_ELIGIBILITY } from './feed.eligibility';
import type { FeedBlogRow, FeedFilters, FeedTermSummary } from './feed.types';
import type { ChronologicalPosition } from './feed.cursor';

/**
 * The Feed module's data-access layer — every line of feed SQL in the codebase.
 *
 * Three retrieval shapes, one projection, one eligibility predicate:
 *
 *   findChronologicalPage  keyset walk, newest first  (following, latest)
 *   findRecentCandidates   newest N eligible blogs    (explore)
 *   findEligibleByIds      re-filter an id list       (explore, trending)
 *
 * The last one is what keeps ranked feeds honest. Explore and Trending get part
 * of their candidate ids from the Analytics module, which knows nothing about
 * blog lifecycle — an archived or withdrawn post still has yesterday's
 * engagement rows. Passing those ids back through the same eligibility SQL as
 * every other feed means there is exactly ONE place where "may this be seen"
 * is decided, no matter which module suggested the candidate.
 *
 * All four feeds share one eligibility predicate — there is no per-feed
 * visibility set to get wrong. See `feed.eligibility.ts`.
 *
 * ── What this file does NOT do ──────────────────────────────────────────────
 * No ranking (that is `feed.ranking.ts`), no caching (`feed.cache.ts`), no DTO
 * mapping (the service), and no knowledge of the follow graph: the followed-
 * author predicate arrives as an opaque SQL fragment owned by the Follow module.
 * Feed never names another module's table.
 */

/**
 * The shared column projection.
 *
 * Aliased to camelCase so rows arrive nearly DTO-shaped and the service's
 * mapping is a shape change rather than a rename table. `content` is absent by
 * construction — the heavy Tiptap document must never be pulled for a card —
 * and so are `status`, `visibility` and every internal counter.
 *
 * `sortAt` IS `publishedAt`, not a `coalesce`: eligibility already requires a
 * publication instant, and a `coalesce` in the ORDER BY would disqualify the
 * partial indexes these queries depend on.
 */
const FEED_COLUMNS = Prisma.raw(`
  b."id"                  AS "id",
  b."title"               AS "title",
  b."slug"                AS "slug",
  b."subtitle"            AS "subtitle",
  b."coverImage"          AS "coverImage",
  b."readingTimeMinutes"  AS "readingTimeMinutes",
  b."publishedAt"         AS "publishedAt",
  b."publishedAt"         AS "sortAt",
  b."authorId"            AS "authorId",
  u."username"            AS "authorUsername",
  u."name"                AS "authorName",
  u."avatar"              AS "authorAvatar",
  u."isVerified"          AS "authorVerified"
`);

/** Newest first, with the id tiebreak that makes the order total. */
const NEWEST_FIRST = Prisma.raw(`ORDER BY b."publishedAt" DESC, b."id" DESC`);

export interface ChronologicalPageParams {
  filters: FeedFilters;
  limit: number;
  position?: ChronologicalPosition;
  /**
   * Restricts the feed to a set of authors, as a SQL fragment produced by the
   * Follow module (`followService.followedAuthorIdsSql`). Opaque here on
   * purpose: Follow owns the shape of the follow graph, and Feed composing an
   * `IN (subquery)` around it is the whole of their coupling.
   */
  authorScope?: Prisma.Sql;
}

export class FeedRepository {
  /**
   * One keyset page of a chronological feed, newest first.
   *
   * Fetches `limit + 1` rows so the caller derives `hasMore` from a sentinel
   * rather than a second COUNT — the convention `buildCursorPage` established
   * for the rest of the platform.
   *
   * ── Why a semi-join and not an id list ──────────────────────────────────
   * The following feed passes `authorScope` as `IN (SELECT "followingId" ...)`.
   * The alternative — load the viewer's followed ids and inline them — breaks in
   * both directions at scale: a user following 5 000 authors ships 5 000
   * parameters on every page request, and the planner loses the option of
   * walking the published index in order and filtering, which is the plan that
   * makes a heavy follower's feed fast. Left as a subquery, Postgres picks
   * between that and a per-author index walk based on its own selectivity
   * estimate, which is exactly the decision it is better at than we are.
   */
  findChronologicalPage(params: ChronologicalPageParams): Promise<FeedBlogRow[]> {
    const { filters, limit, position, authorScope } = params;

    const scope = authorScope
      ? Prisma.sql` AND b."authorId" IN (${authorScope})`
      : Prisma.empty;

    return prisma.$queryRaw<FeedBlogRow[]>`
      SELECT ${FEED_COLUMNS}
      FROM "Blog" b
      JOIN "User" u ON u."id" = b."authorId"
      WHERE ${FEED_ELIGIBILITY}
        ${scope}
        ${this.filterClause(filters)}
        ${this.keysetPredicate(position)}
      ${NEWEST_FIRST}
      LIMIT ${limit + 1}
    `;
  }

  /**
   * The newest eligible blogs, for Explore's recency candidate source.
   *
   * No cursor: a ranked feed never pages this query. It produces the candidate
   * POOL, which is ranked and then paged from a snapshot.
   */
  findRecentCandidates(params: {
    filters: FeedFilters;
    limit: number;
  }): Promise<FeedBlogRow[]> {
    return prisma.$queryRaw<FeedBlogRow[]>`
      SELECT ${FEED_COLUMNS}
      FROM "Blog" b
      JOIN "User" u ON u."id" = b."authorId"
      WHERE ${FEED_ELIGIBILITY}
        ${this.filterClause(params.filters)}
      ${NEWEST_FIRST}
      LIMIT ${params.limit}
    `;
  }

  /**
   * Cards for a set of blog ids, re-checked against eligibility and filters.
   *
   * The gate every externally-suggested candidate passes through. Returns fewer
   * rows than it was given whenever a candidate has since been archived,
   * withdrawn, made private, or had its author suspended — silently and
   * correctly, because a feed's job is to omit those, not to explain them.
   */
  findEligibleByIds(params: {
    ids: string[];
    filters: FeedFilters;
  }): Promise<FeedBlogRow[]> {
    if (params.ids.length === 0) return Promise.resolve([]);

    return prisma.$queryRaw<FeedBlogRow[]>`
      SELECT ${FEED_COLUMNS}
      FROM "Blog" b
      JOIN "User" u ON u."id" = b."authorId"
      WHERE b."id" IN (${Prisma.join(params.ids)})
        AND ${FEED_ELIGIBILITY}
        ${this.filterClause(params.filters)}
    `;
  }

  /**
   * Tags and categories for one page of blogs, in two queries total.
   *
   * The obvious alternatives are both wrong: a `LEFT JOIN` in the feed query
   * would multiply every row by its tag count before the LIMIT, and a per-row
   * lookup is a textbook N+1. Two batched reads over an already-trimmed id list
   * is neither. Ordered by `addedAt` so the first tag is the one the author
   * chose first — which is what the diversity pass treats as the topic.
   */
  async loadTaxonomy(blogIds: string[]): Promise<FeedTaxonomy> {
    const taxonomy: FeedTaxonomy = { tags: new Map(), categories: new Map() };
    if (blogIds.length === 0) return taxonomy;

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

    for (const link of tagLinks) push(taxonomy.tags, link.blogId, link.tag);
    for (const link of categoryLinks) push(taxonomy.categories, link.blogId, link.category);
    return taxonomy;
  }

  // ---- SQL fragment builders ---------------------------------------------

  /**
   * The keyset cut, as a row-value comparison.
   *
   * `(publishedAt, id) < (:ts, :id)` rather than the hand-expanded
   * `ts < :ts OR (ts = :ts AND id < :id)`: identical semantics, evaluated as one
   * tuple comparison that a btree can drive directly, and impossible to write
   * subtly wrong. Collapses to nothing on the first page.
   */
  private keysetPredicate(position?: ChronologicalPosition): Prisma.Sql {
    if (!position) return Prisma.empty;
    return Prisma.sql` AND (b."publishedAt", b."id") < (${position.sortAt}::timestamptz, ${position.id}::text)`;
  }

  /**
   * Discovery filters, referencing only the `b` and `u` aliases so the same
   * fragment drops into every query in this file.
   *
   * Every value is BOUND. The taxonomy filters are `EXISTS` subqueries rather
   * than joins so a blog carrying three of the requested tags still appears
   * once — a join would duplicate it and quietly corrupt both the page size and
   * the keyset walk.
   */
  private filterClause(filters: FeedFilters): Prisma.Sql {
    const clauses: Prisma.Sql[] = [];

    if (filters.author) {
      clauses.push(Prisma.sql`lower(u."username") = ${filters.author.toLowerCase()}`);
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
    if (filters.minReadingTime !== undefined) {
      clauses.push(Prisma.sql`b."readingTimeMinutes" >= ${filters.minReadingTime}`);
    }
    if (filters.maxReadingTime !== undefined) {
      clauses.push(Prisma.sql`b."readingTimeMinutes" <= ${filters.maxReadingTime}`);
    }

    if (clauses.length === 0) return Prisma.empty;
    return Prisma.sql` AND ${Prisma.join(clauses, ' AND ')}`;
  }
}

/** Tags and categories for a page, keyed by blog id. */
export interface FeedTaxonomy {
  tags: Map<string, FeedTermSummary[]>;
  categories: Map<string, FeedTermSummary[]>;
}

function push(map: Map<string, FeedTermSummary[]>, key: string, value: FeedTermSummary): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export const feedRepository = new FeedRepository();
