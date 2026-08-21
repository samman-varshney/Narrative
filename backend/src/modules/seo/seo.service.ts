import { AppError } from '../../core/exceptions/AppError';
import {
  dropMetadata,
  metadataKey,
  readGenerations,
  readMetadata,
  writeMetadata,
  bumpGenerations,
  type MetadataCacheKind,
} from './seo.cache';
import {
  isAuthorPubliclyVisible,
  isBlogPubliclyVisible,
  isTermPubliclyVisible,
} from './seo.indexability';
import { seoRepository } from './seo.repository';
import { seoResolver } from './seo.resolver';
import { sitemapService } from './sitemap.service';
import type { ResolvedMetadata } from './seo.types';

/**
 * Public metadata orchestration.
 *
 * This module OWNS no data. Posts and their lifecycle belong to Blog, accounts
 * to User, the taxonomy to Blog's curated vocabularies, images to Media, and
 * "what may be discovered" to the platform's single eligibility predicate. What
 * SEO owns is the RESOLUTION: turning those into a finished, cacheable
 * description of a page, and knowing when that description has stopped being
 * true.
 *
 * ── The pipeline, identical for every resource ──────────────────────────────
 *
 *   1. IDENTIFY  the slug or username → a database id        — 404 if absent
 *   2. LOOK UP   the cached metadata by its generation-keyed key
 *   3. FETCH     the projected source row                    — 404 if absent
 *   4. GATE      on public visibility                        — 404 if hidden
 *   5. RESOLVE   through the pure resolver
 *   6. STORE     the resolved metadata
 *
 * Steps 3-5 run only on a miss. Step 1 runs on every request, including a hit.
 *
 * ── Step 1 is what keeps a renamed resource honest ──────────────────────────
 * Caching under the slug from the URL would be one query cheaper and would
 * break the moment a title changed: `blogService` re-slugs on a title edit and
 * `userService.updateProfile` lets a username change, so an entry keyed by the
 * old name would go on being served under an address that now 404s, carrying a
 * canonical tag pointing at it. Resolving identity first makes that
 * unrepresentable — the old name resolves to nothing — and costs one
 * unique-index probe. The RSS module makes the same trade for the same reason.
 *
 * Categories and tags are the exception and ARE keyed by slug: the platform has
 * no route that renames one, so their slugs are immutable in practice, and the
 * extra probe would buy nothing.
 *
 * ── Why a missing resource is never cached ──────────────────────────────────
 * A 404 is thrown, not stored. Negative caching would be a small win on a
 * crawler hitting dead URLs and a real cost the moment a page comes into
 * existence: a category created a second after someone probed for it would keep
 * 404-ing for the rest of the TTL, and the first thing anyone would do is
 * publish a link to it. The 404 path is one indexed lookup; that is cheap
 * enough.
 *
 * ── Visibility is checked on the way IN, not on the way out ─────────────────
 * Step 3 happens before anything is resolved or cached, so a draft, a private
 * post, a members-only post, a moderator-hidden post or a suspended author's
 * profile never produces a cache entry at all. There is no cached
 * representation of a hidden thing that a later change could accidentally
 * serve.
 */
export class SeoService {
  /** The home page. Configuration only — no lookup, and it cannot 404. */
  async getSiteMetadata(): Promise<ResolvedMetadata> {
    return this.cached('site', 'site', async () => seoResolver.resolveSite());
  }

  /**
   * A post's page.
   *
   * The editor document is loaded ONLY when the post has neither an
   * author-written description nor a subtitle — the same conditional the RSS
   * module applies, and for the same reason: pulling a rich-text document to
   * build a 200-character fallback would otherwise dominate the request.
   */
  async getBlogMetadata(slug: string): Promise<ResolvedMetadata> {
    const blogId = await seoRepository.findBlogIdBySlug(slug);
    if (!blogId) throw notFound();

    return this.cached('blog', blogId, async () => {
      const blog = await seoRepository.findBlogById(blogId);
      if (!blog || !isBlogPubliclyVisible(blog)) throw notFound();

      const needsBody =
        !blog.seo?.metaDescription?.trim() && !blog.subtitle?.trim();
      const content = needsBody ? await seoRepository.findBlogContent(blog.id) : undefined;

      return seoResolver.resolveBlog(blog, content);
    });
  }

