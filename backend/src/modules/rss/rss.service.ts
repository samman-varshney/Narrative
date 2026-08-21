import { AppError } from '../../core/exceptions/AppError';
import { entityTag } from '../../core/utils/httpCache';
import { logger } from '../../core/utils/logger';
import {
  bumpGenerations,
  feedCacheKey,
  readFeed,
  readGenerations,
  scopeGeneration,
  writeFeed,
  type GenerationKey,
} from './rss.cache';
import {
  CHANNEL_DESCRIPTIONS,
  CHANNEL_TITLES,
  DEFAULT_LANGUAGE,
  FEED_GENERATOR,
  RSS_DOCUMENT_VERSION,
} from './rss.config';
import { deriveDescription, hasCheapDescription } from './rss.content';
import { activeFeedRenderer, type IFeedRenderer } from './rss.renderer';
import { rssRepository } from './rss.repository';
import type {
  RenderedFeed,
  RssBlogRow,
  RssFeedRequest,
  RssFeedScope,
  RssFeedSubject,
  RssTaxonomy,
  SyndicationDocument,
  SyndicationItem,
} from './rss.types';
import {
  absolutePublicUrl,
  authorUrl,
  appBaseUrl,
  blogGuid,
  blogUrl,
  categoryUrl,
  channelId,
  feedSelfUrl,
  safeHttpUrl,
  tagUrl,
} from './rss.urls';

/**
 * RSS & Distribution orchestration.
 *
 * This module OWNS no data. Posts and their lifecycle belong to Blog, accounts
 * to User, the taxonomy to Blog's curated vocabularies, images to Media,
 * canonical metadata to the SEO row Blog maintains, and "what may be
 * discovered" to the platform's single eligibility predicate. What RSS owns is
 * the composition: turning those into a bounded, cacheable, syndicatable
 * document, and knowing when that document has stopped being true.
 *
 * ── The pipeline, identical for every feed ──────────────────────────────────
 *
 *   1. RESOLVE   the subject (author / category / tag)   — 404 if absent
 *   2. LOOK UP   the cached document by generation-keyed key
 *   3. RETRIEVE  bounded rows + batched taxonomy + excerpt bodies
 *   4. BUILD     a format-agnostic SyndicationDocument
 *   5. RENDER    through IFeedRenderer, and hash the bytes into an ETag
 *   6. STORE     the rendered document, its ETag and its Last-Modified
 *
 * Steps 3-5 run only on a miss. Step 2 is what a polling reader almost always
 * gets, and the controller turns it into a 304 without reading the body.
 *
 * ── Step 1 runs even on a cache hit, deliberately ───────────────────────────
 * A scoped feed therefore costs ONE indexed lookup per request no matter how
 * warm the cache is. That is a trade, and it is made in favour of keying the
 * cache on the subject's DATABASE ID rather than on the slug from the URL.
 * Keying on the slug would remove the lookup and introduce two worse problems:
 * a category renamed from `web-dev` to `web-development` would silently occupy
 * two cache entries, and the entry under the old name would go on being served
 * under a name that no longer exists. A single unique-index probe is a cheap
 * price for an identity that cannot drift, and it is what makes an invalidation
 * targeted at an id able to find the entries it needs to reach.
 *
 * ── `lastBuildDate` comes from the data, never from the clock ───────────────
 * The channel's build date is the newest item's `updatedAt`. Using `new Date()`
 * would be the obvious reading of the element's name and would break HTTP
 * caching completely: every regeneration would produce different bytes, a
 * different ETag, and a `Last-Modified` that marched forward while nothing had
 * changed — so every reader would download every feed on every poll, and the
 * 304 path this module is built around would never fire. It is also simply more
 * accurate: RSS defines `lastBuildDate` as when the channel's CONTENT last
 * changed.
 */

/** BCP-47-ish shape. `UserSettings.language` is a free two-character string. */
const LANGUAGE_TAG = /^[a-z]{2}(-[a-z0-9]{2,8})*$/i;

