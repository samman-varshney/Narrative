import type { Request, Response } from 'express';
import { AppError } from '../../core/exceptions/AppError';
import { applyCacheHeaders, isNotModified } from '../../core/utils/httpCache';
import {
  HTTP_MAX_AGE_SECONDS,
  HTTP_STALE_WHILE_REVALIDATE_SECONDS,
} from './seo.config';
import { sitemapService } from './sitemap.service';
import { sitemapParamsSchema } from './seo.validator';
import type { RenderedDocument } from './seo.types';

/**
 * The crawler-facing HTTP layer: sitemaps and `robots.txt`.
 *
 * Separate from `seo.controller` because these endpoints have a different
 * contract in every respect — they live at the site root rather than under
 * `/api/v1`, they answer with XML and plain text rather than JSON, and their
 * clients are crawlers rather than a frontend. The only thing the two share is
 * that neither reads a token, and neither contains a line of business logic.
 *
 * ── Why these are at the root and not under /api ────────────────────────────
 * `/robots.txt` is specified to live at the origin's root and nowhere else — a
 * crawler will not look anywhere but there, so the path is not a choice.
 * `/sitemap.xml` follows it for coherence: a sitemap must be at or above the
 * URLs it lists, so one served from `/api/v1/...` could not legally list
 * `/blog/...` at all. Both are therefore mounted on the app rather than on a
 * versioned API router, and both are designed to be proxied to this service
 * from the app's own origin. See SEO_MODULE.md § Route structure.
 */

export class SitemapController {
  /** `GET /sitemap.xml` — the index. */
  index = (req: Request, res: Response) => this.serve(req, res, sitemapService.getIndex());

  /**
   * `GET /sitemap-<section>-<page>.xml` — one chunk.
   *
   * A malformed section or page is a 404 rather than a 400: to a crawler,
   * `/sitemap-nonsense-1.xml` is a URL that does not exist, and telling it the
   * request was invalid invites it to keep asking. The validator's failure is
   * caught here and turned into the same answer an out-of-range page gets.
   */
  chunk = async (req: Request, res: Response) => {
    const parsed = sitemapParamsSchema.safeParse(req.params);
    if (!parsed.success) throw new AppError('Not found', 404, 'SITEMAP_NOT_FOUND');

    return this.serve(req, res, sitemapService.getChunk(parsed.data.section, parsed.data.page));
  };

  /** `GET /robots.txt` */
  robots = (req: Request, res: Response) =>
    this.serve(req, res, sitemapService.getRobots(), HTTP_MAX_AGE_SECONDS.robots);

  /**
   * The one response path.
   *
   * Headers are applied BEFORE the 200/304 branch, because a 304 has to carry
   * the same validators and freshness information a 200 would.
   */
  private async serve(
    req: Request,
    res: Response,
    pending: Promise<RenderedDocument>,
    maxAge: number = HTTP_MAX_AGE_SECONDS.sitemap
  ): Promise<void> {
    const document = await pending;

    applyCacheHeaders(res, {
      contentType: document.contentType,
      etag: document.etag,
      lastModified: document.lastModified,
      maxAge,
      staleWhileRevalidate: HTTP_STALE_WHILE_REVALIDATE_SECONDS,
    });

    if (isNotModified(req, { etag: document.etag, lastModified: document.lastModified })) {
      // `res.end()` rather than `res.send()`, so the 304 carries no
      // `Content-Length` contradicting the copy the client already holds.
      res.status(304).end();
      return;
    }

    res.status(200).send(document.body);
  }
}

export const sitemapController = new SitemapController();