  /**
   * An author's page.
   *
   * A suspended, deactivated or deleted account is a 404 — indistinguishable
   * from a username that was never used. Any other answer would turn this
   * public endpoint into an oracle for who had been suspended, which is both a
   * privacy leak about the account holder and a moderation-transparency leak
   * the platform has not chosen to make. The same rule `blogService.getByAuthor`
   * and the RSS module already apply.
   */
  async getAuthorMetadata(username: string): Promise<ResolvedMetadata> {
    const userId = await seoRepository.findUserIdByUsername(username);
    if (!userId) throw notFound();

    return this.cached('author', userId, async () => {
      const author = await seoRepository.findAuthorById(userId);
      if (!author || !isAuthorPubliclyVisible(author)) throw notFound();

      return seoResolver.resolveAuthor(author);
    });
  }

  async getCategoryMetadata(slug: string): Promise<ResolvedMetadata> {
    return this.cached('category', slug, async () => {
      const category = await seoRepository.findCategoryBySlug(slug);
      if (!category || !isTermPubliclyVisible(category)) throw notFound();

      return seoResolver.resolveTerm('category', category);
    });
  }

  async getTagMetadata(slug: string): Promise<ResolvedMetadata> {
    return this.cached('tag', slug, async () => {
      const tag = await seoRepository.findTagBySlug(slug);
      if (!tag || !isTermPubliclyVisible(tag)) throw notFound();

      return seoResolver.resolveTerm('tag', tag);
    });
  }

  // -------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------
  //
  // Called only by `subscribers/seo.subscriber.ts`. They live here rather than
  // in the subscriber so the subscriber stays a mapping from events to
  // intentions, and so the cache module is not reached into from outside the
  // service — the same arrangement `rssService` and `feedService` use.

  /**
   * Drops the pages one post appears on, and the sitemap.
   *
   * The targeted path, and where nearly all of the cache's value survives.
   * Publishing a post drops that post's own metadata, its author's profile
   * metadata (the profile's indexability depends on having published something)
   * and the sitemap. Every other page on the platform is untouched.
   *
   * Category and tag pages are deliberately NOT dropped. Their metadata is the
   * term's name and a generated sentence — nothing in it changes when a post
   * enters or leaves the term, except the indexability of a page crossing
   * zero-posts, which the five-minute TTL settles. Dropping them would mean a
   * fan-out over every term a post carries, on the platform's most frequent
   * write, to correct a value that is almost never different.
   */
  async invalidateForBlog(blogId: string, authorId?: string): Promise<void> {
    const generations = await readGenerations(['root']);
    const root = generations.get('root') ?? 0;

    const keys = [metadataKey('blog', blogId, root)];
    if (authorId) keys.push(metadataKey('author', authorId, root));

    await Promise.all([dropMetadata(keys), sitemapService.invalidate()]);
  }

  /** Drops one author's profile metadata. For a profile edit. */
  async invalidateForAuthor(userId: string): Promise<void> {
    const generations = await readGenerations(['root']);
    await dropMetadata([metadataKey('author', userId, generations.get('root') ?? 0)]);
  }

  /**
   * Drops every cached page and every sitemap on the platform.
   *
   * Reserved for events whose blast radius cannot be enumerated cheaply and
   * whose correctness cannot wait: a suspension, a deactivation, an account
   * deletion, or a moderator hiding or removing a post. In each case an entire
   * catalogue leaves the indexable set at once, and the set of pages that
   * catalogue touches is an unbounded query on a path that must be immediate.
   *
   * One `INCR`, and every key on the platform becomes unreachable. That it is
   * cheap is exactly why the coarse option is acceptable for the rare case.
   */
  async invalidateEverything(): Promise<void> {
    await bumpGenerations(['root', 'sitemap']);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Read-through cache around a resolver.
   *
   * `resolve` is always the source of truth. A hit short-circuits it; every
   * kind of failure — miss, unreachable Redis, unparsable payload — runs it. A
   * thrown `AppError` propagates untouched and nothing is written, which is what
   * keeps 404s out of the cache.
   */
  private async cached(
    kind: MetadataCacheKind,
    identifier: string,
    resolve: () => Promise<ResolvedMetadata>
  ): Promise<ResolvedMetadata> {
    const generations = await readGenerations(['root']);
    const key = metadataKey(kind, identifier, generations.get('root') ?? 0);

    const hit = await readMetadata(key);
    if (hit) return hit;

    const resolved = await resolve();
    await writeMetadata(key, resolved);
    return resolved;
  }
}

/**
 * One message and one code for every missing resource.
 *
 * A 404 that named the resource kind would tell a prober whether a username
 * exists but is suspended, or a slug exists but is a draft. It says neither.
 */
const notFound = (): AppError =>
  new AppError('Not found', 404, 'SEO_RESOURCE_NOT_FOUND');

export const seoService = new SeoService();