export class RssService {
  constructor(private readonly renderer: IFeedRenderer = activeFeedRenderer) {}

  /**
   * The module's single entry point: a rendered, cacheable feed.
   *
   * Throws `AppError` 404 for an unknown or ineligible subject. Every other
   * failure — Redis down, a malformed post, a taxonomy read that fails — is
   * absorbed below and degrades the response rather than failing it.
   */
  async getFeed(request: RssFeedRequest): Promise<RenderedFeed> {
    const subject = await this.resolveSubject(request.scope, request.key);

    const scopeKey = scopeGeneration(subject.scope, subject.id);
    const generations = await readGenerations(['root', scopeKey]);

    const key = feedCacheKey({
      scope: subject.scope,
      subjectId: subject.id,
      limit: request.limit,
      rootGeneration: generations.get('root') ?? 0,
      scopeGeneration: generations.get(scopeKey) ?? 0,
    });

    const hit = await readFeed(key);
    if (hit) return hit;

    const rendered = await this.buildFeed(subject, request);
    await writeFeed(key, rendered);
    return rendered;
  }

  // ---- Subject resolution -------------------------------------------------

  /**
   * Resolves the thing a feed is about, or refuses.
   *
   * ── Why an inactive author is a 404 and not a 403 ────────────────────────
   * A suspended, deactivated or deleted account must be indistinguishable from
   * one that never existed. Any other status code turns this public, unrate-
   * limited-by-account endpoint into an oracle: a script could walk a username
   * list and learn exactly who had been suspended, which is both a privacy leak
   * about the account holder and a moderation-transparency leak the platform has
   * not chosen to make. The same rule `blogService.getByAuthor` already applies.
   *
   * ── Author privacy ───────────────────────────────────────────────────────
   * `UserSettings.isPrivate` is deliberately NOT consulted. It hides a user from
   * the PEOPLE DIRECTORY — Search's user results — and not their published
   * public posts, which continue to appear in Latest, in Explore and in blog
   * search. RSS follows blog search, so the platform's discovery surfaces cannot
   * disagree about whether an author's public writing exists. See
   * FEED_MODULE.md § Author privacy.
   */
  private async resolveSubject(
    scope: RssFeedScope,
    key?: string
  ): Promise<RssFeedSubject> {
    if (scope === 'global') {
      return {
        scope,
        id: null,
        name: CHANNEL_TITLES.global,
        link: appBaseUrl(),
        language: DEFAULT_LANGUAGE,
      };
    }

    if (!key) {
      // Unreachable through the routes — every non-global route has a required
      // path parameter — and asserted rather than assumed, because a future
      // route that forgot one would otherwise silently serve the global feed
      // under an author's URL.
      throw new AppError('Feed not found', 404, 'FEED_NOT_FOUND');
    }

    if (scope === 'author') {
      const author = await rssRepository.findAuthorByUsername(key);
      if (!author || author.status !== 'ACTIVE') {
        throw new AppError('Feed not found', 404, 'FEED_NOT_FOUND');
      }
      return {
        scope,
        id: author.id,
        name: author.name,
        link: authorUrl(author.username),
        language: this.normalizeLanguage(author.settings?.language),
      };
    }

    if (scope === 'category') {
      const category = await rssRepository.findCategoryBySlug(key);
      if (!category) throw new AppError('Feed not found', 404, 'FEED_NOT_FOUND');
      return {
        scope,
        id: category.id,
        name: category.name,
        link: categoryUrl(category.slug),
        language: DEFAULT_LANGUAGE,
      };
    }

    const tag = await rssRepository.findTagBySlug(key);
    if (!tag) throw new AppError('Feed not found', 404, 'FEED_NOT_FOUND');
    return {
      scope,
      id: tag.id,
      name: tag.name,
      link: tagUrl(tag.slug),
      language: DEFAULT_LANGUAGE,
    };
  }

