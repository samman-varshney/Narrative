import { PUBLIC_PATHS } from '../../core/utils/publicUrls';
import {
  ROBOTS_CRAWL_DELAY,
  ROBOTS_DISALLOWED_PATHS,
  indexingEnabled,
  siteName,
} from './seo.config';
import { sitemapIndexUrl } from './seo.urls';

/**
 * `robots.txt` generation.
 *
 * Deterministic and dependency-free: the document is a function of
 * configuration alone, so it is the same bytes for every requester and can be
 * cached, ETagged and served from Redis like any other public document.
 *
 * ── This is a crawling hint, not access control ─────────────────────────────
 * Nothing is protected BY being listed here. Every disallowed path is gated by
 * `requireAuth` and, where relevant, by a permission check — `robots.txt` only
 * asks well-behaved crawlers not to spend their budget there. That distinction
 * matters in the other direction too: listing a genuinely secret path would
 * PUBLISH its existence to anyone who reads the file, which is why the list in
 * `seo.config` contains only surfaces that are already obvious.
 *
 * ── The two documents ───────────────────────────────────────────────────────
 * When indexing is disabled — a staging or preview deployment, or an explicit
 * `SEO_INDEXING_ENABLED=false` — the whole site is disallowed and the sitemap
 * is NOT advertised. Pointing a crawler at a sitemap while asking it not to
 * crawl is a contradiction, and the sitemap is exactly the document that would
 * help it ignore the request. The metadata layer resolves to `noindex` in the
 * same breath (see `seo.indexability.robotsDirective`), so a deployment cannot
 * end up half-indexable.
 */

/**
 * The public path prefixes that must never be disallowed.
 *
 * Not used to BUILD the document — it is built from the disallow list — but
 * exported so a test can assert the two lists cannot overlap. Accidentally
 * blocking the platform's own content is the failure mode this file is most
 * likely to produce, and it is one that would go unnoticed until traffic
 * disappeared.
 */
export const PUBLIC_CRAWLABLE_PATHS = [
  PUBLIC_PATHS.home(),
  PUBLIC_PATHS.blog('example'),
  PUBLIC_PATHS.author('example'),
  PUBLIC_PATHS.category('example'),
  PUBLIC_PATHS.tag('example'),
];

/**
 * Renders `robots.txt`.
 *
 * One `User-agent: *` group. Per-crawler groups are deliberately absent: the
 * platform has no rule it wants to apply to one crawler and not another, and a
 * file with several groups is one where a later group silently overrides an
 * earlier one for the agent it names.
 */
export function renderRobotsTxt(): string {
  const lines: string[] = [`# ${siteName()}`];

  if (!indexingEnabled()) {
    lines.push(
      '# Indexing is disabled for this deployment.',
      '',
      'User-agent: *',
      'Disallow: /',
      ''
    );
    return lines.join('\n');
  }

  lines.push('', 'User-agent: *');

  for (const path of ROBOTS_DISALLOWED_PATHS) {
    lines.push(`Disallow: ${path}`);
  }

  // An explicit `Allow: /` after the disallow list. Redundant by the standard's
  // longest-match rule, and included because it makes the file's intent legible
  // to a human reading it: everything not listed above is fair game.
  lines.push('Allow: /');

  if (ROBOTS_CRAWL_DELAY !== null) {
    lines.push(`Crawl-delay: ${ROBOTS_CRAWL_DELAY}`);
  }

  lines.push('', `Sitemap: ${sitemapIndexUrl()}`, '');
  return lines.join('\n');
}
