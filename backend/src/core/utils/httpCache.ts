import { createHash } from 'crypto';
import type { Request, Response } from 'express';

/**
 * HTTP cache validation — conditional requests, done once.
 *
 * Written for the RSS feeds and moved here when the SEO module needed the same
 * behaviour for sitemaps and `robots.txt`. Both surfaces are public documents
 * fetched on a timer by software that always sends validators, so both live or
 * die on getting RFC 9110 §13 right — and the two rules that are most often got
 * wrong are the two that a second implementation would get wrong differently:
 *
 *   PRECEDENCE   `If-None-Match` wins whenever it is present. `If-Modified-Since`
 *                is evaluated ONLY in its absence. A client that sends both —
 *                which every serious crawler and feed reader does — must not be
 *                able to get a 200 out of a stale date when its entity tag still
 *                matches.
 *
 *   COMPARISON   Entity tags in `If-None-Match` are compared WEAKLY on GET.
 *                `W/"abc"` and `"abc"` identify the same representation for the
 *                purpose of "have I already got this", and a strict string
 *                comparison would 200 every client behind a proxy that weakened
 *                the tag in transit — silently turning the entire caching layer
 *                off with nothing failing.
 *
 * ── Caching never decides what is IN a representation ───────────────────────
 * Nothing in this file knows what a document contains. A 304 is only ever
 * produced against a validator minted from a document the caller built under
 * its own visibility rules — so a conditional request cannot revive a
 * representation containing something that has since been withdrawn: its
 * removal changed the bytes, and the new ETag no longer matches what the client
 * holds. Revalidation is the mechanism by which a removal REACHES the client,
 * not a way around it.
 */

/** The two validators a cacheable representation carries. */
export interface CacheValidators {
  etag: string;
  lastModified: Date | null;
}

/**
 * Whether the client already holds this exact representation.
 *
 * `false` for anything ambiguous — an unparsable date, a malformed tag list, a
 * representation with no modification instant. Returning a 200 to a client that
 * could have had a 304 wastes bandwidth; returning a 304 to one that could not
 * is a correctness bug that shows up as a client stuck on an old copy forever.
 */
export function isNotModified(req: Request, validators: CacheValidators): boolean {
  const ifNoneMatch = headerValue(req, 'if-none-match');

  if (ifNoneMatch !== null) {
    return etagMatches(ifNoneMatch, validators.etag);
  }

  const ifModifiedSince = headerValue(req, 'if-modified-since');
  if (ifModifiedSince !== null && validators.lastModified) {
    const since = parseHttpDate(ifModifiedSince);
    if (since === null) return false;

    // HTTP-date has ONE-SECOND resolution, while `updatedAt` carries
    // milliseconds. Without truncating, a document last modified at 12:00:00.500
    // is always "newer" than the 12:00:00 the client was sent, and every
    // conditional request 200s forever — the single most common way
    // `If-Modified-Since` is implemented wrongly.
    const modified = Math.floor(validators.lastModified.getTime() / 1000) * 1000;
    return modified <= since;
  }

  return false;
}

/** Everything a cacheable public response declares about itself. */
export interface CacheHeaderOptions extends CacheValidators {
  contentType: string;
  maxAge: number;
  staleWhileRevalidate?: number;
}

/**
 * Applies the caching and content headers a public document carries —
 * 200 and 304 alike.
 *
 * A 304 MUST repeat the validators and the freshness information, or the client
 * has nothing to store against the copy it just kept and will revalidate
 * unconditionally next time. `Content-Type` is set on both for the same reason a
 * `Vary` would be: an intermediary should be able to reason about the cached
 * response without having seen the 200 that produced it.
 *
 * `public` rather than `private`: every caller of this function serves a
 * document that is identical for every requester — no token is read, nothing
 * varies on a viewer — so a CDN or a corporate proxy holding one copy for
 * everybody is correct. That property is what makes it safe, and each caller
 * asserts it in its own tests.
 */
export function applyCacheHeaders(res: Response, options: CacheHeaderOptions): void {
  res.setHeader('Content-Type', options.contentType);
  res.setHeader('ETag', options.etag);

  const directives = [`public`, `max-age=${options.maxAge}`];
  if (options.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  }
  res.setHeader('Cache-Control', directives.join(', '));

  if (options.lastModified) {
    res.setHeader('Last-Modified', options.lastModified.toUTCString());
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
 * `*` matches any existing representation, which for a document that exists is
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

/**
 * A STRONG entity tag over a rendered representation.
 *
 * Hashing the OUTPUT rather than the inputs means the tag automatically
 * accounts for everything that can change the representation — a renderer
 * change, a config change, a different ordering — with no list of ingredients to
 * keep in step. It is only sound because the renderers that feed it are
 * deterministic; each states and tests that property.
 *
 * A `version` is folded in so an upgrade that happens to produce byte-identical
 * output still mints a distinct validator, and no client is told 304 about a
 * representation built under a different contract.
 *
 * Strong rather than weak (`W/`): the bytes really are identical, which is what
 * lets an intermediary serve a range request or a byte-for-byte comparison. The
 * quotes are part of the value, per RFC 9110.
 */
export function entityTag(version: string, body: string): string {
  const digest = createHash('sha256')
    .update(version)
    .update(body)
    .digest('hex')
    .slice(0, 32);
  return `"${digest}"`;
}
