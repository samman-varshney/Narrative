import type { Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../../core/exceptions/AppError';
import { applyFeedHeaders, isNotModified } from './rss.http';
import { rssService } from './rss.service';
import type { RssFeedScope } from './rss.types';
import {
  rssQuerySchema,
  rssSlugParamSchema,
  rssUsernameParamSchema,
} from './rss.validator';

/**
 * RSS HTTP layer.
 *
 * Contains no SQL, no eligibility logic, no caching policy and no XML. It
 * parses the request, asks the service for a rendered feed, and decides between
 * 200 and 304 — which is the entire set of HTTP concerns this module has.
 *
 * ── There is no viewer ──────────────────────────────────────────────────────
 * No route here reads `req.user`, and none is wrapped in `optionalAuth`. A feed
 * document is identical for every caller by construction, which is what makes
 * it safe to cache in Redis across viewers, safe to declare `Cache-Control:
 * public` for a CDN, and impossible to leak private content through: there is no
 * viewer-conditional branch that could be got wrong, because there is no viewer.
 * If personalized feeds are ever wanted, the viewer must enter the cache key IN
 * THE SAME CHANGE — the same rule the Feed module states for its shared feeds.
 *
 * ── The response is never JSON ──────────────────────────────────────────────
 * Successful responses are RSS XML. Failures are XML too, rendered by this
 * module's own error handler (`rss.errors.ts`) rather than by the platform's
 * JSON one — a public syndication endpoint should not answer a feed reader with
 * an API envelope it has no idea what to do with.
 */

/**
 * Parses request input with a Zod schema, raising the same `VALIDATION_ERROR`
 * shape the `validateRequest` middleware produces. Local because Express 5 makes
 * `req.query` a read-only getter, so the middleware's parse-and-replace approach
 * cannot be used. Mirrors `blog.controller`, `feed.controller` and
 * `search.controller`.
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

export class RssController {
  /** `GET /rss` — every public post, newest first. */
  global = (req: Request, res: Response) => this.serve(req, res, 'global');

  /** `GET /rss/authors/:username` — one author's public posts. */
  author = (req: Request, res: Response) =>
    this.serve(req, res, 'author', parseOrThrow(rssUsernameParamSchema, req.params).username);

  /** `GET /rss/categories/:slug` — one curated category. */
  category = (req: Request, res: Response) =>
    this.serve(req, res, 'category', parseOrThrow(rssSlugParamSchema, req.params).slug);

  /** `GET /rss/tags/:slug` — one tag. */
  tag = (req: Request, res: Response) =>
    this.serve(req, res, 'tag', parseOrThrow(rssSlugParamSchema, req.params).slug);

  /**
   * The one response path, shared by all four feeds.
   *
   * Headers are applied BEFORE the 200/304 branch, because a 304 has to carry
   * the same validators and freshness information a 200 would — a bare 304
   * leaves the client with nothing to revalidate against next time.
   *
   * `res.end()` rather than `res.send()` on the 304: Express's `send` would set
   * a `Content-Length` of 0, and a 304 must not carry one that contradicts the
   * length of the representation the client is holding.
   */
  private async serve(
    req: Request,
    res: Response,
    scope: RssFeedScope,
    key?: string
  ): Promise<void> {
    const { limit } = parseOrThrow(rssQuerySchema, req.query);
    const feed = await rssService.getFeed({ scope, key, limit });

    applyFeedHeaders(res, feed);

    if (isNotModified(req, feed)) {
      res.status(304).end();
      return;
    }

    res.status(200).send(feed.body);
  }
}

export const rssController = new RssController();
