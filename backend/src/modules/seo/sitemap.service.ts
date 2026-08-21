import { AppError } from '../../core/exceptions/AppError';
import { entityTag } from '../../core/utils/httpCache';
import { logger } from '../../core/utils/logger';
import {
  blogUrl,
  authorUrl,
  categoryUrl,
  homeUrl,
  tagUrl,
} from '../../core/utils/publicUrls';
import {
  bumpGenerations,
  readDocument,
  readGenerations,
  robotsKey,
  sitemapChunkKey,
  sitemapIndexKey,
  writeDocument,
} from './seo.cache';
import {
  CACHE_TTL_SECONDS,
  ROBOTS_CONTENT_TYPE,
  SEO_DOCUMENT_VERSION,
  SITEMAP_CONTENT_TYPE,
  SITEMAP_HINTS,
  SITEMAP_MAX_CHUNKS,
  indexingEnabled,
} from './seo.config';
import { seoRepository } from './seo.repository';
import { renderRobotsTxt } from './seo.robots';
import { renderSitemapIndex, renderUrlSet } from './seo.serializer';
import { sitemapChunkUrl } from './seo.urls';
import {
  DYNAMIC_SITEMAP_SECTIONS,
  type DynamicSitemapSection,
  type RenderedDocument,
  type SitemapEntry,
  type SitemapIndexEntry,
  type SitemapSection,
} from './seo.types';

/**
 * Sitemap and `robots.txt` orchestration.
 *
 * Separate from `seo.service` on purpose. The two answer different questions
 * with different shapes: metadata resolution is one resource at a time, keyed
 * by slug, cached for minutes and read by a page render; a sitemap is thousands
 * of rows at a time, keyed by section and page, cached for an hour and read by
 * a crawler. Putting both in one class would produce exactly the
 * `seo.service.ts`-does-everything file the brief warns against, and neither
 * half would be readable.
 *
 * ── Nothing here is unbounded ───────────────────────────────────────────────
 * A chunk is at most `SITEMAP_URLS_PER_CHUNK` rows, a section at most
 * `SITEMAP_MAX_CHUNKS` chunks, and the index is built from one aggregate query
 * per section. There is no path through this file that loads a table.
 *
 * ── The index is where the work happens ─────────────────────────────────────
 * Building it costs one aggregate per section — four queries — and it is cached
 * for an hour. Every chunk request afterwards is a single bounded page query,
 * also cached. A crawler fetching the index and then forty chunks costs the
 * database roughly forty-four queries once an hour, and nothing at all for the
 * rest of it.
 */
export class SitemapService {
  /**
   * The sitemap index: the one document `robots.txt` advertises.
   *
   * Refused outright when indexing is disabled, rather than served empty.
   * `robots.txt` already disallows everything in that mode, and serving a valid
   * sitemap alongside it is the contradiction a crawler resolves in whichever
   * direction is worst. The check lives here rather than on the route so a new
   * route cannot forget it.
   *
   * Sections with no content are omitted rather than listed as empty. An empty
   * `<urlset>` is legal and useless, and a crawler that fetches it learns
   * nothing it did not already know from the index not naming it.
   */
  async getIndex(): Promise<RenderedDocument> {
    if (!indexingEnabled()) throw notFound();

    const { root, sitemap } = await this.generations();
    const key = sitemapIndexKey(root, sitemap);

    const hit = await readDocument(key);
    if (hit) return hit;

    const entries: SitemapIndexEntry[] = [
      // The static section always exists and always has exactly one page.
      { loc: sitemapChunkUrl('pages', 1), lastmod: null },
    ];

    for (const section of DYNAMIC_SITEMAP_SECTIONS) {
      const summary = await this.chunkSummary(section);
      for (const chunk of summary) {
        entries.push({ loc: sitemapChunkUrl(section, chunk.page), lastmod: chunk.lastmod });
      }
    }

    const document = this.render(renderSitemapIndex(entries), entries.map((e) => e.lastmod));
    await writeDocument(key, document, CACHE_TTL_SECONDS.sitemap);
    return document;
  }

  /**
   * One chunk of one section.
   *
   * A page beyond what the section holds is a 404 rather than an empty
   * document, so a crawler that kept an old index does not keep fetching
   * sitemaps that no longer exist — and so a stranger cannot mint unbounded
   * distinct cache entries by walking page numbers.
   */
  async getChunk(section: SitemapSection, page: number): Promise<RenderedDocument> {
    if (!indexingEnabled()) throw notFound();
    if (page < 1 || page > SITEMAP_MAX_CHUNKS) throw notFound();

    const { root, sitemap } = await this.generations();
    const key = sitemapChunkKey(section, page, root, sitemap);

    const hit = await readDocument(key);
    if (hit) return hit;

    const entries =
      section === 'pages' ? this.staticEntries(page) : await this.dynamicEntries(section, page);

    if (entries.length === 0) throw notFound();

    const document = this.render(renderUrlSet(entries), entries.map((e) => e.lastmod));
    await writeDocument(key, document, CACHE_TTL_SECONDS.sitemap);
    return document;
  }

