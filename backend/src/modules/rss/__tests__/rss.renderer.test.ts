import { Rss20Renderer, escapeXml, toRfc822 } from '../rss.renderer';
import { RSS_CONTENT_TYPE } from '../rss.config';
import type { SyndicationDocument, SyndicationItem } from '../rss.types';
import { allElementText, elementText, itemBlocks } from './helpers';

/**
 * Serialization, in isolation.
 *
 * No database, no Redis, no HTTP. What is under test is that a document becomes
 * valid RSS 2.0, that every user-controlled string is escaped on the way in, and
 * that the same document always produces the same bytes — the property the ETag
 * depends on.
 */

const renderer = new Rss20Renderer();

const ITEM: SyndicationItem = {
  id: 'urn:narrative:blog:b1',
  title: 'Structural Typing',
  link: 'https://app.test/blog/structural-typing',
  description: 'A short teaser.',
  author: {
    name: 'Grace Hopper',
    username: 'gracehopper',
    profileUrl: 'https://app.test/@gracehopper',
  },
  publishedAt: new Date('2026-03-01T10:30:00Z'),
  updatedAt: new Date('2026-03-02T08:00:00Z'),
  categories: [
    { name: 'Engineering', slug: 'engineering' },
    { name: 'typescript', slug: 'typescript' },
  ],
  enclosure: null,
};

const DOCUMENT: SyndicationDocument = {
  channel: {
    id: 'urn:narrative:feed:global',
    title: 'Narrative',
    description: 'The latest public posts published on Narrative.',
    link: 'https://app.test',
    selfUrl: 'https://app.test/api/v1/rss',
    language: 'en',
    lastBuildDate: new Date('2026-03-02T08:00:00Z'),
    generator: 'Narrative RSS',
  },
  items: [ITEM],
};

const withItems = (...items: SyndicationItem[]): SyndicationDocument => ({
  ...DOCUMENT,
  items,
});

describe('document structure', () => {
  it('emits an RSS 2.0 document with the namespaces its elements need', () => {
    const xml = renderer.render(DOCUMENT);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xml.trimEnd().endsWith('</rss>')).toBe(true);
  });

  it('declares the RSS content type', () => {
    expect(renderer.contentType).toBe(RSS_CONTENT_TYPE);
    expect(renderer.format).toBe('rss2.0');
  });

  it('opens and closes every element it opens', () => {
    const xml = renderer.render(withItems(ITEM, { ...ITEM, id: 'urn:narrative:blog:b2' }));

    for (const tag of ['rss', 'channel', 'title', 'link', 'description', 'guid']) {
      const opens = xml.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
      const closes = xml.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
      expect({ tag, opens, closes }).toEqual({ tag, opens: closes, closes });
    }
  });
});

describe('channel metadata', () => {
  it('carries title, link, description, generator and language', () => {
    const xml = renderer.render(DOCUMENT);
    const channel = xml.slice(0, xml.indexOf('<item>'));

    expect(elementText(channel, 'title')).toBe('Narrative');
    expect(elementText(channel, 'link')).toBe('https://app.test');
    expect(elementText(channel, 'description')).toBe(
      'The latest public posts published on Narrative.'
    );
    expect(elementText(channel, 'generator')).toBe('Narrative RSS');
    expect(elementText(channel, 'language')).toBe('en');
  });

  it('advertises its own URL as rel="self"', () => {
    const xml = renderer.render(DOCUMENT);
    // The `type` attribute is a MEDIA TYPE — no charset parameter, which
    // describes a transfer rather than the resource.
    expect(xml).toContain(
      '<atom:link href="https://app.test/api/v1/rss" rel="self" type="application/rss+xml" />'
    );
  });

  it('carries a stable feed identifier that is not its URL', () => {
    const xml = renderer.render(DOCUMENT);
    expect(elementText(xml, 'atom:id')).toBe('urn:narrative:feed:global');
  });

  it('states lastBuildDate in RFC 822', () => {
    const xml = renderer.render(DOCUMENT);
    expect(elementText(xml, 'lastBuildDate')).toBe('Mon, 02 Mar 2026 08:00:00 GMT');
  });

  it('advertises a polling interval', () => {
    // The cheapest abuse control the module has: a well-behaved reader stops
    // asking more often than there is anything new to receive.
    expect(elementText(renderer.render(DOCUMENT), 'ttl')).toBe('5');
  });

  it('omits language and lastBuildDate rather than inventing them', () => {
    const xml = renderer.render({
      channel: { ...DOCUMENT.channel, language: null, lastBuildDate: null },
      items: [],
    });

    expect(xml).not.toContain('<language>');
    expect(xml).not.toContain('<lastBuildDate>');
    // Still a valid, complete document — an empty feed is a normal state, not
    // an error.
    expect(xml).toContain('</channel>');
    expect(itemBlocks(xml)).toHaveLength(0);
  });
});

