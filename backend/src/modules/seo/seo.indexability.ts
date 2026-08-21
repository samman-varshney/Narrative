import type { Prisma } from '@prisma/client';
import { blogService } from '../blog/blog.service';
import { FEED_ELIGIBILITY, isFeedEligible } from '../feed/feed.eligibility';
import { indexingEnabled } from './seo.config';
import type {
  AuthorSeoSource,
  BlogSeoSource,
  RobotsDirective,
  TermSeoSource,
} from './seo.types';

/**
 * What may be crawled, indexed and listed — the module's most security-relevant
 * file, and deliberately the smallest.
 *
 * ── There is no second authorization model here ─────────────────────────────
 * Every rule below DELEGATES. The platform already has two definitions and this
 * module needs exactly those two, for two different questions:
 *
 *   "does this page exist for a stranger?"   `blogService.canView(blog)` with no
 *                                            viewer — the same guard the public
 *                                            slug route and the Bookmark module
 *                                            use.
 *
 *   "may a search engine index it?"          `isFeedEligible` — the platform's
 *                                            single discovery predicate, shared
 *                                            with Feed, Search and RSS.
 *
 * Restating either here is the single most dangerous thing this module could
 * do: two definitions of "public" drift, and the one that drifts is discovered
 * by someone finding a withdrawn post in a search result — where, unlike a feed,
 * it can persist in a third party's index long after the platform stopped
 * serving it.
 *
 * ── Why the two questions are genuinely different ───────────────────────────
 * UNLISTED is the case that proves it. `canView` ALLOWS an unlisted post — that
 * is what unlisted means, reachable by anyone holding the link — so the page
 * exists, has a title, and must be able to answer with metadata when it is
 * rendered. `isFeedEligible` REFUSES it, because "reachable by link" and
 * "advertised to strangers" are the two halves of what unlisted means. So an
 * unlisted post resolves to real metadata carrying `noindex, follow`, and never
 * appears in a sitemap.
 *
 * A module with one boolean could not express that. It would either refuse to
 * describe a page the platform serves, or invite a crawler to index a post the
 * author deliberately did not advertise.
 *
 * ── The dependency direction ────────────────────────────────────────────────
 * SEO imports from Blog and from Feed. Neither imports SEO, and nothing else
 * imports SEO, so it stays a leaf and no cycle can form — the same position RSS
 * occupies. If discovery eligibility is ever promoted out of the Feed module
 * into `core`, this file is the only line in SEO that has to move.
 */

/**
 * The SQL eligibility predicate for a blog aliased `b` and its author aliased
 * `u`, for sitemap queries.
 *
 * Emitted as SQL LITERALS, not bind parameters — the partial indexes that serve
 * these queries are defined ON this predicate, and Postgres can only prove a
 * partial index applies against constants. Nothing user-supplied is
 * interpolated: see `seo.repository.ts`, where every value from a request is
 * bound.
 */
export const SEO_INDEXABLE_BLOG_SQL: Prisma.Sql = FEED_ELIGIBILITY;

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/**
 * Builds a directive, applying the deployment-wide switch.
 *
 * `indexingEnabled()` is checked HERE rather than at each call site, so there is
 * exactly one place a staging deployment can fail to be `noindex`. When it is
 * off the answer is `noindex, nofollow` regardless of what the resource would
 * otherwise have earned — and `robots.txt` disallows everything in the same
 * breath, so a deployment cannot end up half-indexable.
 */
export function robotsDirective(index: boolean, follow = true): RobotsDirective {
  const allowed = indexingEnabled();
  const resolvedIndex = allowed && index;
  const resolvedFollow = allowed && follow;

  return {
    index: resolvedIndex,
    follow: resolvedFollow,
    directive: `${resolvedIndex ? 'index' : 'noindex'}, ${
      resolvedFollow ? 'follow' : 'nofollow'
    }`,
  };
}

// ---------------------------------------------------------------------------
// Blogs
// ---------------------------------------------------------------------------

