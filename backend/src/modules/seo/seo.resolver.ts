import {
  authorUrl,
  blogUrl,
  categoryUrl,
  homeUrl,
  safeHttpUrl,
  absolutePublicUrl,
  tagUrl,
} from '../../core/utils/publicUrls';
import {
  plainTextFromEditorDocument,
  toPlainText,
  truncateAtWord,
} from '../../core/utils/text';
import {
  DESCRIPTIONS,
  HOME_BREADCRUMB_LABEL,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  TITLES,
  defaultDescription,
  defaultImage,
  defaultTitle,
  siteName,
  titleWithSite,
  twitterSiteHandle,
} from './seo.config';
import {
  isAuthorIndexable,
  isBlogIndexable,
  isTermIndexable,
  robotsDirective,
} from './seo.indexability';
import {
  buildBlogPosting,
  buildBreadcrumbList,
  buildCollectionPage,
  buildPerson,
  buildProfilePage,
  buildWebSite,
} from './seo.structuredData';
import type {
  AuthorSeoSource,
  BlogSeoSource,
  BreadcrumbItem,
  OpenGraphMetadata,
  ResolvedMetadata,
  StructuredDataNode,
  TermSeoSource,
  TwitterCardType,
  TwitterMetadata,
} from './seo.types';

/**
 * Metadata resolution — where a database row becomes a finished description of
 * a page.
 *
 * Pure. Nothing in this file performs I/O, reads a clock, or touches Redis, so
 * every rule below is assertable from a unit test with a literal object, and
 * the same input always produces the same output. That determinism is
 * load-bearing twice over: the ETag is a hash of what this produces, and the
 * cache stores it.
 *
 * ── The precedence chain ────────────────────────────────────────────────────
 *
 *     explicit resource metadata      what the author wrote in `BlogSEO`
 *              ↓                      (only blogs have overrides today)
 *     resource-derived metadata       the title, subtitle, cover, bio, term name
 *              ↓
 *     generated metadata              a true sentence built from what is known
 *              ↓
 *     site defaults                   SEO_DEFAULT_* configuration
 *
 * Each step is tried in order and the first usable value wins, where "usable"
 * means non-empty AFTER sanitization — an override consisting of a stray
 * `<span>` is not an override, it is an empty string wearing markup.
 *
 * The chain always terminates in something true rather than in `null`: a post
 * with no description at all resolves to "A post by <author> on <site>." rather than
 * to the site's own tagline, because a description that describes the site
 * instead of the page is worse than a generic one that is at least about the
 * page. Nothing here fabricates a fact — every generated string is assembled
 * from values the page itself displays.
 *
 * ── An explicit title is used verbatim ──────────────────────────────────────
 * A DERIVED title gets the site's name appended (`Post — Narrative`); an
 * explicit `metaTitle` does not. "Override" is taken literally: an author who
 * writes a meta title has decided what the tab should say, and appending to it
 * would mean no author could ever choose a title that did not end in the site's
 * name. It is the one place this module's output differs from
 * `blogService.effectiveSeo`, which returns the stored overrides as they are
 * for the blog API rather than resolving them for rendering.
 *
 * ── Everything user-controlled is sanitized here ────────────────────────────
 * `metaTitle`, `metaDescription`, `ogTitle` and `ogDescription` are stored RAW
 * — `seoInputSchema` bounds their length and nothing else — so an author can
 * put markup in any of them. Every one passes through `toPlainText`, and every
 * URL through `safeHttpUrl`, before it can reach a document. See SEO_MODULE.md
 * § Security.
 */
/**
 * First path segments on x.com that are ROUTES rather than accounts.
 *
 * Without this, `https://x.com/i/status/123` — a perfectly ordinary link to a
 * post — yields the handle `@i`, and the platform would attribute an author's
 * writing to a reserved path. The list is the handful of segments that are
 * unambiguously navigation; it does not need to be exhaustive, because
 * everything it misses still has to survive the handle pattern above, and the
 * consequence of a miss is a `twitter:creator` that does not resolve rather
 * than one pointing at somebody real.
 */
