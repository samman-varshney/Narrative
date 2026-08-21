import { Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';
import { appBaseUrl } from '../../core/utils/publicUrls';
import { SEO_INDEXABLE_BLOG_SQL } from './seo.indexability';
import { SITEMAP_MAX_CHUNKS, SITEMAP_URLS_PER_CHUNK } from './seo.config';
import type {
  AuthorSeoSource,
  BlogSeoSource,
  DynamicSitemapSection,
  TermSeoSource,
} from './seo.types';

/**
 * The SEO module's data-access layer — every line of SEO SQL in the codebase.
 *
 * Two very different workloads live here, and they are shaped differently on
 * purpose.
 *
 *   METADATA  One resource, by slug or username. A handful of indexed lookups
 *             per request, cached for five minutes. Written with the Prisma
 *             query builder, because the shape is a single row with its
 *             one-to-one and small one-to-many relations and the builder
 *             expresses that clearly.
 *
 *   SITEMAP   Thousands of rows, in bounded chunks. Written as raw SQL, because
 *             eligibility arrives as a `Prisma.Sql` fragment carrying LITERAL
 *             status and visibility values so Postgres can prove the PARTIAL
 *             indexes apply — expressing the same thing through the builder
 *             would parameterise them and silently disqualify every index, a
 *             sequential scan with nothing in the logs to notice. Same
 *             technique, same reason, as Feed, Search and RSS.
 *
 * Every value that comes from a REQUEST is bound. Nothing user-supplied is
 * interpolated anywhere in this file.
 *
 * ── No N+1, by construction ─────────────────────────────────────────────────
 * A sitemap chunk of five thousand URLs is ONE query. The author, category and
 * tag sections each aggregate their post counts and modification times in the
 * same statement that selects them, rather than asking per row — the difference
 * between one query and five thousand. The metadata path is bounded per
 * resource and never loops.
 */

// ---------------------------------------------------------------------------
// Metadata projections
// ---------------------------------------------------------------------------

/**
 * Exactly the columns metadata resolution reads.
 *
 * `content` is absent: most posts have an author-written description or a
 * subtitle, and pulling a rich-text document to build a 200-character fallback
 * for the minority that do not would be the most expensive part of the request.
 * It is fetched separately, only when needed — see `findBlogContent`.
 *
 * `status`, `visibility` and `isHidden` ARE selected. The module has to decide
 * with them; `seo.types` records that they never reach a response.
 */
const blogSeoSelect = {
  id: true,
  title: true,
  slug: true,
  subtitle: true,
  coverImage: true,
  status: true,
  visibility: true,
  isHidden: true,
  publishedAt: true,
  updatedAt: true,
  authorId: true,
  seo: {
    select: {
      metaTitle: true,
      metaDescription: true,
      canonicalUrl: true,
      ogTitle: true,
      ogDescription: true,
      ogImage: true,
      twitterCard: true,
    },
  },
  author: {
    select: {
      id: true,
      username: true,
      name: true,
      avatar: true,
      bio: true,
      status: true,
      developerProfile: { select: { x: true } },
    },
  },
  // Ordered by `addedAt` so the FIRST category is the one the author chose
  // first — which is what becomes `article:section` and the breadcrumb's middle
  // step. The same convention the Feed cards and RSS items use.
  categories: {
    select: { category: { select: { name: true, slug: true } } },
    orderBy: { addedAt: 'asc' },
  },
  tags: {
    select: { tag: { select: { name: true, slug: true } } },
    orderBy: { addedAt: 'asc' },
  },
  // The Media row is the source of truth for a cover's public URL; the
  // denormalized `coverImage` is the fallback for posts predating the
  // reference. `publicId` — the internal storage path — is deliberately not
  // selected, so it cannot reach a public document even by accident.
  coverMedia: { select: { secureUrl: true, deletedAt: true } },
} satisfies Prisma.BlogSelect;

/**
 * The prefix `blogUrl` builds a post's canonical URL from.
 *
 * Read through a function rather than captured at import time, so a deployment
 * (or a test) that changes `APP_URL` cannot leave the sitemap comparing against
 * a stale origin and silently dropping every post that carries a canonical.
 */
const blogUrlPrefix = (): string => `${appBaseUrl()}/blog/`;

export class SeoRepository {
  /**
   * A post's database id, from the slug in the URL.
   *
   * A separate, deliberately tiny query, and the reason it exists is caching.
   * Metadata is cached under the post's ID rather than its slug, because
   * `blogService` RE-SLUGS a post when its title changes: an entry keyed by slug
   * would go on being served under the old URL for the rest of its TTL, and what
   * it carries is a canonical tag pointing at an address that now 404s — the
   * exact duplicate-content failure this module exists to prevent.
   *
   * With the identity resolved first, a renamed post's old slug simply does not
   * resolve, and the answer is an immediate 404. The price is one unique-index
   * probe per request, including on a cache hit; the RSS module makes the same
   * trade for the same reason (see `rss.service`).
   */
  async findBlogIdBySlug(slug: string): Promise<string | null> {
    const row = await prisma.blog.findUnique({ where: { slug }, select: { id: true } });
    return row?.id ?? null;
  }

  /** One post's metadata sources. */
  async findBlogById(id: string): Promise<BlogSeoSource | null> {
    const blog = await prisma.blog.findUnique({
      where: { id },
      select: blogSeoSelect,
    });
    if (!blog) return null;

    const coverDeleted = Boolean(blog.coverMedia?.deletedAt);

    return {
      id: blog.id,
      title: blog.title,
      slug: blog.slug,
      subtitle: blog.subtitle,
      status: blog.status,
      visibility: blog.visibility,
      isHidden: blog.isHidden,
      publishedAt: blog.publishedAt,
      updatedAt: blog.updatedAt,
      authorId: blog.authorId,
      seo: blog.seo,
      author: {
        id: blog.author.id,
        username: blog.author.username,
        name: blog.author.name,
        avatar: blog.author.avatar,
        bio: blog.author.bio,
        status: blog.author.status,
        x: blog.author.developerProfile?.x ?? null,
      },
      categories: blog.categories.map((c) => c.category),
      tags: blog.tags.map((t) => t.tag),
      // A soft-deleted cover is treated as absent rather than published: the
      // file is gone, and a preview card pointing at it would render broken.
      //
      // BOTH columns are cleared, not just the Media one. `Blog.coverImage` is
      // the denormalized copy of the same URL, and it exists as a fallback for
      // posts that predate the Media reference — posts with NO linked row, which
      // is a different thing from a linked row that says the asset was removed.
      // Leaving it would publish the deleted asset's URL through the fallback
      // path and undo the check above.
      coverImage: coverDeleted ? null : blog.coverImage,
      coverSecureUrl: coverDeleted ? null : (blog.coverMedia?.secureUrl ?? null),
    };
  }

  /**
   * A post's editor document, for the description fallback.
   *
   * Called only when the post has neither an author-written description nor a
   * subtitle. On a platform where most authors write one or the other, this
   * query usually does not run at all — which is the entire reason `content` is
   * not in the projection above.
   */
  async findBlogContent(blogId: string): Promise<unknown> {
    const row = await prisma.blog.findUnique({
      where: { id: blogId },
      select: { content: true },
    });
    return row?.content ?? null;
  }

  /**
   * One author's metadata sources, by database id.
   *
   * Keyed by id for the same reason a post is: `userService.updateProfile` lets
   * a user change their username, so a cache keyed by the name in the URL would
   * serve a renamed account's metadata under an address that no longer resolves.
   * `findUserIdByUsername` above is the probe that turns the URL into an
   * identity first.
   *
   * Two queries: the profile row, and one aggregate over their eligible posts.
   * The aggregate answers both "is this page worth indexing" (the count) and
   * "when did it last change" (the newest modification), and doing it in SQL
   * rather than by counting a loaded relation is what keeps a prolific author's
   * profile the same cost as a new one's.
   */
  async findUserIdByUsername(username: string): Promise<string | null> {
    const row = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    return row?.id ?? null;
  }

  async findAuthorById(id: string): Promise<AuthorSeoSource | null> {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        name: true,
        bio: true,
        avatar: true,
        status: true,
        createdAt: true,
        settings: { select: { isPrivate: true } },
        // `x` becomes `twitter:creator` (strictly parsed at resolution); the
        // rest become the `sameAs` links on the Person node. All four are
        // author-supplied URLs and are scheme-checked before publication.
        developerProfile: {
          select: { x: true, github: true, linkedin: true, portfolio: true },
        },
      },
    });
    if (!user) return null;

    const [stats] = await prisma.$queryRaw<{ count: bigint; lastmod: Date | null }[]>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS "count", MAX(b."updatedAt") AS "lastmod"
        FROM "Blog" b
        JOIN "User" u ON u."id" = b."authorId"
        WHERE ${SEO_INDEXABLE_BLOG_SQL}
          AND b."authorId" = ${user.id}
      `
    );

    return {
      id: user.id,
      username: user.username,
      name: user.name,
      bio: user.bio,
      avatar: user.avatar,
      status: user.status,
      isPrivate: user.settings?.isPrivate ?? false,
      x: user.developerProfile?.x ?? null,
      socialLinks: [
        user.developerProfile?.x ?? null,
        user.developerProfile?.github ?? null,
        user.developerProfile?.linkedin ?? null,
        user.developerProfile?.portfolio ?? null,
      ],
      createdAt: user.createdAt,
      publicPostCount: Number(stats?.count ?? 0),
      lastPublishedAt: stats?.lastmod ?? null,
    };
  }

  /** One category's metadata sources. Same shape as a tag's. */
  findCategoryBySlug(slug: string): Promise<TermSeoSource | null> {
    return this.findTerm('category', slug);
  }

  findTagBySlug(slug: string): Promise<TermSeoSource | null> {
    return this.findTerm('tag', slug);
  }

  /**
   * A term and the state of what it holds.
   *
   * The count is of ELIGIBLE posts, which is why it cannot come from a
   * `_count` on the relation: a tag carried only by drafts or by a suspended
   * author's catalogue has a non-zero row count and nothing a visitor can see.
   */
  private async findTerm(
    kind: 'category' | 'tag',
    slug: string
  ): Promise<TermSeoSource | null> {
    const term =
      kind === 'category'
        ? await prisma.category.findUnique({
            where: { slug },
            select: { id: true, name: true, slug: true },
          })
        : await prisma.tag.findUnique({
            where: { slug },
            select: { id: true, name: true, slug: true },
          });
    if (!term) return null;

    const joinTable = kind === 'category' ? Prisma.raw('"BlogCategory"') : Prisma.raw('"BlogTag"');
    const joinColumn = kind === 'category' ? Prisma.raw('"categoryId"') : Prisma.raw('"tagId"');

    const [stats] = await prisma.$queryRaw<{ count: bigint; lastmod: Date | null }[]>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS "count", MAX(b."updatedAt") AS "lastmod"
        FROM ${joinTable} j
        JOIN "Blog" b ON b."id" = j."blogId"
        JOIN "User" u ON u."id" = b."authorId"
        WHERE ${SEO_INDEXABLE_BLOG_SQL}
          AND j.${joinColumn} = ${term.id}
      `
    );

    return {
      id: term.id,
      name: term.name,
      slug: term.slug,
      publicPostCount: Number(stats?.count ?? 0),
      lastPublishedAt: stats?.lastmod ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Sitemap
  // -------------------------------------------------------------------------

  /**
   * The shape of one section, as a subquery producing four columns:
   *
   *   key        the path segment the URL is built from (slug, username)
   *   lastmod    when the thing this URL points at last changed
   *   sort_time  the ordering key, and
   *   sort_id    its tiebreak — together a TOTAL order, which is what makes
   *              chunk boundaries reproducible between two requests
   *
   * ── Ordered OLDEST first, deliberately ─────────────────────────────────────
   * Every other listing on the platform is newest-first; a sitemap is not,
   * because its chunks are addressed by page number. Newest-first would make
   * every publication shift every URL by one position, so `sitemap-blogs-1.xml`
   * would change completely each time anyone published and a crawler would have
   * to re-fetch every chunk. Oldest-first means early chunks are effectively
   * immutable and only the last one grows — the whole point of chunking.
   */
  private sectionSource(section: DynamicSitemapSection): Prisma.Sql {
    switch (section) {
      // The `BlogSEO` join is a duplicate-content guard, not a projection. A
      // sitemap is a list of CANONICAL URLs, so a post whose author pointed its
      // canonical elsewhere — the cross-posting the field exists for — must not
      // be listed here under our address: doing so would have the platform
      // asserting in one document exactly what it denies in another, which is
      // the contradiction search engines resolve by trusting neither.
      //
      // A canonical that matches the URL we would have generated anyway is not a
      // contradiction, so it stays. The comparison is against the same prefix
      // `blogUrl` builds from, bound as a parameter.
      //
      // `NOT EXISTS` rather than a `LEFT JOIN` with the condition in the WHERE
      // clause, and the difference is the plan rather than the result. A join
      // makes an id-ordered merge with "BlogSEO" attractive, which costs the
      // publication ordering the partial index would otherwise have provided —
      // the planner picks `Blog_pkey` and sorts. An anti-join is a probe on
      // `BlogSEO_blogId_key` per candidate, so the index walk still drives.
      // Same technique, same reason, as the taxonomy predicates below.
      case 'blogs':
        return Prisma.sql`
          SELECT
            b."slug"        AS "key",
            b."updatedAt"   AS "lastmod",
            b."publishedAt" AS "sort_time",
            b."id"          AS "sort_id"
          FROM "Blog" b
          JOIN "User" u ON u."id" = b."authorId"
          WHERE ${SEO_INDEXABLE_BLOG_SQL}
            AND NOT EXISTS (
              SELECT 1 FROM "BlogSEO" seo
              WHERE seo."blogId" = b."id"
                AND seo."canonicalUrl" IS NOT NULL
                AND seo."canonicalUrl" <> ''
                AND seo."canonicalUrl" <> ${blogUrlPrefix()} || b."slug"
            )
        `;

      // A profile is listed when its owner has published something eligible —
      // the same "a listing page is indexable when it has something to list"
      // rule `seo.indexability` states. `isPrivate` is excluded here rather than
      // filtered afterwards, so a private profile never enters a chunk and the
      // page counts stay honest.
      case 'authors':
        return Prisma.sql`
          SELECT
            u."username"          AS "key",
            MAX(b."updatedAt")    AS "lastmod",
            MIN(b."publishedAt")  AS "sort_time",
            u."id"                AS "sort_id"
          FROM "User" u
          JOIN "Blog" b ON b."authorId" = u."id"
          LEFT JOIN "UserSettings" s ON s."userId" = u."id"
          WHERE ${SEO_INDEXABLE_BLOG_SQL}
            AND COALESCE(s."isPrivate", false) = false
          GROUP BY u."id", u."username"
        `;

      case 'categories':
        return Prisma.sql`
          SELECT
            c."slug"           AS "key",
            MAX(b."updatedAt") AS "lastmod",
            c."createdAt"      AS "sort_time",
            c."id"             AS "sort_id"
          FROM "Category" c
          JOIN "BlogCategory" bc ON bc."categoryId" = c."id"
          JOIN "Blog" b ON b."id" = bc."blogId"
          JOIN "User" u ON u."id" = b."authorId"
          WHERE ${SEO_INDEXABLE_BLOG_SQL}
          GROUP BY c."id", c."slug", c."createdAt"
        `;

      case 'tags':
        return Prisma.sql`
          SELECT
            t."slug"           AS "key",
            MAX(b."updatedAt") AS "lastmod",
            t."createdAt"      AS "sort_time",
            t."id"             AS "sort_id"
          FROM "Tag" t
          JOIN "BlogTag" bt ON bt."tagId" = t."id"
          JOIN "Blog" b ON b."id" = bt."blogId"
          JOIN "User" u ON u."id" = b."authorId"
          WHERE ${SEO_INDEXABLE_BLOG_SQL}
          GROUP BY t."id", t."slug", t."createdAt"
        `;
    }
  }

  /**
   * One bounded chunk of one section.
   *
   * Built and executed in two steps so the index report (`npm run seo:report`)
   * and the query-plan test can `EXPLAIN` EXACTLY the statement that runs in
   * production, rather than a hand-copied approximation of it that drifts the
   * first time this file changes. `findSitemapChunk` is the only caller that
   * executes it.
   *
   * `LIMIT`/`OFFSET`, and that is the right tool here rather than the keyset
   * cursor the rest of the platform uses. A sitemap chunk is addressed by PAGE
   * NUMBER — `/sitemap-blogs-7.xml` must be answerable on its own, by a crawler
   * that has never fetched chunk 6 — and a cursor cannot express random access
   * without walking every page before it. The offset is bounded by
   * `SITEMAP_MAX_CHUNKS` (the validator refuses a larger page), the scan is
   * index-ordered, and the result is cached for an hour.
   */
  buildChunkQuery(section: DynamicSitemapSection, page: number): Prisma.Sql {
    const offset = (page - 1) * SITEMAP_URLS_PER_CHUNK;

    // The ordering and the bounds are APPENDED to the section's own SELECT
    // rather than wrapped around it in a subquery, and that is a plan decision
    // rather than a stylistic one. Wrapped, Postgres has to materialise and sort
    // the entire eligible set before it can apply `LIMIT`/`OFFSET` — a full sort
    // of every published post on the platform, per sitemap request. Appended,
    // the ordering is the one `blog_search_published_idx` already provides, so
    // the planner walks the index and stops. `rss.db.test`-style plan assertions
    // in `seo.db.test.ts` hold this in place.
    return Prisma.sql`
      ${this.sectionSource(section)}
      ORDER BY "sort_time" ASC, "sort_id" ASC
      LIMIT ${SITEMAP_URLS_PER_CHUNK}
      OFFSET ${offset}
    `;
  }

  findSitemapChunk(
    section: DynamicSitemapSection,
    page: number
  ): Promise<{ key: string; lastmod: Date | null }[]> {
    return prisma.$queryRaw<{ key: string; lastmod: Date | null }[]>(
      this.buildChunkQuery(section, page)
    );
  }

  /**
   * Every chunk of one section, with its size and its modification time — in a
   * single query.
   *
   * This is what the sitemap INDEX is built from, and doing it in one statement
   * is the difference between an index that costs one query and one that costs a
   * query per chunk. `row_number()` assigns each row to a chunk under exactly
   * the ordering `findSitemapChunk` pages by, so the counts and the `lastmod`
   * values describe the documents that will actually be served.
   *
   * A per-chunk `lastmod` rather than a section-wide one is what makes the
   * oldest-first ordering pay off: a crawler holding chunk 1 is told it has not
   * changed, instead of being sent back for every chunk because something new
   * was published into the last one.
   *
   * The inner `LIMIT` is the module's scan bound — at most
   * `SITEMAP_MAX_CHUNKS × SITEMAP_URLS_PER_CHUNK` rows are ever considered, so
   * this cannot become an unbounded aggregate as the platform grows.
   */
  async findSitemapChunkSummary(
    section: DynamicSitemapSection
  ): Promise<{ page: number; urls: number; lastmod: Date | null }[]> {
    const maxRows = SITEMAP_MAX_CHUNKS * SITEMAP_URLS_PER_CHUNK;

    const rows = await prisma.$queryRaw<{ chunk: number; urls: bigint; lastmod: Date | null }[]>(
      Prisma.sql`
        SELECT
          t."chunk",
          COUNT(*)::bigint AS "urls",
          MAX(t."lastmod")  AS "lastmod"
        FROM (
          SELECT
            (
              (ROW_NUMBER() OVER (ORDER BY src."sort_time" ASC, src."sort_id" ASC) - 1)
              / ${SITEMAP_URLS_PER_CHUNK}
            )::int AS "chunk",
            src."lastmod"
          FROM (${this.sectionSource(section)}) src
          ORDER BY src."sort_time" ASC, src."sort_id" ASC
          LIMIT ${maxRows}
        ) t
        GROUP BY t."chunk"
        ORDER BY t."chunk" ASC
      `
    );

    // `chunk` is 0-based in SQL and 1-based in the URL, because
    // `sitemap-blogs-0.xml` reads as an off-by-one error to everyone who is not
    // a programmer. Converted once, here, at the boundary.
    return rows.map((row) => ({
      page: row.chunk + 1,
      urls: Number(row.urls),
      lastmod: row.lastmod,
    }));
  }

  // -------------------------------------------------------------------------
  // Invalidation support
  // -------------------------------------------------------------------------

  /**
   * The author of one post, for invalidating their profile alongside it.
   *
   * The post's own cache key needs no lookup — it IS the blog id the event
   * carries. What this resolves is the author, because a profile's indexability
   * depends on having published something, so publishing changes the author's
   * page as well as the post's.
   *
   * Deliberately reads the post WITHOUT any eligibility filter. The events that
   * call this include unpublish, archive, delete and moderation hide — where the
   * post is by definition no longer eligible, and where the entries it has just
   * invalidated are precisely the ones that must be dropped. Filtering here
   * would make the module unable to clean up after exactly the events that
   * matter most.
   *
   * Runs in the domain-events worker, never on a request path.
   */
  async findBlogAuthorId(blogId: string): Promise<string | null> {
    const blog = await prisma.blog.findUnique({
      where: { id: blogId },
      select: { authorId: true },
    });
    return blog?.authorId ?? null;
  }
}

export const seoRepository = new SeoRepository();
