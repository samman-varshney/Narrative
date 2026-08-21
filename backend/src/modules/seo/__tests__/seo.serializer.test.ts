import {
  renderHeadTags,
  renderJsonLd,
  renderSitemapIndex,
  renderUrlSet,
  toW3CDate,
} from '../seo.serializer';
import { seoResolver } from '../seo.resolver';
import {
  allElementText,
  allMetaContent,
  blogSource,
  elementText,
  metaContent,
  overrideEnv,
  urlBlocks,
} from './helpers';
import type { SitemapEntry } from '../seo.types';

/**
 * Serialization, with an emphasis on the one thing that can go catastrophically
 * wrong: an untrusted string becoming markup.
 *
 * The hostile-input cases are the point of this file. Every one of them is a
 * value an author can put in a blog title, a tag name or an SEO override, and
 * every one of them would be a stored-XSS or a broken-document bug if the
 * escaping were applied at the call site rather than by the helpers.
 */

let restore: (() => void)[] = [];

beforeEach(() => {
  restore = [
    overrideEnv('APP_URL', 'https://narrative.test'),
    overrideEnv('SEO_SITE_NAME', 'Narrative'),
    overrideEnv('SEO_INDEXING_ENABLED', 'true'),
    overrideEnv('SEO_DEFAULT_IMAGE', undefined),
  ];
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
});

const entry = (overrides: Partial<SitemapEntry> = {}): SitemapEntry => ({
  loc: 'https://narrative.test/blog/a-post',
  lastmod: new Date('2026-02-01T12:30:45.123Z'),
  changefreq: 'weekly',
  priority: 0.8,
  ...overrides,
});

// ---------------------------------------------------------------------------

