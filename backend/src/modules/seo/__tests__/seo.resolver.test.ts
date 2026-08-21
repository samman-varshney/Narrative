import { seoResolver } from '../seo.resolver';
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from '../seo.config';
import {
  authorSource,
  blogSource,
  overrideEnv,
  termSource,
  tiptapDoc,
  withIndexing,
} from './helpers';

/**
 * Metadata resolution, tested as the pure function it is.
 *
 * No database, no Redis, no HTTP — every case here is a literal source object
 * and an assertion about what the module decided. That is the whole reason the
 * resolver performs no I/O: the precedence rules are the module's product, and
 * they should be readable as a table of inputs and outputs.
 */

const APP_URL = 'https://narrative.test';

let restore: (() => void)[] = [];

beforeEach(() => {
  restore = [
    overrideEnv('APP_URL', APP_URL),
    overrideEnv('SEO_SITE_NAME', 'Narrative'),
    overrideEnv('SEO_DEFAULT_TITLE', 'Narrative'),
    overrideEnv('SEO_DEFAULT_DESCRIPTION', 'A place to write.'),
    overrideEnv('SEO_DEFAULT_IMAGE', 'https://cdn.test/default.png'),
    overrideEnv('SEO_TWITTER_SITE', '@narrative'),
    overrideEnv('SEO_INDEXING_ENABLED', 'true'),
  ];
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
});

// ---------------------------------------------------------------------------

describe('title precedence', () => {
  it('appends the site name to a derived title', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ title: 'On Compilers' }));
    expect(resolved.title).toBe('On Compilers — Narrative');
  });

  it('uses an explicit meta title verbatim — an override is an override', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ title: 'On Compilers', seo: seo({ metaTitle: 'Compilers, Explained' }) })
    );
    expect(resolved.title).toBe('Compilers, Explained');
  });

  it('bounds a generated title that would exceed the limit', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ title: 'word '.repeat(60) }));
    expect(resolved.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });

  it('treats an override that sanitizes to nothing as absent', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ title: 'Real Title', seo: seo({ metaTitle: '<span></span>' }) })
    );
    expect(resolved.title).toBe('Real Title — Narrative');
  });
});

describe('description precedence', () => {
  it('prefers the author-written meta description', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({
        subtitle: 'the subtitle',
        seo: seo({ metaDescription: 'the summary' }),
      }),
      tiptapDoc('the body')
    );
    expect(resolved.description).toBe('the summary');
  });

  it('falls back to the subtitle', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ subtitle: 'the subtitle' }),
      tiptapDoc('the body')
    );
    expect(resolved.description).toBe('the subtitle');
  });

  it('falls back to a body excerpt', () => {
    const resolved = seoResolver.resolveBlog(blogSource(), tiptapDoc('the body text'));
    expect(resolved.description).toBe('the body text');
  });

  it('generates a true sentence when there is nothing at all, never the site tagline', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ title: 'Untitled Thoughts' }));

    expect(resolved.description).toBe(
      'Untitled Thoughts — a post by Grace Hopper on Narrative.'
    );
    expect(resolved.description).not.toBe('A place to write.');
  });

  it('bounds a derived description', () => {
    const resolved = seoResolver.resolveBlog(blogSource(), tiptapDoc('word '.repeat(300)));
    expect(resolved.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  it('survives a malformed editor document rather than throwing', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ title: 'Still Fine' }), {
      not: 'a document',
    });
    expect(resolved.description).toContain('Still Fine');
  });
});