  /**
   * `UserSettings.language` is validated upstream as any two-character string,
   * so it can be `zz` or `<>`. Anything that is not plausibly a language tag
   * falls back to the platform default: an invalid `<language>` makes an
   * otherwise-valid feed fail validation, and the value is cosmetic.
   */
  private normalizeLanguage(value: string | null | undefined): string {
    if (value && LANGUAGE_TAG.test(value)) return value.toLowerCase();
    return DEFAULT_LANGUAGE;
  }

  // ---- Document assembly --------------------------------------------------

  private async buildFeed(
    subject: RssFeedSubject,
    request: RssFeedRequest
  ): Promise<RenderedFeed> {
    const rows = await rssRepository.findFeedRows({
      scope: subject.scope,
      subjectId: subject.id,
      limit: request.limit,
    });

    const [taxonomy, bodies] = await Promise.all([
      this.loadTaxonomy(rows),
      this.loadExcerptBodies(rows),
    ]);

    const items = this.buildItems(rows, taxonomy, bodies);

    const document: SyndicationDocument = {
      channel: {
        id: channelId(subject.scope, subject.id),
        title: this.channelTitle(subject),
        description: this.channelDescription(subject),
        link: subject.link,
        selfUrl: feedSelfUrl(subject.scope, request.key, request.limit),
        language: subject.language,
        lastBuildDate: newestUpdate(items),
        generator: FEED_GENERATOR,
      },
      items,
    };

    const body = this.renderer.render(document);

    return {
      body,
      contentType: this.renderer.contentType,
      etag: entityTag(RSS_DOCUMENT_VERSION, body),
      lastModified: document.channel.lastBuildDate,
      itemCount: items.length,
    };
  }

  /**
   * Tags and categories for the page.
   *
   * Best-effort: a taxonomy read that fails produces items with no `<category>`
   * elements rather than no feed. A category list is decoration on a syndicated
   * item, and losing it is a far better outcome than a 500 delivered to every
   * subscriber polling at that moment.
   */
  private async loadTaxonomy(rows: RssBlogRow[]): Promise<RssTaxonomy> {
    try {
      return await rssRepository.findTermsForBlogs(rows.map((row) => row.id));
    } catch (err) {
      logger.warn({ err }, 'rss: taxonomy load failed — items will carry no categories');
      return { tags: new Map(), categories: new Map() };
    }
  }

  /**
   * Editor documents, for the rows that cannot produce a description without
   * one.
   *
   * The filter is the optimization: a post whose author wrote an SEO
   * description or a subtitle already has everything it needs, and on most
   * pages that is every post — in which case this issues no query at all.
   *
   * Best-effort for the same reason as the taxonomy: a post with no description
   * is a worse item, not a broken feed.
   */
  private async loadExcerptBodies(rows: RssBlogRow[]): Promise<Map<string, unknown>> {
    const needsBody = rows.filter((row) => !hasCheapDescription(row)).map((row) => row.id);
    if (needsBody.length === 0) return new Map();

    try {
      return await rssRepository.findContentForBlogs(needsBody);
    } catch (err) {
      logger.warn({ err }, 'rss: excerpt bodies failed to load — items will carry no description');
      return new Map();
    }
  }

  /**
   * Maps rows to items, skipping any that cannot be built.
   *
   * ── One malformed post must not destroy a channel ────────────────────────
   * The per-item `try` is the requirement that "malformed individual content
   * cannot invalidate the entire feed", made structural. A row with an
   * unparseable body, a corrupt `readingStats`-style JSON column, or a date the
   * driver hands back as something unexpected produces a logged warning and one
   * missing item — while the other nineteen reach every subscriber. Without it,
   * a single bad row would 500 the endpoint for everyone, and would keep doing
   * so on every poll until someone noticed.
   */
  private buildItems(
    rows: RssBlogRow[],
    taxonomy: RssTaxonomy,
    bodies: Map<string, unknown>
  ): SyndicationItem[] {
    const items: SyndicationItem[] = [];

    for (const row of rows) {
      try {
        items.push(this.buildItem(row, taxonomy, bodies));
      } catch (err) {
        logger.warn({ err, blogId: row.id }, 'rss: skipping an item that could not be built');
      }
    }

    return items;
  }