describe('urlset documents', () => {
  it('is a valid sitemap 0.9 document', () => {
    const xml = renderUrlSet([entry()]);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('carries loc, lastmod, changefreq and priority', () => {
    const block = urlBlocks(renderUrlSet([entry()]))[0]!;

    expect(elementText(block, 'loc')).toBe('https://narrative.test/blog/a-post');
    expect(elementText(block, 'lastmod')).toBe('2026-02-01T12:30:45Z');
    expect(elementText(block, 'changefreq')).toBe('weekly');
    expect(elementText(block, 'priority')).toBe('0.8');
  });

  it('omits optional elements rather than emitting them empty', () => {
    const block = urlBlocks(
      renderUrlSet([entry({ lastmod: null, changefreq: null, priority: null })])
    )[0]!;

    expect(block).not.toContain('<lastmod>');
    expect(block).not.toContain('<changefreq>');
    expect(block).not.toContain('<priority>');
    expect(elementText(block, 'loc')).toBeTruthy();
  });

  it('omits a lastmod it cannot state truly', () => {
    const block = urlBlocks(renderUrlSet([entry({ lastmod: new Date('nonsense') })]))[0]!;
    expect(block).not.toContain('Invalid Date');
    expect(block).not.toContain('<lastmod>');
  });

  it('renders an empty document rather than failing on no entries', () => {
    expect(urlBlocks(renderUrlSet([]))).toHaveLength(0);
    expect(renderUrlSet([])).toContain('</urlset>');
  });

  it('escapes a URL containing XML metacharacters', () => {
    const xml = renderUrlSet([entry({ loc: 'https://narrative.test/tags/a&b<c>' })]);

    expect(xml).toContain('&amp;');
    expect(xml).not.toMatch(/<loc>[^<]*<c>/);
  });

  it('is deterministic', () => {
    expect(renderUrlSet([entry(), entry()])).toBe(renderUrlSet([entry(), entry()]));
  });
});

describe('sitemap index documents', () => {
  it('is a valid sitemapindex document listing its children', () => {
    const xml = renderSitemapIndex([
      { loc: 'https://narrative.test/sitemap-blogs-1.xml', lastmod: new Date('2026-02-01Z') },
      { loc: 'https://narrative.test/sitemap-tags-1.xml', lastmod: null },
    ]);

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(allElementText(xml, 'loc')).toEqual([
      'https://narrative.test/sitemap-blogs-1.xml',
      'https://narrative.test/sitemap-tags-1.xml',
    ]);
    expect(allElementText(xml, 'lastmod')).toEqual(['2026-02-01T00:00:00Z']);
  });
});

describe('W3C dates', () => {
  it('drops the fractional seconds several validators flag', () => {
    expect(toW3CDate(new Date('2026-02-01T12:30:45.123Z'))).toBe('2026-02-01T12:30:45Z');
  });

  it('returns null for an absent or unusable date', () => {
    expect(toW3CDate(null)).toBeNull();
    expect(toW3CDate(new Date('nonsense'))).toBeNull();
  });
});

describe('JSON-LD serialization', () => {
  // The single most important test in this file.
  it('cannot break out of a script element', () => {
    const json = renderJsonLd([{ '@type': 'BlogPosting', headline: '</script><img src=x onerror=alert(1)>' }]);

    expect(json).not.toContain('</script');
    expect(json).not.toContain('<img');
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(json).toContain('\\u003c');
  });

  it('escapes ampersands and the JavaScript line separators', () => {
    const json = renderJsonLd([{ name: 'a & b c d' }]);

    expect(json).not.toContain('&');
    expect(json).toContain('\\u0026');
    expect(json).toContain('\\u2028');
    expect(json).toContain('\\u2029');
  });

  it('stays valid JSON after escaping', () => {
    const hostile = '</script>&<> ';
    const json = renderJsonLd([{ headline: hostile }]);

    expect(JSON.parse(json)).toEqual({ headline: hostile });
  });

  it('emits a bare object for one node and an array for several', () => {
    expect(JSON.parse(renderJsonLd([{ a: 1 }]))).toEqual({ a: 1 });
    expect(JSON.parse(renderJsonLd([{ a: 1 }, { b: 2 }]))).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('head tags', () => {
  const resolved = () =>
    seoResolver.resolveBlog(
      blogSource({
        title: 'On Compilers',
        subtitle: 'A short tour',
        coverSecureUrl: 'https://cdn.test/cover.jpg',
        categories: [{ name: 'Engineering', slug: 'engineering' }],
        tags: [
          { name: 'TypeScript', slug: 'typescript' },
          { name: 'Postgres', slug: 'postgres' },
        ],
        author: { ...blogSource().author, x: 'https://x.com/gracehopper' },
      })
    );

  it('renders the title, description, canonical and robots directive', () => {
    const html = renderHeadTags(resolved());

    expect(html).toContain('<title>On Compilers — Narrative</title>');
    expect(metaContent(html, 'description')).toBe('A short tour');
    expect(html).toContain(
      '<link rel="canonical" href="https://narrative.test/blog/a-post" />'
    );
    expect(metaContent(html, 'robots')).toBe('index, follow');
  });

  it('renders the Open Graph and article tags', () => {
    const html = renderHeadTags(resolved());

    expect(metaContent(html, 'og:type')).toBe('article');
    expect(metaContent(html, 'og:site_name')).toBe('Narrative');
    expect(metaContent(html, 'og:title')).toBe('On Compilers');
    expect(metaContent(html, 'og:url')).toBe('https://narrative.test/blog/a-post');
    expect(metaContent(html, 'og:image')).toBe('https://cdn.test/cover.jpg');
    expect(metaContent(html, 'article:published_time')).toBe('2026-01-01T00:00:00.000Z');
    expect(metaContent(html, 'article:modified_time')).toBe('2026-02-01T00:00:00.000Z');
    expect(metaContent(html, 'article:author')).toBe('https://narrative.test/@grace');
    expect(metaContent(html, 'article:section')).toBe('Engineering');
    expect(allMetaContent(html, 'article:tag')).toEqual(['TypeScript', 'Postgres']);
  });

  it('renders the Twitter tags', () => {
    const html = renderHeadTags(resolved());

    expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'twitter:title')).toBe('On Compilers');
    expect(metaContent(html, 'twitter:creator')).toBe('@gracehopper');
  });

  it('embeds the structured data as escaped JSON-LD', () => {
    const html = renderHeadTags(resolved());
    const match = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
    );

    expect(match).not.toBeNull();
    expect(() => JSON.parse(match![1] as string)).not.toThrow();
  });

  it('omits tags for values that are absent', () => {
    const html = renderHeadTags(
      seoResolver.resolveAuthor({
        id: 'u',
        username: 'grace',
        name: 'Grace',
        bio: null,
        avatar: null,
        status: 'ACTIVE',
        isPrivate: false,
        x: null,
        socialLinks: [],
        createdAt: new Date('2026-01-01Z'),
        publicPostCount: 1,
        lastPublishedAt: null,
      })
    );

    expect(html).not.toContain('og:image');
    expect(html).not.toContain('twitter:creator');
    expect(metaContent(html, 'profile:username')).toBe('grace');
  });

  // The attribute-injection case: a title carrying a quote.
  it('escapes a hostile title so it cannot escape its attribute', () => {
    const html = renderHeadTags(
      seoResolver.resolveBlog(
        blogSource({ title: 'Hi" onload="alert(1)' })
      )
    );

    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain('&quot;');
    // The quote never terminates its attribute, so the payload stays INSIDE the
    // content value rather than becoming a second attribute on the tag.
    expect(metaContent(html, 'og:title')).toBe('Hi&quot; onload=&quot;alert(1)');
  });

  it('escapes a hostile tag name in an article:tag', () => {
    const html = renderHeadTags(
      seoResolver.resolveBlog(
        blogSource({ tags: [{ name: '"><script>alert(1)</script>', slug: 'x' }] })
      )
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is deterministic', () => {
    expect(renderHeadTags(resolved())).toBe(renderHeadTags(resolved()));
  });
});