describe('canonical URLs', () => {
  it('is built from the configured public URL, never a request header', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ slug: 'a-post' }));
    expect(resolved.canonicalUrl).toBe(`${APP_URL}/blog/a-post`);
  });

  it('honours an author-declared canonical — that is what the field is for', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ seo: seo({ canonicalUrl: 'https://elsewhere.test/original' }) })
    );
    expect(resolved.canonicalUrl).toBe('https://elsewhere.test/original');
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox'],
    ['not a url at all'],
  ])('refuses a non-http canonical (%s) and falls back to the derived one', (hostile) => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ slug: 'a-post', seo: seo({ canonicalUrl: hostile }) })
    );
    expect(resolved.canonicalUrl).toBe(`${APP_URL}/blog/a-post`);
  });

  it('uses one spelling of the home page — no trailing slash', () => {
    expect(seoResolver.resolveSite().canonicalUrl).toBe(APP_URL);
  });

  it.each([
    ['author', () => seoResolver.resolveAuthor(authorSource()), `${APP_URL}/@grace`],
    [
      'category',
      () => seoResolver.resolveTerm('category', termSource({ slug: 'engineering' })),
      `${APP_URL}/categories/engineering`,
    ],
    [
      'tag',
      () => seoResolver.resolveTerm('tag', termSource({ slug: 'typescript' })),
      `${APP_URL}/tags/typescript`,
    ],
  ])('builds the %s canonical from the shared URL vocabulary', (_kind, resolve, expected) => {
    expect(resolve().canonicalUrl).toBe(expected);
  });

  it('agrees with the Open Graph url — they are the same value', () => {
    const resolved = seoResolver.resolveBlog(blogSource());
    expect(resolved.openGraph.url).toBe(resolved.canonicalUrl);
  });
});

describe('Open Graph', () => {
  it('describes a post as an article, with its dates and author', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({
        categories: [{ name: 'Engineering', slug: 'engineering' }],
        tags: [
          { name: 'TypeScript', slug: 'typescript' },
          { name: 'Postgres', slug: 'postgres' },
        ],
      })
    );

    expect(resolved.openGraph).toMatchObject({
      type: 'article',
      siteName: 'Narrative',
      article: {
        publishedTime: '2026-01-01T00:00:00.000Z',
        modifiedTime: '2026-02-01T00:00:00.000Z',
        author: `${APP_URL}/@grace`,
        section: 'Engineering',
        tags: ['TypeScript', 'Postgres'],
      },
    });
  });

  it('leaves the site name out of og:title — og:site_name already carries it', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ title: 'On Compilers' }));
    expect(resolved.title).toBe('On Compilers — Narrative');
    expect(resolved.openGraph.title).toBe('On Compilers');
  });

  it('describes a profile as a profile', () => {
    const resolved = seoResolver.resolveAuthor(authorSource());
    expect(resolved.openGraph).toMatchObject({
      type: 'profile',
      profile: { username: 'grace' },
    });
    expect(resolved.openGraph.article).toBeUndefined();
  });

  it('describes a term page as a website, not an article', () => {
    expect(seoResolver.resolveTerm('tag', termSource()).openGraph.type).toBe('website');
  });

  describe('images', () => {
    it('prefers an explicit og:image', () => {
      const resolved = seoResolver.resolveBlog(
        blogSource({
          coverSecureUrl: 'https://cdn.test/cover.jpg',
          seo: seo({ ogImage: 'https://cdn.test/explicit.png' }),
        })
      );
      expect(resolved.openGraph.image).toBe('https://cdn.test/explicit.png');
    });

    it('falls back to the cover, then to the site default', () => {
      expect(
        seoResolver.resolveBlog(blogSource({ coverSecureUrl: 'https://cdn.test/cover.jpg' }))
          .openGraph.image
      ).toBe('https://cdn.test/cover.jpg');

      expect(seoResolver.resolveBlog(blogSource()).openGraph.image).toBe(
        'https://cdn.test/default.png'
      );
    });

    it('resolves a root-relative media path against the public URL', () => {
      const resolved = seoResolver.resolveBlog(
        blogSource({ coverImage: '/uploads/cover.jpg' })
      );
      expect(resolved.openGraph.image).toBe(`${APP_URL}/uploads/cover.jpg`);
    });

    it.each([
      ['a bare storage id', 'covers/internal-public-id'],
      ['a protocol-relative reference', '//evil.test/cover.jpg'],
      ['a data URI', 'data:image/png;base64,AAAA'],
    ])('refuses %s rather than publishing it', (_label, value) => {
      const resolved = seoResolver.resolveBlog(blogSource({ coverImage: value }));
      expect(resolved.openGraph.image).toBe('https://cdn.test/default.png');
    });

    it('stays valid with no image available anywhere', () => {
      const undo = overrideEnv('SEO_DEFAULT_IMAGE', undefined);
      try {
        const resolved = seoResolver.resolveBlog(blogSource());
        expect(resolved.openGraph.image).toBeNull();
        expect(resolved.title).toBeTruthy();
      } finally {
        undo();
      }
    });
  });
});