const X_RESERVED_PATHS = new Set([
  'i',
  'home',
  'explore',
  'search',
  'intent',
  'share',
  'hashtag',
  'compose',
  'messages',
  'notifications',
  'settings',
  'login',
  'signup',
  'about',
  'privacy',
  'tos',
]);

export class SeoResolver {
  // -------------------------------------------------------------------------
  // Site
  // -------------------------------------------------------------------------

  /**
   * The home page, and the last-resort description of the platform itself.
   *
   * The only resource with no database row behind it: everything it says comes
   * from configuration, which is why it can never 404 and never varies.
   */
  resolveSite(): ResolvedMetadata {
    const site = siteName();
    const canonicalUrl = homeUrl();
    const title = defaultTitle();
    const description = defaultDescription();
    const image = safeHttpUrl(defaultImage());

    const openGraph: OpenGraphMetadata = {
      title,
      description,
      url: canonicalUrl,
      type: 'website',
      siteName: site,
      image,
    };

    return {
      resource: 'site',
      title,
      description,
      canonicalUrl,
      robots: robotsDirective(true),
      openGraph,
      twitter: this.twitter(openGraph, null),
      structuredData: [buildWebSite()],
      breadcrumbs: [],
    };
  }

  // -------------------------------------------------------------------------
  // Blog
  // -------------------------------------------------------------------------

  /**
   * A post.
   *
   * `content` is the editor document, supplied by the service ONLY when the
   * post has neither an author-written description nor a subtitle — so the
   * expensive fallback is computed for the posts that need it and no others.
   */
  resolveBlog(blog: BlogSeoSource, content?: unknown): ResolvedMetadata {
    const site = siteName();
    const explicit = blog.seo;

    const metaTitle = toPlainText(explicit?.metaTitle);
    const title = metaTitle
      ? truncateAtWord(metaTitle, MAX_TITLE_LENGTH)
      : truncateAtWord(titleWithSite(toPlainText(blog.title), site), MAX_TITLE_LENGTH);

    const description = this.blogDescription(blog, content, site);

    // The author's declared canonical URL wins when they set one — that is what
    // the field is FOR (a post cross-published from somewhere else points home).
    // It is scheme-checked rather than trusted, and a post carrying one is left
    // out of the sitemap: see `seo.repository`, and SEO_MODULE.md § Duplicate
    // content protection.
    const canonicalUrl = safeHttpUrl(explicit?.canonicalUrl) ?? blogUrl(blog.slug);

    const profileUrl = authorUrl(blog.author.username);
    const image =
      safeHttpUrl(explicit?.ogImage) ??
      absolutePublicUrl(blog.coverSecureUrl ?? blog.coverImage) ??
      safeHttpUrl(defaultImage());

    const primaryCategory = blog.categories[0] ?? null;

    const openGraph: OpenGraphMetadata = {
      // `og:title` is the bare page title, never the site-suffixed one:
      // `og:site_name` already carries the platform's name, and a preview card
      // showing "Post — Narrative · Narrative" is the result of doing both.
      title: toPlainText(explicit?.ogTitle) || metaTitle || toPlainText(blog.title),
      description: toPlainText(explicit?.ogDescription) || description,
      url: canonicalUrl,
      type: 'article',
      siteName: site,
      image,
      article: {
        publishedTime: this.iso(blog.publishedAt),
        modifiedTime: this.iso(blog.updatedAt),
        author: profileUrl,
        section: primaryCategory?.name ?? null,
        tags: blog.tags.map((tag) => tag.name),
      },
    };

    const breadcrumbs: BreadcrumbItem[] = [
      { name: HOME_BREADCRUMB_LABEL, url: homeUrl() },
      ...(primaryCategory
        ? [{ name: primaryCategory.name, url: categoryUrl(primaryCategory.slug) }]
        : []),
      { name: toPlainText(blog.title), url: canonicalUrl },
    ];

    const structuredData: StructuredDataNode[] = [
      buildBlogPosting({
        title: toPlainText(blog.title),
        description,
        canonicalUrl,
        image,
        publishedAt: blog.publishedAt,
        updatedAt: blog.updatedAt,
        author: { name: toPlainText(blog.author.name), profileUrl },
        keywords: blog.tags.map((tag) => tag.name),
        section: primaryCategory?.name ?? null,
      }),
    ];
    this.pushBreadcrumbs(structuredData, breadcrumbs);

    return {
      resource: 'blog',
      title,
      description,
      canonicalUrl,
      robots: robotsDirective(isBlogIndexable(blog)),
      openGraph,
      twitter: this.twitter(openGraph, blog.author.x, explicit?.twitterCard),
      structuredData,
      breadcrumbs,
    };
  }

