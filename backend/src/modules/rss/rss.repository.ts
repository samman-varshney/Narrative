import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import { RSS_ELIGIBILITY } from './rss.eligibility';
import type {
  RssBlogRow,
  RssBlogTermIds,
  RssFeedScope,
  RssTaxonomy,
  SyndicationTerm,
} from './rss.types';

/**
 * The RSS module's data-access layer — every line of RSS SQL in the codebase.
 *
 * ── One query shape, four feeds ─────────────────────────────────────────────
 * All four feeds are the same query with a different scope predicate bolted on:
 * newest-first over the eligible set, bounded by `LIMIT`. There is no cursor
 * anywhere in this file, because RSS has no pagination — a feed is "the newest
 * N", which is why `MAX_ITEM_COUNT` is also the depth of the whole surface.
 *
 * ── No N+1, by construction ─────────────────────────────────────────────────
 * A rendered feed needs, per item: the post, its author, its SEO row, its cover
 * media, its tags and its categories. That is FOUR queries for a whole feed of
 * any size, and never more:
 *
 *   1. the rows          — post + author + SEO + cover, joined (this file)
 *   2. tags              — one batched read over the page's ids
 *   3. categories        — one batched read over the page's ids
 *   4. bodies            — only for rows that need an excerpt (see the service)
 *
 * The author, SEO and cover are JOINED rather than batched because they are
 * one-to-one and a join costs nothing; tags and categories are BATCHED rather
 * than joined because they are one-to-many and joining them would multiply every
 * blog row by its term count BEFORE the `LIMIT` — quietly returning fewer than
 * `limit` posts and making the feed size depend on how many tags its authors
 * happened to use. That is the classic mistake this shape exists to avoid, and
 * it is the same conclusion `feed.repository.loadTaxonomy` reached.
 *
 * ── Raw SQL, and why it has to be ───────────────────────────────────────────
 * Eligibility arrives as a `Prisma.Sql` fragment from the platform's single
 * discovery predicate (see `rss.eligibility.ts`), which is emitted with LITERAL
 * status and visibility values so Postgres can prove the PARTIAL indexes apply.
 * Expressing the same thing through the query builder would parameterise them
 * and silently disqualify every index — a sequential scan with nothing in the
 * logs to notice. Every value that comes from a REQUEST is bound; nothing
 * user-supplied is interpolated anywhere in this file.
 */

/**
 * The shared column projection.
 *
 * Aliased to camelCase so rows arrive nearly item-shaped. `content` is absent by
 * construction — pulling a page of Tiptap documents to build twenty short
 * excerpts would dominate the cost of the whole request — and so are `status`,
 * `visibility`, `isHidden` and every internal counter: they gate the query, they
 * are not published by it.
 *
 * The cover comes from the Media row rather than only from `Blog.coverImage`
 * because a feed enclosure needs a MIME type and a byte length that the
 * denormalized URL cannot supply. `m."publicId"` — the internal storage path —
 * is deliberately not selected, so it cannot reach a public document even by
 * accident.
 */
const RSS_COLUMNS = Prisma.raw(`
  b."id"              AS "id",
  b."title"           AS "title",
  b."slug"            AS "slug",
  b."subtitle"        AS "subtitle",
  b."coverImage"      AS "coverImage",
  b."publishedAt"     AS "publishedAt",
  b."updatedAt"       AS "updatedAt",
  b."authorId"        AS "authorId",
  u."username"        AS "authorUsername",
  u."name"            AS "authorName",
  seo."metaDescription" AS "metaDescription",
  seo."canonicalUrl"  AS "canonicalUrl",
  m."secureUrl"       AS "coverSecureUrl",
  m."mimeType"        AS "coverMimeType",
  m."fileSize"        AS "coverFileSize"
`);

/**
 * The joins every feed shares.
 *
 * `User` is an INNER join — eligibility requires an ACTIVE author, so a post
 * with no author row could never qualify anyway. `BlogSEO` and `Media` are LEFT
 * joins: most posts have neither, and an inner join would silently drop them.
 * The media join additionally excludes soft-deleted assets, so a cover whose
 * file has been removed produces an item with no enclosure rather than a
 * broken one.
 */
const RSS_JOINS = Prisma.raw(`
  JOIN "User" u        ON u."id" = b."authorId"
  LEFT JOIN "BlogSEO" seo ON seo."blogId" = b."id"
  LEFT JOIN "Media" m  ON m."id" = b."coverMediaId" AND m."deletedAt" IS NULL
`);

/** Newest first, with the id tiebreak that makes the order total. */
const NEWEST_FIRST = Prisma.raw(`ORDER BY b."publishedAt" DESC, b."id" DESC`);

export class RssRepository {
  /**
   * The feed query, as SQL.
   *
   * Public so the index report (`npm run rss:report`) and the query-plan test
   * can `EXPLAIN` EXACTLY the statement that runs in production, rather than a
   * hand-copied approximation of it that drifts the first time this file
   * changes. Building the statement and executing it are separate steps for
   * that reason alone; `findFeedRows` is the only caller that executes it.
   */
  buildFeedQuery(params: {
    scope: RssFeedScope;
    subjectId: string | null;
    limit: number;
  }): Prisma.Sql {
    return Prisma.sql`
      SELECT ${RSS_COLUMNS}
      FROM "Blog" b
      ${RSS_JOINS}
      WHERE ${RSS_ELIGIBILITY}
        ${this.scopeClause(params.scope, params.subjectId)}
      ${NEWEST_FIRST}
      LIMIT ${params.limit}
    `;
  }