describe('Twitter cards', () => {
  it('uses a large card when there is an image and a summary when there is not', () => {
    expect(seoResolver.resolveBlog(blogSource()).twitter.card).toBe('summary_large_image');

    const undo = overrideEnv('SEO_DEFAULT_IMAGE', undefined);
    try {
      expect(seoResolver.resolveBlog(blogSource()).twitter.card).toBe('summary');
    } finally {
      undo();
    }
  });

  it('honours an explicit card type', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ seo: seo({ twitterCard: 'summary' }) })
    );
    expect(resolved.twitter.card).toBe('summary');
  });

  it('ignores an unrecognised card type rather than emitting it', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ seo: seo({ twitterCard: 'player" onload="alert(1)' }) })
    );
    expect(resolved.twitter.card).toBe('summary_large_image');
  });

  it("carries the platform's own handle", () => {
    expect(seoResolver.resolveBlog(blogSource()).twitter.site).toBe('@narrative');
  });

  describe('creator', () => {
    it.each([
      ['https://x.com/gracehopper', '@gracehopper'],
      ['https://twitter.com/gracehopper', '@gracehopper'],
      ['https://www.x.com/gracehopper', '@gracehopper'],
      ['https://x.com/@gracehopper', '@gracehopper'],
    ])('derives a handle from %s', (url, expected) => {
      const blog = blogSource({ author: { ...blogSource().author, x: url } });
      expect(seoResolver.resolveBlog(blog).twitter.creator).toBe(expected);
    });

    // The impersonation guard: attributing a post to an arbitrary account.
    it.each([
      ['another host', 'https://evil.test/realcompany'],
      ['a lookalike host', 'https://x.com.evil.test/victim'],
      ['a non-handle path', 'https://x.com/i/status/1234567890'],
      ['an over-long handle', 'https://x.com/aaaaaaaaaaaaaaaaaaaaaaa'],
      ['a hostile scheme', 'javascript:alert(1)'],
      ['not a URL', 'gracehopper'],
    ])('refuses to derive one from %s', (_label, url) => {
      const blog = blogSource({ author: { ...blogSource().author, x: url } });
      expect(seoResolver.resolveBlog(blog).twitter.creator).toBeNull();
    });
  });
});

describe('robots directives on resolved metadata', () => {
  it('marks a public post indexable', () => {
    expect(seoResolver.resolveBlog(blogSource()).robots.directive).toBe('index, follow');
  });

  it('marks an unlisted post noindex, follow', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ visibility: 'UNLISTED' }));
    expect(resolved.robots.directive).toBe('noindex, follow');
  });

  it("marks a suspended author's post noindex", () => {
    const blog = blogSource({ author: { ...blogSource().author, status: 'SUSPENDED' } });
    expect(seoResolver.resolveBlog(blog).robots.index).toBe(false);
  });

  it('marks a private profile noindex', () => {
    expect(seoResolver.resolveAuthor(authorSource({ isPrivate: true })).robots.index).toBe(false);
  });

  it('marks an empty term page noindex', () => {
    const resolved = seoResolver.resolveTerm('tag', termSource({ publicPostCount: 0 }));
    expect(resolved.robots.index).toBe(false);
  });

  it('marks everything noindex when the deployment disables indexing', async () => {
    await withIndexing(false, () => {
      expect(seoResolver.resolveBlog(blogSource()).robots.directive).toBe('noindex, nofollow');
      expect(seoResolver.resolveSite().robots.directive).toBe('noindex, nofollow');
      expect(seoResolver.resolveAuthor(authorSource()).robots.directive).toBe(
        'noindex, nofollow'
      );
    });
  });
});