describe('item metadata', () => {
  const xml = renderer.render(DOCUMENT);
  const item = itemBlocks(xml)[0] as string;

  it('carries the title, canonical link and description', () => {
    expect(elementText(item, 'title')).toBe('Structural Typing');
    expect(elementText(item, 'link')).toBe('https://app.test/blog/structural-typing');
    expect(elementText(item, 'description')).toBe('A short teaser.');
  });

  it('marks the GUID as a non-permalink identifier', () => {
    // A reader that treated a URN as a URL would try to resolve it.
    expect(item).toContain(
      '<guid isPermaLink="false">urn:narrative:blog:b1</guid>'
    );
  });

  it('states the publication date in RFC 822 and the modification date in ISO', () => {
    expect(elementText(item, 'pubDate')).toBe('Sun, 01 Mar 2026 10:30:00 GMT');
    expect(elementText(item, 'atom:updated')).toBe('2026-03-02T08:00:00.000Z');
  });

  it('names the author through dc:creator and never publishes an address', () => {
    expect(elementText(item, 'dc:creator')).toBe('Grace Hopper');
    // RSS 2.0's own <author> element IS an email address; using it would undo
    // UserSettings.hideEmail for everyone at once.
    expect(item).not.toContain('<author>');
    expect(item).not.toContain('@');
  });

  it('renders every category and tag', () => {
    expect(allElementText(item, 'category')).toEqual(['Engineering', 'typescript']);
  });

  it('omits an empty description rather than emitting a blank element', () => {
    const xml = renderer.render(withItems({ ...ITEM, description: null }));
    expect(itemBlocks(xml)[0]).not.toContain('<description>');
  });

  it('omits pubDate for an item with no publication instant', () => {
    const xml = renderer.render(withItems({ ...ITEM, publishedAt: null }));
    expect(itemBlocks(xml)[0]).not.toContain('<pubDate>');
  });

  it('writes no date at all rather than the string "Invalid Date"', () => {
    const xml = renderer.render(withItems({ ...ITEM, publishedAt: new Date('nonsense') }));
    expect(xml).not.toContain('Invalid Date');
    expect(itemBlocks(xml)[0]).not.toContain('<pubDate>');
  });
});

describe('enclosures', () => {
  it('renders a cover image with its type and length', () => {
    const xml = renderer.render(
      withItems({
        ...ITEM,
        enclosure: {
          url: 'https://cdn.test/cover.jpg',
          mimeType: 'image/jpeg',
          lengthBytes: 12345,
        },
      })
    );

    expect(xml).toContain(
      '<enclosure url="https://cdn.test/cover.jpg" type="image/jpeg" length="12345" />'
    );
  });

  it('stays valid when an item has no image', () => {
    const xml = renderer.render(withItems({ ...ITEM, enclosure: null }));
    expect(xml).not.toContain('<enclosure');
    expect(itemBlocks(xml)).toHaveLength(1);
  });

  it('escapes an enclosure URL, which is an attribute value', () => {
    const xml = renderer.render(
      withItems({
        ...ITEM,
        enclosure: {
          url: 'https://cdn.test/a.jpg?x=1&y="2"',
          mimeType: 'image/jpeg',
          lengthBytes: 1,
        },
      })
    );

    expect(xml).toContain('url="https://cdn.test/a.jpg?x=1&amp;y=&quot;2&quot;"');
    // An unescaped quote here would end the attribute and let the rest of the
    // string become markup.
    expect(xml).not.toContain('y="2""');
  });
});

describe('XML escaping', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('strips characters XML 1.0 forbids outright', () => {
    // A single NUL in a title would make the whole channel unparseable for
    // every subscriber — one post breaking everyone's feed.
    expect(escapeXml('a\u0000b\u0008c\u001Fd')).toBe('abcd');
  });

  it('keeps tab, newline and carriage return, which are legal', () => {
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('drops lone surrogates, which no UTF-8 encoder can represent', () => {
    expect(escapeXml('a\uD800b')).toBe('ab');
    // A well-formed pair is a real character and survives.
    expect(escapeXml('a😀b')).toBe('a😀b');
  });

  it('neutralizes a title that tries to close the element and inject markup', () => {
    const hostile = '</title><script>alert(1)</script><title>';
    const xml = renderer.render(withItems({ ...ITEM, title: hostile }));

    expect(xml).not.toContain('<script>');
    expect(xml).not.toContain('</title><script>');
    expect(elementText(itemBlocks(xml)[0] as string, 'title')).toBe(
      '&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;title&gt;'
    );
  });

  it('neutralizes hostile author names, categories and links', () => {
    const xml = renderer.render(
      withItems({
        ...ITEM,
        author: { ...ITEM.author, name: 'Bobby <b>Tables</b> & Co' },
        categories: [{ name: ']]><!--', slug: 'x' }],
        link: 'https://app.test/blog/a?b=1&c=<2>',
      })
    );

    expect(xml).toContain('Bobby &lt;b&gt;Tables&lt;/b&gt; &amp; Co');
    expect(xml).toContain(']]&gt;&lt;!--');
    expect(xml).toContain('https://app.test/blog/a?b=1&amp;c=&lt;2&gt;');
    // Nothing user-supplied escaped its element.
    expect(xml).not.toContain('<b>');
    expect(xml).not.toContain('<!--');
  });

  it('escapes channel-level strings too, which come from the same tables', () => {
    const xml = renderer.render({
      channel: { ...DOCUMENT.channel, title: 'A & B <feed>' },
      items: [],
    });
    expect(xml).toContain('<title>A &amp; B &lt;feed&gt;</title>');
  });
});

describe('determinism', () => {
  it('renders byte-identical output for the same document', () => {
    // The ETag is a hash of these bytes. Any clock or locale read inside the
    // renderer would mint a new validator on every regeneration and turn HTTP
    // caching off for every subscriber without anything appearing to fail.
    expect(renderer.render(DOCUMENT)).toBe(renderer.render(DOCUMENT));
  });

  it('changes its output when any item changes', () => {
    const changed = renderer.render(withItems({ ...ITEM, title: 'Renamed' }));
    expect(changed).not.toBe(renderer.render(DOCUMENT));
  });
});

describe('toRfc822', () => {
  it('formats an instant the way RSS and HTTP both spell it', () => {
    expect(toRfc822(new Date('2026-03-02T08:00:00Z'))).toBe('Mon, 02 Mar 2026 08:00:00 GMT');
  });

  it('refuses null and invalid dates', () => {
    expect(toRfc822(null)).toBeNull();
    expect(toRfc822(new Date('nope'))).toBeNull();
  });
});