  /**
   * A post's description, in precedence order.
   *
   * The chain mirrors `blogService.effectiveSeo` and `rss.content` for its first
   * three steps — the author's summary, the subtitle, then the body — so what a
   * search result, a preview card and a feed item say about a post cannot
   * disagree. The fourth step is this module's own: a generated sentence, so a
   * post with an empty body still has something true to say about itself.
   */
  private blogDescription(blog: BlogSeoSource, content: unknown, site: string): string {
    const explicit = toPlainText(blog.seo?.metaDescription);
    if (explicit) return explicit;

    const subtitle = toPlainText(blog.subtitle);
    if (subtitle) return truncateAtWord(subtitle, MAX_DESCRIPTION_LENGTH);

    const body = toPlainText(plainTextFromEditorDocument(content));
    if (body) return truncateAtWord(body, MAX_DESCRIPTION_LENGTH);

    return `${toPlainText(blog.title)} — a post by ${toPlainText(blog.author.name)} on ${site}.`;
  }

  // -------------------------------------------------------------------------
  // Author
  // -------------------------------------------------------------------------

  resolveAuthor(author: AuthorSeoSource): ResolvedMetadata {
    const site = siteName();
    const name = toPlainText(author.name);
    const canonicalUrl = authorUrl(author.username);

    // A private profile renders only a name and an avatar (see
    // `userService.getPublicProfile`), so its metadata says only that much. The
    // bio is part of what `isPrivate` withholds, and a description built from it
    // would put the hidden half into a preview card.
    const bio = author.isPrivate ? '' : toPlainText(author.bio);
    const description = bio
      ? truncateAtWord(bio, MAX_DESCRIPTION_LENGTH)
      : DESCRIPTIONS.author(name, site);

    const image = author.isPrivate
      ? null
      : (absolutePublicUrl(author.avatar) ?? safeHttpUrl(defaultImage()));

    const openGraph: OpenGraphMetadata = {
      title: TITLES.author(name),
      description,
      url: canonicalUrl,
      type: 'profile',
      siteName: site,
      image,
      profile: { username: author.username },
    };

    const breadcrumbs: BreadcrumbItem[] = [
      { name: HOME_BREADCRUMB_LABEL, url: homeUrl() },
      { name, url: canonicalUrl },
    ];

    const person = buildPerson({
      name,
      profileUrl: canonicalUrl,
      description: bio || null,
      image,
      // `sameAs` states "this is the same person as those external profiles" —
      // links the author themselves put on their profile. Scheme-checked, and a
      // private profile publishes none of them.
      sameAs: author.isPrivate ? [] : author.socialLinks.map((link) => safeHttpUrl(link)),
    });

    const structuredData: StructuredDataNode[] = [
      buildProfilePage({ canonicalUrl, person, createdAt: author.createdAt }),
    ];
    this.pushBreadcrumbs(structuredData, breadcrumbs);

    return {
      resource: 'author',
      title: truncateAtWord(titleWithSite(TITLES.author(name), site), MAX_TITLE_LENGTH),
      description,
      canonicalUrl,
      robots: robotsDirective(isAuthorIndexable(author)),
      openGraph,
      twitter: this.twitter(openGraph, author.isPrivate ? null : author.x),
      structuredData,
      breadcrumbs,
    };
  }

  // -------------------------------------------------------------------------
  // Category and tag
  // -------------------------------------------------------------------------