describe('private profiles withhold what isPrivate hides', () => {
  it('publishes neither the bio nor the avatar nor the external links', () => {
    const resolved = seoResolver.resolveAuthor(
      authorSource({
        isPrivate: true,
        bio: 'A private biography',
        avatar: 'https://cdn.test/avatar.png',
        x: 'https://x.com/grace',
        socialLinks: ['https://github.com/grace'],
      })
    );

    expect(resolved.description).not.toContain('private biography');
    expect(resolved.openGraph.image).toBeNull();
    expect(resolved.twitter.creator).toBeNull();
    expect(JSON.stringify(resolved.structuredData)).not.toContain('github.com/grace');
  });
});

describe('structured data', () => {
  it('describes a post as a BlogPosting with only what is known', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({
        title: 'On Compilers',
        categories: [{ name: 'Engineering', slug: 'engineering' }],
        tags: [{ name: 'TypeScript', slug: 'typescript' }],
      })
    );

    const posting = resolved.structuredData.find((n) => n['@type'] === 'BlogPosting')!;
    expect(posting).toMatchObject({
      '@context': 'https://schema.org',
      headline: 'On Compilers',
      url: `${APP_URL}/blog/a-post`,
      mainEntityOfPage: { '@type': 'WebPage', '@id': `${APP_URL}/blog/a-post` },
      datePublished: '2026-01-01T00:00:00.000Z',
      dateModified: '2026-02-01T00:00:00.000Z',
      author: { '@type': 'Person', name: 'Grace Hopper', url: `${APP_URL}/@grace` },
      publisher: { '@type': 'Organization', name: 'Narrative' },
      articleSection: 'Engineering',
      keywords: ['TypeScript'],
    });
  });

  it('omits absent properties rather than claiming null', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ publishedAt: null }));
    const posting = resolved.structuredData.find((n) => n['@type'] === 'BlogPosting')!;

    expect(posting).not.toHaveProperty('datePublished');
    expect(JSON.stringify(posting)).not.toContain('null');
  });

  it('bounds a headline that exceeds what consumers accept', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ title: 'word '.repeat(80) }));
    const posting = resolved.structuredData.find((n) => n['@type'] === 'BlogPosting')!;
    expect((posting.headline as string).length).toBeLessThanOrEqual(110);
  });

  it('describes a profile as a ProfilePage carrying a Person', () => {
    const resolved = seoResolver.resolveAuthor(
      authorSource({ bio: 'Compiler pioneer', socialLinks: ['https://github.com/grace'] })
    );
    const page = resolved.structuredData.find((n) => n['@type'] === 'ProfilePage')!;

    expect(page).toMatchObject({
      url: `${APP_URL}/@grace`,
      mainEntity: {
        '@type': 'Person',
        name: 'Grace Hopper',
        description: 'Compiler pioneer',
        sameAs: ['https://github.com/grace'],
      },
    });
  });

  it('scheme-checks every sameAs link', () => {
    const resolved = seoResolver.resolveAuthor(
      authorSource({ socialLinks: ['javascript:alert(1)', 'https://github.com/grace', null] })
    );
    const page = resolved.structuredData.find((n) => n['@type'] === 'ProfilePage')!;
    const person = page.mainEntity as Record<string, unknown>;

    expect(person.sameAs).toEqual(['https://github.com/grace']);
  });

  it('describes a term page as a CollectionPage', () => {
    const resolved = seoResolver.resolveTerm('category', termSource({ name: 'Engineering' }));
    expect(resolved.structuredData.find((n) => n['@type'] === 'CollectionPage')).toMatchObject({
      name: 'Engineering',
    });
  });

  it('describes the home page as a WebSite', () => {
    expect(seoResolver.resolveSite().structuredData[0]).toMatchObject({
      '@type': 'WebSite',
      name: 'Narrative',
      url: APP_URL,
    });
  });

  it('claims no sitelinks search box — the platform has no public search page', () => {
    expect(JSON.stringify(seoResolver.resolveSite())).not.toContain('SearchAction');
  });
});

