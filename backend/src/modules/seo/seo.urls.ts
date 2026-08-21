import { env } from '../../core/config/env';
import { appBaseUrl } from '../../core/utils/publicUrls';
import type { SitemapSection } from './seo.types';

/**
 * The URLs of this module's OWN crawler-facing endpoints.
 *
 * Public PAGE URLs — a post, a profile, a category, a tag — are not here. They
 * come from `core/utils/publicUrls`, the platform's single URL vocabulary, for
 * the reason stated in that file: a canonical URL that disagrees with the link
 * in a feed or an email is a duplicate-content bug that nobody can see from
 * inside either module. This file holds only what is genuinely the SEO
 * module's: where its sitemaps and its `robots.txt` are served.
 *
 * ── Why these need a base URL of their own ──────────────────────────────────
 * A sitemap index names its children by ABSOLUTE URL, and `robots.txt` names
 * the sitemap by absolute URL. Both are fetched by a crawler that has never
 * seen this API and cannot be told to resolve a relative reference. Neither can
 * be derived from the request either: `Host` and `X-Forwarded-Host` are
 * attacker-controlled on a public endpoint, and these documents are CACHED — so
 * one spoofed request would redirect every crawler that followed to somebody
 * else's domain.
 *
 * `SEO_SITEMAP_BASE_URL` exists for the deployment where the API is not served
 * under the app's own origin. Unset, it is `APP_URL`, which is correct whenever
 * `/robots.txt` and `/sitemap*.xml` are proxied to the API — the arrangement
 * these root-level routes are designed for.
 */

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/** Where this module's crawler-facing documents are publicly reachable. */
export const sitemapBaseUrl = (): string =>
  trimTrailingSlash(env.SEO_SITEMAP_BASE_URL ?? appBaseUrl());

/** The sitemap index — the one URL `robots.txt` advertises. */
export const sitemapIndexUrl = (): string => `${sitemapBaseUrl()}/sitemap.xml`;

/**
 * One chunk of one section.
 *
 * `/sitemap-blogs-1.xml` — the convention crawlers and every sitemap tool
 * already recognise, and the shape the routes parse back. Pages are 1-based
 * because they appear in a public URL and `sitemap-blogs-0.xml` reads as an
 * off-by-one error to everyone who is not a programmer.
 */
export const sitemapChunkUrl = (section: SitemapSection, page: number): string =>
  `${sitemapBaseUrl()}/sitemap-${section}-${page}.xml`;

export const robotsUrl = (): string => `${sitemapBaseUrl()}/robots.txt`;
