import type { Request, Response } from 'express';
import {
  HTTP_MAX_AGE_SECONDS,
  HTTP_STALE_WHILE_REVALIDATE_SECONDS,
} from './rss.config';
import type { RenderedFeed } from './rss.types';

/**
 * HTTP cache validation for feed responses.
 *
 * Pure functions over headers, kept out of the controller so the rules can be
 * asserted directly. The rules are RFC 9110 §13, and the two that are most often
 * got wrong are both here:
 *
 *   PRECEDENCE   `If-None-Match` wins whenever it is present. `If-Modified-Since`
 *                is evaluated ONLY in its absence. A client that sends both —
 *                which every serious feed reader does — must not be able to get
 *                a 200 out of a stale date when its entity tag still matches.
 *
 *   COMPARISON   Entity tags in `If-None-Match` are compared WEAKLY on GET.
 *                `W/"abc"` and `"abc"` identify the same representation for the
 *                purpose of "have I already got this", and a strict string
 *                comparison would 200 every client behind a proxy that
 *                weakened the tag in transit — silently turning the entire
 *                caching layer off.
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

/**
 * Whether the client already holds this exact representation.
 *
 * `false` for anything ambiguous — an unparsable date, a malformed tag list, a
 * feed with no modification instant. Returning a 200 to a client that could
 * have had a 304 wastes bandwidth; returning a 304 to one that could not is a
 * correctness bug that shows up as a reader stuck on an old feed forever.
 */
export function isNotModified(req: Request, feed: RenderedFeed): boolean {
  const ifNoneMatch = headerValue(req, 'if-none-match');

  if (ifNoneMatch !== null) {
    return etagMatches(ifNoneMatch, feed.etag);
  }

  const ifModifiedSince = headerValue(req, 'if-modified-since');
  if (ifModifiedSince !== null && feed.lastModified) {
    const since = parseHttpDate(ifModifiedSince);
    if (since === null) return false;

    // HTTP-date has ONE-SECOND resolution, while `updatedAt` carries
    // milliseconds. Without truncating, a feed last modified at 12:00:00.500
    // is always "newer" than the 12:00:00 the client was sent, and every
    // conditional request 200s forever — the single most common way
    // `If-Modified-Since` is implemented wrongly.
    const modified = Math.floor(feed.lastModified.getTime() / 1000) * 1000;
    return modified <= since;
  }

  return false;
}

/**
 * Applies the caching and content headers every feed response carries —
 * 200 and 304 alike.
 *
 * A 304 MUST repeat the validators and the freshness information, or the client
 * has nothing to store against the copy it just kept and will revalidate
 * unconditionally next time. Content-Type is set on both for the same reason a
 * `Vary` would be: an intermediary should be able to reason about the cached
 * response without having seen the 200 that produced it.
 */
export function applyFeedHeaders(res: Response, feed: RenderedFeed): void {
  res.setHeader('Content-Type', feed.contentType);
  res.setHeader('ETag', feed.etag);
  res.setHeader(
    'Cache-Control',
    `public, max-age=${HTTP_MAX_AGE_SECONDS}, stale-while-revalidate=${HTTP_STALE_WHILE_REVALIDATE_SECONDS}`
  );

  if (feed.lastModified) {
    res.setHeader('Last-Modified', feed.lastModified.toUTCString());
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A single header value, or `null` when absent. Repeated headers are joined
 *  by Express into an array; they are recombined the way the wire format
 *  already allows so a duplicated `If-None-Match` behaves as one list. */
function headerValue(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? raw.join(', ') : raw;
}

/**
 * Weak comparison of an `If-None-Match` list against the current entity tag.
 *
 * `*` matches any existing representation, which for a feed that exists is
 * always a match.
 */
function etagMatches(ifNoneMatch: string, current: string): boolean {
  const list = ifNoneMatch
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (list.includes('*')) return true;

  const target = weaken(current);
  return list.some((entry) => weaken(entry) === target);
}

/** Strips the weakness indicator so `W/"abc"` and `"abc"` compare equal. */
function weaken(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag;
}

/**
 * Parses an HTTP-date into epoch milliseconds, or `null`.
 *
 * `Date.parse` accepts all three formats RFC 9110 requires a recipient to
 * understand (IMF-fixdate, the obsolete RFC 850 form, and asctime) plus a good
 * deal more. Being liberal here is correct — the header comes from clients the
 * platform does not control — and the `null` guard is what stops a garbage
 * value from becoming `NaN` and comparing false-y in a way that accidentally
 * decides the answer.
 */
export function parseHttpDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