describe('breadcrumbs', () => {
  it('runs Home → Category → Post for a categorised post', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({
        title: 'On Compilers',
        categories: [{ name: 'Engineering', slug: 'engineering' }],
      })
    );

    expect(resolved.breadcrumbs).toEqual([
      { name: 'Home', url: APP_URL },
      { name: 'Engineering', url: `${APP_URL}/categories/engineering` },
      { name: 'On Compilers', url: `${APP_URL}/blog/a-post` },
    ]);
  });

  it('omits the category step for a post that has none — no invented hierarchy', () => {
    const resolved = seoResolver.resolveBlog(blogSource({ title: 'On Compilers' }));
    expect(resolved.breadcrumbs.map((b) => b.name)).toEqual(['Home', 'On Compilers']);
  });

  it('emits a BreadcrumbList with 1-based positions', () => {
    const resolved = seoResolver.resolveBlog(blogSource());
    const list = resolved.structuredData.find((n) => n['@type'] === 'BreadcrumbList')!;
    const items = list.itemListElement as Record<string, unknown>[];

    expect(items.map((i) => i.position)).toEqual([1, 2]);
  });

  it('emits no breadcrumb node for the home page — one step is not a hierarchy', () => {
    const resolved = seoResolver.resolveSite();
    expect(resolved.breadcrumbs).toEqual([]);
    expect(resolved.structuredData.some((n) => n['@type'] === 'BreadcrumbList')).toBe(false);
  });
});

describe('sanitization of user-controlled overrides', () => {
  it('strips markup from every override before it can reach a document', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({
        seo: seo({
          metaTitle: '<script>alert(1)</script>Title',
          metaDescription: '<img src=x onerror=alert(1)>Description',
          ogTitle: '<b>OG</b> Title',
          ogDescription: '<i>OG</i> Description',
        }),
      })
    );

    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain('<script');
    expect(serialized).not.toContain('onerror');
    expect(resolved.title).toBe('Title');
    expect(resolved.openGraph.title).toBe('OG Title');
  });

  it('collapses whitespace so a multi-line override cannot reproduce layout', () => {
    const resolved = seoResolver.resolveBlog(
      blogSource({ seo: seo({ metaDescription: 'one\n\ttwo   three' }) })
    );
    expect(resolved.description).toBe('one two three');
  });

  it('is deterministic — the same source resolves to the same metadata', () => {
    const source = blogSource({ tags: [{ name: 'TypeScript', slug: 'typescript' }] });
    expect(JSON.stringify(seoResolver.resolveBlog(source))).toBe(
      JSON.stringify(seoResolver.resolveBlog(source))
    );
  });
});

describe('nothing internal reaches the output', () => {
  it.each([['status'], ['visibility'], ['isHidden'], ['authorId'], ['blog-1']])(
    'never exposes %s',
    (field) => {
      const resolved = seoResolver.resolveBlog(
        blogSource({ status: 'PUBLISHED', visibility: 'PUBLIC' })
      );
      expect(JSON.stringify(resolved)).not.toContain(field);
    }
  );
});

/** A complete override row with everything null except what a test sets. */
function seo(overrides: Partial<NonNullable<ReturnType<typeof blogSource>['seo']>>) {
  return {
    metaTitle: null,
    metaDescription: null,
    canonicalUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    twitterCard: null,
    ...overrides,
  };
}