  private buildItem(
    row: RssBlogRow,
    taxonomy: RssTaxonomy,
    bodies: Map<string, unknown>
  ): SyndicationItem {
    // Categories and tags are both rendered as `<category>` — RSS has one
    // element for "what this is about" and no way to distinguish a curated
    // taxonomy from a folksonomy. Categories lead because they are the
    // platform's curated vocabulary and are the more meaningful classification.
    const categories = [
      ...(taxonomy.categories.get(row.id) ?? []),
      ...(taxonomy.tags.get(row.id) ?? []),
    ];

    return {
      id: blogGuid(row.id),
      title: row.title,
      // The author's declared canonical URL wins when they set one — that is
      // what the SEO row is FOR, and a feed that pointed somewhere else would
      // contradict the `<link rel="canonical">` on the page itself. It is
      // scheme-checked rather than trusted: see `safeHttpUrl`.
      link: safeHttpUrl(row.canonicalUrl) ?? blogUrl(row.slug),
      description: deriveDescription({
        metaDescription: row.metaDescription,
        subtitle: row.subtitle,
        content: bodies.get(row.id),
      }),
      author: {
        name: row.authorName,
        username: row.authorUsername,
        profileUrl: authorUrl(row.authorUsername),
      },
      publishedAt: row.publishedAt,
      updatedAt: row.updatedAt,
      categories,
      enclosure: this.buildEnclosure(row),
    };
  }

  /**
   * The cover image, as a feed enclosure.
   *
   * Sourced from the linked `Media` row rather than from the denormalized
   * `Blog.coverImage`, because an enclosure needs a MIME type the URL alone
   * cannot give. When the Media row is missing — an older post, or a cover set
   * before the reference existed — the denormalized URL is still used, with the
   * type inferred from nothing and therefore the enclosure omitted; the item is
   * published without an image rather than with a malformed one.
   *
   * No image processing happens here and none should: resizing, format
   * conversion and derivative URLs belong to the Media module. RSS publishes
   * what Media stored.
   */
  private buildEnclosure(row: RssBlogRow) {
    const url = absolutePublicUrl(row.coverSecureUrl ?? row.coverImage);
    if (!url || !row.coverMimeType) return null;

    return {
      url,
      mimeType: row.coverMimeType,
      // RSS 2.0 requires the attribute. `0` is the established convention among
      // producers for "size unknown", and is far better than dropping an
      // otherwise-usable image.
      lengthBytes: row.coverFileSize ?? 0,
    };
  }

  private channelTitle(subject: RssFeedSubject): string {
    switch (subject.scope) {
      case 'global':
        return CHANNEL_TITLES.global;
      case 'author':
        return CHANNEL_TITLES.author(subject.name);
      case 'category':
        return CHANNEL_TITLES.category(subject.name);
      case 'tag':
        return CHANNEL_TITLES.tag(subject.name);
    }
  }

  private channelDescription(subject: RssFeedSubject): string {
    switch (subject.scope) {
      case 'global':
        return CHANNEL_DESCRIPTIONS.global;
      case 'author':
        return CHANNEL_DESCRIPTIONS.author(subject.name);
      case 'category':
        return CHANNEL_DESCRIPTIONS.category(subject.name);
      case 'tag':
        return CHANNEL_DESCRIPTIONS.tag(subject.name);
    }
  }

