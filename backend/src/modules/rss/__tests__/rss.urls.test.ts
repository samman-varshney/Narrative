import { env } from '../../../core/config/env';
import { DEFAULT_ITEM_COUNT } from '../rss.config';
import {
  absolutePublicUrl,
  appBaseUrl,
  authorUrl,
  blogGuid,
  blogUrl,
  categoryUrl,
  channelId,
  feedSelfUrl,
  safeHttpUrl,
  selfBaseUrl,
  tagUrl,
} from '../rss.urls';

/**
 * URL and identifier construction.
 *
 * Two things matter here beyond correctness of the strings: that every URL is
 * built from CONFIGURATION rather than from a request, and that an identifier
 * survives the mutations a post can undergo.
 */

const original = { appUrl: env.APP_URL, selfBase: env.RSS_SELF_BASE_URL };

afterEach(() => {
  (env as { APP_URL: string }).APP_URL = original.appUrl;
  (env as { RSS_SELF_BASE_URL?: string }).RSS_SELF_BASE_URL = original.selfBase;
});

const setAppUrl = (value: string) => {
  (env as { APP_URL: string }).APP_URL = value;
};

describe('base URLs', () => {
  it('reads the configured application URL', () => {
    setAppUrl('https://narrative.test');
    expect(appBaseUrl()).toBe('https://narrative.test');
  });

  it('tolerates a trailing slash in configuration', () => {
    setAppUrl('https://narrative.test/');
    expect(appBaseUrl()).toBe('https://narrative.test');
    expect(blogUrl('a-post')).toBe('https://narrative.test/blog/a-post');
  });

  it('defaults the self URL to the API path under the application URL', () => {
    setAppUrl('https://narrative.test');
    (env as { RSS_SELF_BASE_URL?: string }).RSS_SELF_BASE_URL = undefined;
    expect(selfBaseUrl()).toBe('https://narrative.test/api/v1/rss');
  });

  it('honours an explicit self URL for split-origin deployments', () => {
    (env as { RSS_SELF_BASE_URL?: string }).RSS_SELF_BASE_URL = 'https://api.narrative.test/rss/';
    expect(selfBaseUrl()).toBe('https://api.narrative.test/rss');
  });
});

describe('public application URLs', () => {
  beforeEach(() => setAppUrl('https://narrative.test'));

  it('matches the link shapes the platform already sends in email', () => {
    // `notification/templates` has been building these since that module
    // shipped. RSS must not invent a second answer to "where does this live".
    expect(blogUrl('structural-typing')).toBe('https://narrative.test/blog/structural-typing');
    expect(authorUrl('gracehopper')).toBe('https://narrative.test/@gracehopper');
  });

  it('builds taxonomy URLs', () => {
    expect(categoryUrl('engineering')).toBe('https://narrative.test/categories/engineering');
    expect(tagUrl('typescript')).toBe('https://narrative.test/tags/typescript');
  });

  it('percent-encodes a segment that could otherwise change the path', () => {
    expect(blogUrl('../../admin')).toBe('https://narrative.test/blog/..%2F..%2Fadmin');
    expect(tagUrl('a b&c')).toBe('https://narrative.test/tags/a%20b%26c');
  });
});

describe('feed self URLs', () => {
  beforeEach(() => {
    setAppUrl('https://narrative.test');
    (env as { RSS_SELF_BASE_URL?: string }).RSS_SELF_BASE_URL = undefined;
  });

  it('addresses each feed type', () => {
    expect(feedSelfUrl('global')).toBe('https://narrative.test/api/v1/rss');
    expect(feedSelfUrl('author', 'gracehopper')).toBe(
      'https://narrative.test/api/v1/rss/authors/gracehopper'
    );
    expect(feedSelfUrl('category', 'engineering')).toBe(
      'https://narrative.test/api/v1/rss/categories/engineering'
    );
    expect(feedSelfUrl('tag', 'typescript')).toBe(
      'https://narrative.test/api/v1/rss/tags/typescript'
    );
  });

  it('omits the default limit so the ordinary subscription URL stays clean', () => {
    expect(feedSelfUrl('global', undefined, DEFAULT_ITEM_COUNT)).toBe(
      'https://narrative.test/api/v1/rss'
    );
  });

  it('states a non-default limit, because it identifies a different document', () => {
    expect(feedSelfUrl('global', undefined, 50)).toBe(
      'https://narrative.test/api/v1/rss?limit=50'
    );
  });
});

describe('identifiers', () => {
  it('identifies a post by its immutable row id', () => {
    expect(blogGuid('clx123')).toBe('urn:narrative:blog:clx123');
  });

  it('keeps a GUID stable across every mutable field', () => {
    // The property the whole scheme exists for: retitling a post re-slugs it,
    // and a URL-based GUID would resurface it in every subscriber's unread list
    // while leaving the original behind as a permanent duplicate.
    const before = blogGuid('clx123');
    setAppUrl('https://moved.test');
    expect(blogGuid('clx123')).toBe(before);
    expect(blogUrl('old-slug')).not.toBe(blogUrl('new-slug'));
  });

  it('identifies a channel by its subject id, not its slug', () => {
    expect(channelId('global', null)).toBe('urn:narrative:feed:global');
    expect(channelId('tag', 'tag-1')).toBe('urn:narrative:feed:tag:tag-1');
    // A category renamed from web-dev to web-development is the same channel;
    // a subscriber should not be asked to resubscribe.
    expect(channelId('category', 'cat-1')).toBe('urn:narrative:feed:category:cat-1');
  });

  it('keeps identifiers distinct across scopes that share a subject id', () => {
    expect(channelId('tag', 'x')).not.toBe(channelId('category', 'x'));
  });
});

describe('safeHttpUrl', () => {
  it('accepts ordinary web addresses', () => {
    expect(safeHttpUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHttpUrl('http://example.com/a')).toBe('http://example.com/a');
  });

  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
  ])('refuses %s', (hostile) => {
    // `BlogSEO.canonicalUrl` is author-supplied and validated only as a
    // well-formed URL — and every one of these IS well formed to a URL parser.
    // Several desktop feed readers will happily activate such an href.
    expect(safeHttpUrl(hostile)).toBeNull();
  });

  it('refuses relative and malformed values', () => {
    expect(safeHttpUrl('/blog/a')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe('absolutePublicUrl', () => {
  beforeEach(() => setAppUrl('https://narrative.test'));

  it('passes through an absolute CDN URL, which is what Cloudinary stores', () => {
    expect(absolutePublicUrl('https://res.cloudinary.com/x/image/a.jpg')).toBe(
      'https://res.cloudinary.com/x/image/a.jpg'
    );
  });

  it('resolves the root-relative path the local provider stores', () => {
    // A relative URL in a syndication document is resolved by the reader
    // against nothing useful.
    expect(absolutePublicUrl('/uploads/covers/a.jpg')).toBe(
      'https://narrative.test/uploads/covers/a.jpg'
    );
  });

  it('refuses a protocol-relative reference to another origin', () => {
    expect(absolutePublicUrl('//evil.test/a.jpg')).toBeNull();
  });

  it('refuses anything that is not a platform path or a web address', () => {
    // A bare storage `publicId` reaching here would otherwise be published as
    // an internal path.
    expect(absolutePublicUrl('covers/1700000000-secret.jpg')).toBeNull();
    expect(absolutePublicUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(absolutePublicUrl(null)).toBeNull();
  });
});