/**
 * Whether a post's page exists for an anonymous visitor.
 *
 * The gate on whether the metadata endpoint answers at all: `false` is a 404,
 * identical to a slug that was never used. Drafts, private posts, members-only
 * posts, moderator-hidden posts and deleted posts all land here, so none of them
 * can leak so much as a title through this module.
 */
export function isBlogPubliclyVisible(blog: BlogSeoSource): boolean {
  return blogService.canView(
    {
      status: blog.status,
      visibility: blog.visibility,
      authorId: blog.authorId,
      isHidden: blog.isHidden,
    },
    undefined
  );
}

/**
 * Whether a post may be indexed and listed in a sitemap.
 *
 * Strictly narrower than visibility, and the two differ in exactly two places:
 *
 *   UNLISTED       visible, never indexed (see the header comment)
 *   inactive author  visible, never indexed. A suspended or deactivated
 *                  account's posts stay reachable at their URLs — that is the
 *                  Blog module's rule and this module does not overturn it —
 *                  but they leave every discovery surface, and a search index
 *                  is the discovery surface with the longest memory. So the
 *                  page answers with metadata and asks not to be indexed, which
 *                  is also what removes it from results that already exist.
 */
export function isBlogIndexable(blog: BlogSeoSource): boolean {
  return (
    isBlogPubliclyVisible(blog) &&
    isFeedEligible({
      status: blog.status,
      visibility: blog.visibility,
      isHidden: blog.isHidden,
      publishedAt: blog.publishedAt,
      author: { status: blog.author.status },
    })
  );
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

/**
 * Whether a profile page exists for an anonymous visitor.
 *
 * ACTIVE only — the same filter `userRepository.getPublicProfile` applies, so a
 * suspended, deactivated or deleted account is a 404 here exactly as it is
 * everywhere else. That indistinguishability is deliberate: any other answer
 * would make this public endpoint an oracle for who had been suspended.
 */
export function isAuthorPubliclyVisible(author: AuthorSeoSource): boolean {
  return author.status === 'ACTIVE';
}

/**
 * Whether a profile may be indexed and listed.
 *
 * Two conditions beyond existing, and they are different in kind:
 *
 *   NOT PRIVATE      `UserSettings.isPrivate` reduces the profile to a name and
 *                    an avatar (see `userService.getPublicProfile`). Indexing a
 *                    page whose owner asked for it to be minimal would put the
 *                    part they hid into the one place it is hardest to retract.
 *
 *   HAS PUBLISHED    an author page on a writing platform IS the list of that
 *                    author's writing; with nothing published it is a name and a
 *                    bio, which is exactly the thin auto-generated page search
 *                    guidelines warn about — and is also every spam signup's
 *                    free page in the index. It becomes indexable the moment
 *                    they publish, which is the moment it has something to say.
 *
 * The same principle governs categories and tags below: a listing page is
 * indexable when it has something to list. One rule, three resource types.
 */
export function isAuthorIndexable(author: AuthorSeoSource): boolean {
  return (
    isAuthorPubliclyVisible(author) && !author.isPrivate && author.publicPostCount > 0
  );
}

// ---------------------------------------------------------------------------
// Categories and tags
// ---------------------------------------------------------------------------

/**
 * A term's page always exists — the vocabulary is public and a category or tag
 * with no posts is an empty list rather than a missing page.
 */
export function isTermPubliclyVisible(_term: TermSeoSource): boolean {
  return true;
}

/**
 * Indexable when it has something to list.
 *
 * The count is of ELIGIBLE posts, not of rows in the join table: a tag carried
 * only by drafts, private posts or a suspended author's catalogue has nothing a
 * visitor can see, and indexing it would publish a page that renders empty. See
 * `seo.repository`, where that count is one aggregate rather than a query per
 * term.
 */
export function isTermIndexable(term: TermSeoSource): boolean {
  return term.publicPostCount > 0;
}