  resolveTerm(kind: 'category' | 'tag', term: TermSeoSource): ResolvedMetadata {
    const site = siteName();
    const name = toPlainText(term.name);
    const canonicalUrl = kind === 'category' ? categoryUrl(term.slug) : tagUrl(term.slug);
    const label = kind === 'category' ? TITLES.category(name) : TITLES.tag(name);
    const description =
      kind === 'category'
        ? DESCRIPTIONS.category(name, site)
        : DESCRIPTIONS.tag(name, site);

    const openGraph: OpenGraphMetadata = {
      title: label,
      description,
      url: canonicalUrl,
      // `website`, not `article`: a term page is a list, and the platform has no
      // Open Graph type for "a collection of posts". The structured data below
      // says `CollectionPage`, which does.
      type: 'website',
      siteName: site,
      image: safeHttpUrl(defaultImage()),
    };

    const breadcrumbs: BreadcrumbItem[] = [
      { name: HOME_BREADCRUMB_LABEL, url: homeUrl() },
      { name: label, url: canonicalUrl },
    ];

    const structuredData: StructuredDataNode[] = [
      buildCollectionPage({
        name: label,
        description,
        canonicalUrl,
        updatedAt: term.lastPublishedAt,
      }),
    ];
    this.pushBreadcrumbs(structuredData, breadcrumbs);

    return {
      resource: kind,
      title: truncateAtWord(titleWithSite(label, site), MAX_TITLE_LENGTH),
      description,
      canonicalUrl,
      robots: robotsDirective(isTermIndexable(term)),
      openGraph,
      twitter: this.twitter(openGraph, null),
      structuredData,
      breadcrumbs,
    };
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * Twitter/X card metadata, derived from what Open Graph already resolved.
   *
   * Derived rather than resolved a second time on purpose: X's crawler falls
   * back to the Open Graph tags for anything the `twitter:*` tags omit, so two
   * independent chains could only ever differ by being wrong in one of them.
   *
   * The card TYPE is the one genuine decision. An explicit `twitterCard` wins;
   * otherwise a page with an image gets `summary_large_image` and a page
   * without gets `summary` — because `summary_large_image` with no image
   * renders as a card with a blank space where the picture should be.
   */
  private twitter(
    openGraph: OpenGraphMetadata,
    creatorUrl: string | null,
    explicitCard?: string | null
  ): TwitterMetadata {
    const card: TwitterCardType =
      explicitCard === 'summary' || explicitCard === 'summary_large_image'
        ? explicitCard
        : openGraph.image
          ? 'summary_large_image'
          : 'summary';

    return {
      card,
      title: openGraph.title,
      description: openGraph.description,
      image: openGraph.image,
      site: twitterSiteHandle(),
      creator: this.twitterHandle(creatorUrl),
    };
  }

  /**
   * The author's X handle, from the URL they stored on their developer profile.
   *
   * `DeveloperProfile.x` is validated only as a well-formed URL, so it can be
   * any address at all. A handle is derived ONLY when the host is x.com or
   * twitter.com and the first path segment looks like a handle; anything else
   * yields null. Without that check, an author could put any string into every
   * preview card of every post they write — `twitter:creator` is rendered as an
   * attribution, and attributing a post to someone else's account is exactly
   * the impersonation the platform's moderation rules exist to prevent.
   */
  private twitterHandle(value: string | null): string | null {
    const safe = safeHttpUrl(value);
    if (!safe) return null;

    try {
      const parsed = new URL(safe);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (host !== 'x.com' && host !== 'twitter.com') return null;

      const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
      const handle = segment.replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
      if (X_RESERVED_PATHS.has(handle.toLowerCase())) return null;

      return `@${handle}`;
    } catch {
      return null;
    }
  }

  /** Appends the breadcrumb node, when the trail describes a real hierarchy. */
  private pushBreadcrumbs(nodes: StructuredDataNode[], items: BreadcrumbItem[]): void {
    const node = buildBreadcrumbList(items);
    if (node) nodes.push(node);
  }

  /** ISO-8601, or null for an absent or unusable date. */
  private iso(date: Date | null): string | null {
    if (!date || Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }
}

export const seoResolver = new SeoResolver();