  /**
   * One bounded, newest-first page of syndicatable posts.
   *
   * `limit` is bound, and the controller has already clamped it to
   * `MAX_ITEM_COUNT` — so an unbounded feed is not something a client can ask
   * for, and not something this method can be talked into producing.
   */
  findFeedRows(params: {
    scope: RssFeedScope;
    subjectId: string | null;
    limit: number;
  }): Promise<RssBlogRow[]> {
    return prisma.$queryRaw<RssBlogRow[]>(this.buildFeedQuery(params));
  }

  /**
   * Tags and categories for one page of posts, in two queries total.
   *
   * Ordered by `addedAt` so the first term is the one the author chose first —
   * which is the order a reader sees them in the feed, and the same convention
   * the Feed module's cards use.
   */
  async findTermsForBlogs(blogIds: string[]): Promise<RssTaxonomy> {
    const taxonomy: RssTaxonomy = { tags: new Map(), categories: new Map() };
    if (blogIds.length === 0) return taxonomy;

    const [tagLinks, categoryLinks] = await Promise.all([
      prisma.blogTag.findMany({
        where: { blogId: { in: blogIds } },
        select: { blogId: true, tag: { select: { name: true, slug: true } } },
        orderBy: { addedAt: 'asc' },
      }),
      prisma.blogCategory.findMany({
        where: { blogId: { in: blogIds } },
        select: { blogId: true, category: { select: { name: true, slug: true } } },
        orderBy: { addedAt: 'asc' },
      }),
    ]);

    for (const link of tagLinks) push(taxonomy.tags, link.blogId, link.tag);
    for (const link of categoryLinks) push(taxonomy.categories, link.blogId, link.category);
    return taxonomy;
  }

  /**
   * Editor documents for the posts that need one, in a single batched read.
   *
   * Called ONLY for rows with neither an SEO description nor a subtitle, which
   * on a platform where most authors write one or the other is a small minority
   * of a page — and frequently none of it, in which case this query never runs.
   * That is the entire reason `content` is not in the main projection: a feed
   * should not pay to transfer twenty rich-text documents in order to publish
   * twenty two-line summaries.
   */
  async findContentForBlogs(blogIds: string[]): Promise<Map<string, unknown>> {
    if (blogIds.length === 0) return new Map();

    const rows = await prisma.blog.findMany({
      where: { id: { in: blogIds } },
      select: { id: true, content: true },
    });
    return new Map(rows.map((row) => [row.id, row.content as unknown]));
  }

  // ---- Subject resolution -------------------------------------------------

  /**
   * The author a feed is about.
   *
   * Exact username match, matching `blogService.getByAuthor` — the public author
   * listing this feed is the syndication twin of. Both are served by the unique
   * index on `username`, and an author-feed URL is produced by the platform's
   * own discovery link, so there is no case-folding to absorb.
   *
   * `settings.language` rides along because it is the ONE place a truthful
   * `<language>` can come from, and fetching it separately would be a second
   * query for a single column.
   */
  findAuthorByUsername(username: string) {
    return prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        name: true,
        status: true,
        settings: { select: { language: true } },
      },
    });
  }

  findCategoryBySlug(slug: string) {
    return prisma.category.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true },
    });
  }

  findTagBySlug(slug: string) {
    return prisma.tag.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true },
    });
  }

  // ---- Invalidation support ----------------------------------------------

  /**
   * Which feeds one post belongs to: its author, and every tag and category id
   * it carries.
   *
   * The input to targeted invalidation, and the reason a publish can drop
   * exactly the affected feeds rather than the whole cache. Runs in the
   * domain-events worker, never on a request path.
   *
   * Deliberately reads the post WITHOUT any eligibility filter. The events that
   * call this include unpublish, archive, delete and moderation hide — where the
   * post is by definition no longer eligible, and where the feeds it has just
   * left are precisely the ones that must be invalidated. Filtering here would
   * make the module unable to clean up after exactly the events that matter
   * most.
   */
  async findBlogTermIds(blogId: string): Promise<RssBlogTermIds | null> {
    const blog = await prisma.blog.findUnique({
      where: { id: blogId },
      select: {
        authorId: true,
        tags: { select: { tagId: true } },
        categories: { select: { categoryId: true } },
      },
    });
    if (!blog) return null;

    return {
      authorId: blog.authorId,
      tagIds: blog.tags.map((t) => t.tagId),
      categoryIds: blog.categories.map((c) => c.categoryId),
    };
  }

  // ---- SQL fragment builders ---------------------------------------------

  /**
   * The scope predicate: what makes a global query into an author, category or
   * tag one.
   *
   * The taxonomy scopes are `EXISTS` subqueries rather than joins, for the same
   * reason the taxonomy is batched rather than joined above: a join would
   * duplicate a blog row and corrupt both the item count and the ordering. They
   * filter on the term's ID rather than its slug, so the slug is resolved once —
   * where a missing term becomes a 404 — instead of on every row.
   *
   * `subjectId` is always a database id read from a row this module just
   * fetched, and it is BOUND regardless.
   */
  private scopeClause(scope: RssFeedScope, subjectId: string | null): Prisma.Sql {
    if (scope === 'global' || !subjectId) return Prisma.empty;

    switch (scope) {
      case 'author':
        return Prisma.sql` AND b."authorId" = ${subjectId}`;
      case 'category':
        return Prisma.sql` AND EXISTS (
          SELECT 1 FROM "BlogCategory" bc
          WHERE bc."blogId" = b."id" AND bc."categoryId" = ${subjectId}
        )`;
      case 'tag':
        return Prisma.sql` AND EXISTS (
          SELECT 1 FROM "BlogTag" bt
          WHERE bt."blogId" = b."id" AND bt."tagId" = ${subjectId}
        )`;
    }
  }
}

function push(
  map: Map<string, SyndicationTerm[]>,
  key: string,
  value: SyndicationTerm
): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export const rssRepository = new RssRepository();