  /**
   * `robots.txt`.
   *
   * Cached like the sitemaps even though it is a function of configuration
   * alone — not to save the work of building it, which is trivial, but so that
   * it arrives with the same ETag and `Last-Modified` handling as everything
   * else this module serves and a crawler polling it gets a 304.
   *
   * It has no `Last-Modified`: the document changes on deploy, and there is no
   * instant the platform records for that. A validator it cannot state truly is
   * better omitted — the ETag still gives a crawler everything it needs to
   * revalidate.
   */
  async getRobots(): Promise<RenderedDocument> {
    const { root } = await this.generations();
    const key = robotsKey(root);

    const hit = await readDocument(key);
    if (hit) return hit;

    const body = renderRobotsTxt();
    const document: RenderedDocument = {
      body,
      contentType: ROBOTS_CONTENT_TYPE,
      etag: entityTag(SEO_DOCUMENT_VERSION, body),
      lastModified: null,
    };

    await writeDocument(key, document, CACHE_TTL_SECONDS.robots);
    return document;
  }

  /**
   * Drops every cached sitemap.
   *
   * One `INCR`. A sitemap cannot be invalidated precisely: a post entering or
   * leaving the eligible set can shift every row after it into a different
   * chunk, so "which documents changed" is genuinely "possibly all of them".
   * That is the honest answer, and at one operation it is also the cheap one.
   */
  async invalidate(): Promise<void> {
    await bumpGenerations(['sitemap']);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The platform's own fixed pages.
   *
   * The home page, and only the home page. Every other public page on the
   * platform describes a resource and is listed by the section that owns it;
   * pages that require a session (the dashboard, settings) are not public and
   * are disallowed in `robots.txt`. Inventing entries for pages the product
   * does not have is the failure mode this deliberately short list avoids.
   */
  private staticEntries(page: number): SitemapEntry[] {
    if (page !== 1) return [];

    return [
      {
        loc: homeUrl(),
        // No `lastmod`: the home page is a feed of whatever is newest, and the
        // platform records no instant for "the home page changed".
        lastmod: null,
        changefreq: SITEMAP_HINTS.home.changefreq,
        priority: SITEMAP_HINTS.home.priority,
      },
    ];
  }

  /** One page of a database-backed section, mapped to public URLs. */
  private async dynamicEntries(
    section: DynamicSitemapSection,
    page: number
  ): Promise<SitemapEntry[]> {
    const rows = await seoRepository.findSitemapChunk(section, page);
    const hints = SITEMAP_HINTS[section];

    return rows.map((row) => ({
      loc: this.locFor(section, row.key),
      lastmod: row.lastmod,
      changefreq: hints.changefreq,
      priority: hints.priority,
    }));
  }

  /**
   * A section's key turned into a public URL.
   *
   * Through `core/utils/publicUrls`, never by string concatenation here — a
   * sitemap listing a URL the rest of the platform does not link to is a
   * crawl budget spent on 404s, and one listing a non-canonical spelling is a
   * duplicate-content problem the canonical tags then have to clean up.
   */
  private locFor(section: DynamicSitemapSection, key: string): string {
    switch (section) {
      case 'blogs':
        return blogUrl(key);
      case 'authors':
        return authorUrl(key);
      case 'categories':
        return categoryUrl(key);
      case 'tags':
        return tagUrl(key);
    }
  }

  /**
   * A section's chunk summary, defensively.
   *
   * A section whose aggregate fails contributes nothing to the index rather
   * than failing the whole document. A sitemap index missing one section is a
   * degraded but valid instruction to a crawler; a 500 is a crawler that learns
   * nothing at all and may back off from the whole site.
   */
  private async chunkSummary(
    section: DynamicSitemapSection
  ): Promise<{ page: number; urls: number; lastmod: Date | null }[]> {
    try {
      return await seoRepository.findSitemapChunkSummary(section);
    } catch (err) {
      logger.warn({ err, section }, 'seo: sitemap section summary failed — section omitted');
      return [];
    }
  }

  private async generations(): Promise<{ root: number; sitemap: number }> {
    const generations = await readGenerations(['root', 'sitemap']);
    return {
      root: generations.get('root') ?? 0,
      sitemap: generations.get('sitemap') ?? 0,
    };
  }

  /**
   * Wraps rendered bytes with the validators HTTP caching needs.
   *
   * `lastModified` is the newest instant IN the document, never the clock.
   * Using `new Date()` would be the obvious reading and would break caching
   * completely: every regeneration would produce a `Last-Modified` that marched
   * forward while nothing had changed, so every crawler would re-download every
   * sitemap on every visit and the 304 path would never fire.
   */
  private render(body: string, instants: (Date | null)[]): RenderedDocument {
    let newest: Date | null = null;
    for (const instant of instants) {
      const time = instant?.getTime?.();
      if (typeof time !== 'number' || Number.isNaN(time)) continue;
      if (!newest || time > newest.getTime()) newest = instant;
    }

    return {
      body,
      contentType: SITEMAP_CONTENT_TYPE,
      etag: entityTag(SEO_DOCUMENT_VERSION, body),
      lastModified: newest,
    };
  }
}

/**
 * A sitemap that does not exist.
 *
 * Deliberately identical whether the section is unknown, the page is beyond the
 * end, or indexing is disabled — a crawler needs "not here", and nothing else
 * about it is any of its business.
 */
const notFound = (): AppError =>
  new AppError('Not found', 404, 'SITEMAP_NOT_FOUND');

export const sitemapService = new SitemapService();
