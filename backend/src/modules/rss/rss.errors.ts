import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../core/exceptions/AppError';
import { logger } from '../../core/utils/logger';
import { escapeXml } from './rss.renderer';
import { RSS_ERROR_CONTENT_TYPE } from './rss.config';

/**
 * The RSS router's own error handler.
 *
 * ── Why this module does not use the global one ─────────────────────────────
 * `globalErrorHandler` answers with the platform's JSON envelope, which is
 * exactly right for an API and wrong for a syndication endpoint: the client is
 * a feed reader, the negotiated media type is XML, and handing it
 * `{"success":false,...}` under an `application/rss+xml` request is a content
 * type mismatch on the most public surface the platform has. Mounted on the RSS
 * router only, so nothing else on the platform changes.
 *
 * ── What it will not say ────────────────────────────────────────────────────
 * Operational `AppError`s carry their own code and message, both of which are
 * written by this codebase for public consumption — "Feed not found" tells a
 * reader what it needs and nothing about the platform. Everything else is
 * reported as a bare 500 with a fixed string: an unexpected error's message can
 * contain a query fragment, a constraint name, a connection string or a file
 * path, and none of that belongs in a document served to anonymous crawlers.
 * The real error goes to the log, where it can be read by someone entitled to.
 *
 * Stack traces never leave the process by any path here.
 */
export function rssErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Express skips the rest of the response if headers have already gone out —
  // which can happen if a stream failed midway. Delegating lets Express close
  // the connection rather than throwing "headers already sent" over the top of
  // the original failure.
  if (res.headersSent) {
    next(err);
    return;
  }

  const operational = err instanceof AppError && err.isOperational;
  const status = operational ? (err as AppError).statusCode : 500;
  const code = operational ? (err as AppError).errorCode : 'INTERNAL_ERROR';
  const message = operational ? err.message : 'The feed could not be generated';

  if (status >= 500) {
    logger.error({ err, path: req.originalUrl }, 'rss: feed generation failed');
  } else {
    logger.warn({ err, path: req.originalUrl }, 'rss: feed request rejected');
  }

  res.setHeader('Content-Type', RSS_ERROR_CONTENT_TYPE);
  // An error is never a cacheable representation of a feed. Without this an
  // intermediary could hold a 404 for a category that is about to be created,
  // or a 500 from a momentary database blip, and keep serving it to every
  // subscriber for the lifetime of the entry.
  res.setHeader('Cache-Control', 'no-store');

  res.status(status).send(errorDocument(code, message));
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