  // ---- Invalidation -------------------------------------------------------
  //
  // Called only by `subscribers/rss.subscriber.ts`. They live here rather than
  // in the subscriber so the subscriber stays a mapping from events to
  // intentions, and so the cache module is not reached into from outside the
  // service — the same arrangement `feedService` uses.

  /**
   * Drops every feed that could contain one post: the global feed, its author's
   * feed, and one feed per tag and category it carries.
   *
   * This is the targeted path, and it is where nearly all of the cache's value
   * survives. Publishing a post about `postgres` invalidates the global feed,
   * that author, and `postgres` — and leaves every other author, tag and
   * category exactly as it was.
   *
   * The term lookup can fail or find nothing (a hard-deleted row, a race with
   * another write). Falling back to the global and author scopes alone is the
   * right degradation: those two are always correct, and the tag and category
   * feeds recover at their TTL.
   */
  async invalidateForBlog(blogId: string, authorId?: string): Promise<void> {
    const keys: GenerationKey[] = ['global'];
    if (authorId) keys.push(`author:${authorId}`);

    const terms = await rssRepository.findBlogTermIds(blogId).catch((err) => {
      logger.warn({ err, blogId }, 'rss: could not resolve blog terms for invalidation');
      return null;
    });

    if (terms) {
      keys.push(`author:${terms.authorId}`);
      for (const tagId of terms.tagIds) keys.push(`tag:${tagId}`);
      for (const categoryId of terms.categoryIds) keys.push(`category:${categoryId}`);
    }

    await bumpGenerations(keys);
  }

  /**
   * Drops the global feed and one author's feed.
   *
   * For changes that alter what an author's items SAY rather than which posts
   * exist — a display-name edit. Their name is embedded in every item they wrote,
   * including items in tag and category feeds, which are deliberately left to
   * expire: a name that is up to five minutes stale in a syndication document is
   * not a defect worth an unbounded fan-out over every term an author has ever
   * used. Content that must LEAVE a feed takes the root path below instead.
   */
  async invalidateForAuthor(authorId: string): Promise<void> {
    await bumpGenerations(['global', `author:${authorId}`]);
  }

  /**
   * Drops every cached feed on the platform.
   *
   * Reserved for events whose blast radius cannot be enumerated cheaply and
   * whose correctness cannot wait: a suspension, a deactivation, an account
   * deletion, or a moderator hiding or removing a post. In each case an entire
   * catalogue leaves the eligible set at once, and the set of tag and category
   * feeds that catalogue touches is an unbounded query on a path that must be
   * immediate.
   *
   * One `INCR`, and every key on the platform becomes unreachable. That it is
   * cheap is exactly why the coarse option is acceptable for the rare case.
   */
  async invalidateEverything(): Promise<void> {
    await bumpGenerations(['root']);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The newest modification instant across a page of items, or `null` for an
 * empty feed.
 *
 * Computed over `updatedAt` rather than `publishedAt` so a corrected post moves
 * the channel's build date — which is what tells a reader holding a cached copy
 * to fetch again. An empty feed has no build date at all, and the response then
 * carries no `Last-Modified`: there is no instant that would be true, and
 * inventing one (the epoch, or now) would either be a lie or defeat caching.
 */
function newestUpdate(items: SyndicationItem[]): Date | null {
  let newest: Date | null = null;
  for (const item of items) {
    const time = item.updatedAt?.getTime?.();
    if (typeof time !== 'number' || Number.isNaN(time)) continue;
    if (!newest || time > newest.getTime()) newest = item.updatedAt;
  }
  return newest;
}

/**
 * The ETag helper lives in `core/utils/httpCache.ts` as `entityTag`, alongside
 * the conditional-request rules that consume it — it moved there when the SEO
 * module needed the same hash-the-output-and-fold-in-a-version tag for its
 * sitemaps. The reasoning it carries (why the OUTPUT is hashed rather than the
 * inputs, why the document version is folded in, why the tag is strong) is
 * unchanged and stated in that file.
 */

export const rssService = new RssService();
