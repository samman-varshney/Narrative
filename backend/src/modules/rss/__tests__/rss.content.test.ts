import { deriveDescription, hasCheapDescription } from '../rss.content';
import { MAX_DESCRIPTION_LENGTH } from '../rss.config';
import { tiptapDoc } from './helpers';

/**
 * Content transformation, in isolation.
 *
 * Two things are under test: that the description precedence matches what the
 * rest of the platform says about a post, and that no source — however hostile
 * or however broken — can produce something other than bounded plain text.
 */

const sources = (over: Partial<Parameters<typeof deriveDescription>[0]> = {}) => ({
  metaDescription: null,
  subtitle: null,
  ...over,
});

describe('precedence', () => {
  it('prefers the author-authored SEO description', () => {
    // The same order `blogService.effectiveSeo` applies, so a feed and an Open
    // Graph card cannot disagree about how a post is summarized.
    const result = deriveDescription(
      sources({
        metaDescription: 'The SEO summary',
        subtitle: 'The subtitle',
        content: tiptapDoc('The body'),
      })
    );
    expect(result).toBe('The SEO summary');
  });

  it('falls back to the subtitle', () => {
    const result = deriveDescription(
      sources({ subtitle: 'The subtitle', content: tiptapDoc('The body') })
    );
    expect(result).toBe('The subtitle');
  });

  it('falls back to the body last', () => {
    expect(deriveDescription(sources({ content: tiptapDoc('The body') }))).toBe('The body');
  });

  it('returns null when there is genuinely nothing to say', () => {
    // So the renderer can omit the element rather than emit a blank one.
    expect(deriveDescription(sources())).toBeNull();
    expect(deriveDescription(sources({ metaDescription: '   ', subtitle: '' }))).toBeNull();
  });
});

describe('hasCheapDescription', () => {
  it('tells the service which rows need their body loaded', () => {
    // This is what keeps a feed from transferring a page of rich-text documents
    // to build a page of two-line summaries.
    expect(hasCheapDescription({ metaDescription: 'x', subtitle: null })).toBe(true);
    expect(hasCheapDescription({ metaDescription: null, subtitle: 'x' })).toBe(true);
    expect(hasCheapDescription({ metaDescription: null, subtitle: null })).toBe(false);
  });

  it('treats whitespace-only values as absent, exactly as the derivation does', () => {
    // If these two disagreed, a post would either lose its description or pay
    // for a body query it did not need.
    expect(hasCheapDescription({ metaDescription: '  ', subtitle: '\n' })).toBe(false);
    expect(deriveDescription(sources({ metaDescription: '  ', subtitle: '\n' }))).toBeNull();
  });
});

describe('sanitization', () => {
  it('strips markup from a subtitle, which is stored raw', () => {
    // `blog.validator.ts` bounds a subtitle's length and nothing else, so an
    // author can put anything in it.
    const result = deriveDescription(
      sources({ subtitle: 'Hello <b>world</b><script>alert(1)</script>' })
    );
    expect(result).toBe('Hello world');
  });

  it('drops the contents of script and style elements, not just the tags', () => {
    const result = deriveDescription(
      sources({ metaDescription: 'before<script>alert(1)</script>after' })
    );
    expect(result).toBe('beforeafter');
    expect(result).not.toContain('alert');
  });

  it('collapses newlines and tabs so an item cannot reproduce a page layout', () => {
    expect(deriveDescription(sources({ subtitle: 'a\n\n\tb   c' }))).toBe('a b c');
  });

  it('leaves nothing that could close an XML element', () => {
    const result = deriveDescription(sources({ subtitle: ']]></description><item>' }));
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });
});

describe('bounding', () => {
  it('never exceeds the configured maximum', () => {
    const long = 'word '.repeat(500);
    const result = deriveDescription(sources({ subtitle: long }))!;
    expect(result.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  it('cuts at a word boundary and marks the truncation', () => {
    const result = deriveDescription(sources({ subtitle: 'alpha '.repeat(200) }))!;
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toMatch(/alph…$/);
  });

  it('hard-cuts text with no usable word boundary rather than returning it whole', () => {
    const unbroken = 'x'.repeat(MAX_DESCRIPTION_LENGTH * 2);
    const result = deriveDescription(sources({ subtitle: unbroken }))!;
    expect(result.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
  });

  it('leaves short text untouched, with no ellipsis', () => {
    expect(deriveDescription(sources({ subtitle: 'Short.' }))).toBe('Short.');
  });
});

describe('malformed content', () => {
  it.each([
    ['null', null],
    ['a string', 'not a document' as unknown],
    ['a number', 42 as unknown],
    ['an array', [] as unknown],
    ['an empty object', {} as unknown],
    ['a doc with no content array', { type: 'doc' } as unknown],
    ['a doc with a null child', { type: 'doc', content: [null] } as unknown],
  ])('degrades to no description for %s', (_label, content) => {
    // One unparseable body must cost that item its description and nothing
    // more — never the feed. `rss.service` catches at the item level too, but
    // the cheaper guard is here.
    expect(() => deriveDescription(sources({ content }))).not.toThrow();
    expect(deriveDescription(sources({ content }))).toBeNull();
  });

  it('survives a parser that throws outright', () => {
    const exploding = {
      get type() {
        throw new Error('corrupt document');
      },
    };
    expect(deriveDescription(sources({ content: exploding }))).toBeNull();
  });
});
