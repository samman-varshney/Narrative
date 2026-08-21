import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../core/exceptions/AppError';
import { logger } from '../../core/utils/logger';
import { escapeXml } from '../../core/utils/xml';
import { ROBOTS_CONTENT_TYPE, SITEMAP_CONTENT_TYPE } from './seo.config';

/**
 * The crawler-facing routes' own error handler.
 *
 * ── Why these routes do not use the global one ──────────────────────────────
 * `globalErrorHandler` answers with the platform's JSON envelope, which is
 * right for an API and wrong here: the client is a crawler that asked for
 * `/sitemap-blogs-3.xml` or `/robots.txt`, and handing it a JSON object under
 * an XML or plain-text request is a content type mismatch on the most public
 * surface the platform has. Mounted on the crawler router only, so the metadata
 * API — which IS JSON, and does use the global handler — is unaffected.
 *
 * ── What it will not say ────────────────────────────────────────────────────
 * Operational `AppError`s carry their own code and message, both written by
 * this codebase for public consumption — "Not found" tells a crawler what it
 * needs and nothing about the platform. Everything else is reported as a bare
 * 500 with a fixed string: an unexpected error's message can contain a query
 * fragment, a constraint name, a connection string or a file path, and none of
 * that belongs in a document served to anonymous crawlers. The real error goes
 * to the log, where it can be read by someone entitled to.
 *
 * Stack traces never leave the process by any path here.
 *
 * ── A failed robots.txt is a conservative robots.txt ────────────────────────
 * When `robots.txt` itself cannot be produced, the response is a valid
 * `Disallow: /` document rather than an error page. Google treats a 5xx on
 * `robots.txt` as "crawl nothing" for a period anyway, so this simply states
 * the same thing in a form every crawler understands — and it is the safe
 * direction: a transient failure that accidentally invited a full crawl of a
 * site whose rules could not be read would be the worse mistake.
 */
export function seoErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Express skips the rest of the response if headers have already gone out.
  // Delegating lets Express close the connection rather than throwing "headers
  // already sent" over the top of the original failure.
  if (res.headersSent) {
    next(err);
    return;
  }

  // This handler belongs to a router mounted at the application ROOT — it has
  // to be, because `/robots.txt` lives there — which puts it in the path of
  // errors raised by modules registered before it. Express does not currently
  // route them here, but "does not currently" is not a contract: an error from
  // `/api/v1/blogs` rendered as XML would break the platform's JSON envelope on
  // an endpoint that has nothing to do with SEO. Owning exactly the three paths
  // this router serves makes that structural rather than incidental.
  if (!ownsPath(req.path)) {
    next(err);
    return;
  }

  const operational = err instanceof AppError && err.isOperational;
  const status = operational ? (err as AppError).statusCode : 500;
  const code = operational ? (err as AppError).errorCode : 'INTERNAL_ERROR';
  const message = operational ? err.message : 'The document could not be generated';

  if (status >= 500) {
    logger.error({ err, path: req.originalUrl }, 'seo: crawler document failed');
  } else {
    logger.warn({ err, path: req.originalUrl }, 'seo: crawler request rejected');
  }

  // An error is never a cacheable representation. Without this an intermediary
  // could hold a 404 for a sitemap chunk that is about to exist, or a 500 from a
  // momentary database blip, and keep serving it to every crawler for the
  // lifetime of the entry.
  res.setHeader('Cache-Control', 'no-store');

  if (req.path === '/robots.txt') {
    res.setHeader('Content-Type', ROBOTS_CONTENT_TYPE);
    res.status(status).send('User-agent: *\nDisallow: /\n');
    return;
  }

  res.setHeader('Content-Type', SITEMAP_CONTENT_TYPE);
  res.status(status).send(errorDocument(code, message));
}

/** The paths this router serves, and therefore the only errors it answers. */
function ownsPath(path: string): boolean {
  return path === '/robots.txt' || path === '/sitemap.xml' || /^\/sitemap-.+\.xml$/.test(path);
}

/**
 * A minimal, well-formed XML error document.
 *
 * Both values are escaped even though both are produced by this codebase —
 * `AppError` messages interpolate values in several modules, and an escaping
 * rule that applies "except where we trust the input" is one that eventually
 * meets input somebody else trusted.
 */
function errorDocument(code: string, message: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<error>',
    `  <code>${escapeXml(code)}</code>`,
    `  <message>${escapeXml(message)}</message>`,
    '</error>',
    '',
  ].join('\n');
}
