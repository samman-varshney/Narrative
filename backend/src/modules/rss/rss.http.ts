import type { Request, Response } from 'express';
import { applyCacheHeaders, isNotModified as coreIsNotModified } from '../../core/utils/httpCache';
import {
  HTTP_MAX_AGE_SECONDS,
  HTTP_STALE_WHILE_REVALIDATE_SECONDS,
} from './rss.config';
import type { RenderedFeed } from './rss.types';

/**
 * HTTP cache validation for feed responses.
 *
 * The RULES live in `core/utils/httpCache.ts` — RFC 9110 §13, including the two
 * that are most often got wrong (`If-None-Match` takes precedence over
 * `If-Modified-Since`; entity tags compare WEAKLY on GET). They moved there when
 * the SEO module needed identical behaviour for sitemaps and `robots.txt`, and
 * a second implementation of conditional requests would have been a second
 * chance to get either rule subtly wrong.
 *
 * What stays here is the RSS-specific part: which freshness budget a feed
 * declares, and the fact that a feed's validators come from a `RenderedFeed`.
 *
 * ── Caching never sees content it should not ────────────────────────────────
 * Nothing in this file decides WHAT is in a feed. A 304 is only ever produced
 * against a validator minted from a document the service built under the full
 * eligibility rules — so a conditional request cannot revive a representation
 * containing a post that has since been withdrawn: that post's removal bumped a
 * generation, the rebuilt document has different bytes, and its ETag no longer
 * matches what the client is holding. Revalidation is the mechanism by which
 * removal REACHES the client, not a way around it.
 */

/** Whether the client already holds this exact feed document. */
export function isNotModified(req: Request, feed: RenderedFeed): boolean {
  return coreIsNotModified(req, { etag: feed.etag, lastModified: feed.lastModified });
}

/**
 * Applies the caching and content headers every feed response carries —
 * 200 and 304 alike.
 */
export function applyFeedHeaders(res: Response, feed: RenderedFeed): void {
  applyCacheHeaders(res, {
    contentType: feed.contentType,
    etag: feed.etag,
    lastModified: feed.lastModified,
    maxAge: HTTP_MAX_AGE_SECONDS,
    staleWhileRevalidate: HTTP_STALE_WHILE_REVALIDATE_SECONDS,
  });
}

export { parseHttpDate } from '../../core/utils/httpCache';
