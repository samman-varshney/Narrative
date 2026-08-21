import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { applyCacheHeaders, entityTag, isNotModified } from '../../core/utils/httpCache';
import { HTTP_MAX_AGE_SECONDS, SEO_DOCUMENT_VERSION } from './seo.config';
import { renderHeadTags } from './seo.serializer';
import { seoService } from './seo.service';
import {
  seoFormatQuerySchema,
  seoSlugParamSchema,
  seoUsernameParamSchema,
} from './seo.validator';
import type { ResolvedMetadata } from './seo.types';

/**
 * The public metadata API's HTTP layer.
 *
 * Contains no SQL, no visibility logic, no resolution precedence and no
 * markup. It parses the request, asks the service for resolved metadata, picks
 * a representation, and decides between 200 and 304 — which is the entire set
 * of HTTP concerns this half of the module has.
 *
 * ── There is no viewer ──────────────────────────────────────────────────────
 * No route here reads `req.user`, and none is wrapped in `optionalAuth`. Public
 * metadata is identical for every caller by construction, which is what makes
 * it safe to cache in Redis across viewers, safe to declare `Cache-Control:
 * public` for a CDN, and impossible to leak gated content through: there is no
 * viewer-conditional branch that could be got wrong, because there is no
 * viewer. A members-only post is not "metadata a member can see" — it is a 404
 * on this endpoint, decided in `seo.indexability`.
 *
 * ── Two representations of one resolution ───────────────────────────────────
 * `?format=json` (the default) returns `ResolvedMetadata` in the platform's
 * standard envelope. `?format=html` returns the same thing rendered as a
 * `<head>` fragment. The second exists because escaping metadata into markup is
 * the one part of consuming this API that is genuinely dangerous, and one
 * tested implementation is better than each consumer's own — see
 * `seo.serializer.renderHeadTags`.
 */

/**
 * Parses request input with a Zod schema, raising the same `VALIDATION_ERROR`
 * shape the `validateRequest` middleware produces. Local because Express 5
 * makes `req.query` a read-only getter, so the middleware's parse-and-replace
 * approach cannot be used. Mirrors `blog.controller`, `feed.controller`,
 * `search.controller` and `rss.controller`.
 */
function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', true, details);
  }
  return result.data;
}

export class SeoController {
  /** `GET /seo/site` — the home page's metadata. */
  site = (req: Request, res: Response) => this.serve(req, res, () => seoService.getSiteMetadata());

  /** `GET /seo/blogs/:slug` */
  blog = (req: Request, res: Response) =>
    this.serve(req, res, () =>
      seoService.getBlogMetadata(parseOrThrow(seoSlugParamSchema, req.params).slug)
    );

  /** `GET /seo/authors/:username` */
  author = (req: Request, res: Response) =>
    this.serve(req, res, () =>
      seoService.getAuthorMetadata(parseOrThrow(seoUsernameParamSchema, req.params).username)
    );

  /** `GET /seo/categories/:slug` */
  category = (req: Request, res: Response) =>
    this.serve(req, res, () =>
      seoService.getCategoryMetadata(parseOrThrow(seoSlugParamSchema, req.params).slug)
    );

  /** `GET /seo/tags/:slug` */
  tag = (req: Request, res: Response) =>
    this.serve(req, res, () =>
      seoService.getTagMetadata(parseOrThrow(seoSlugParamSchema, req.params).slug)
    );

  /**
   * The one response path, shared by all five endpoints.
   *
   * The ETag is computed over the BYTES that will actually be sent, not over
   * the resolved metadata — so the two representations get different validators
   * and a client that switched format is never told 304 about the other one.
   *
   * Headers are applied BEFORE the 200/304 branch, because a 304 has to carry
   * the same validators and freshness information a 200 would; a bare 304
   * leaves the client with nothing to revalidate against next time.
   */
  private async serve(
    req: Request,
    res: Response,
    resolve: () => Promise<ResolvedMetadata>
  ): Promise<void> {
    const { format } = parseOrThrow(seoFormatQuerySchema, req.query);
    const metadata = await resolve();

    const { body, contentType } =
      format === 'html'
        ? { body: renderHeadTags(metadata), contentType: 'text/html; charset=utf-8' }
        : {
            body: JSON.stringify({ success: true, data: metadata }),
            contentType: 'application/json; charset=utf-8',
          };

    applyCacheHeaders(res, {
      contentType,
      etag: entityTag(SEO_DOCUMENT_VERSION, body),
      // Metadata has no single modification instant it can state honestly — a
      // page's title can change with its author's display name as easily as with
      // its own edit — so it carries an ETag and no `Last-Modified`. A validator
      // that cannot be stated truly is better omitted than guessed.
      lastModified: null,
      maxAge: HTTP_MAX_AGE_SECONDS.metadata,
    });

    if (isNotModified(req, { etag: res.getHeader('ETag') as string, lastModified: null })) {
      // `res.end()` rather than `res.send()`: Express's `send` would set a
      // `Content-Length` of 0, and a 304 must not carry one that contradicts the
      // length of the representation the client is holding.
      res.status(304).end();
      return;
    }

    res.status(200).send(body);
  }
}

export const seoController = new SeoController();
