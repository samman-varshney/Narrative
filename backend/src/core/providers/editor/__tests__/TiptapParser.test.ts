import { TiptapParser } from '../TiptapParser';

const parser = new TiptapParser();

const doc = (content: any[]) => ({ type: 'doc', content });
const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const heading = (value: string) => ({ type: 'heading', attrs: { level: 2 }, content: [text(value)] });
const image = () => ({ type: 'image', attrs: { src: 'https://x/y.png' } });
const codeBlock = (value: string) => ({ type: 'codeBlock', content: [text(value)] });

describe('TiptapParser.extractMetadata', () => {
  it('computes word/char/reading-time for a simple document', () => {
    const meta = parser.extractMetadata(doc([para('hello world foo bar')]));
    expect(meta.wordCount).toBe(4);
    expect(meta.charCount).toBeGreaterThan(0);
    expect(meta.readingTimeMinutes).toBe(1);
    expect(meta.plainText).toContain('hello world');
  });

  it('counts headings, images, and code blocks across the tree', () => {
    const meta = parser.extractMetadata(
      doc([
        heading('Intro'),
        para('some text'),
        image(),
        heading('Section'),
        image(),
        codeBlock('const x = 1;'),
      ])
    );
    expect(meta.headingCount).toBe(2);
    expect(meta.imageCount).toBe(2);
    expect(meta.codeBlockCount).toBe(1);
  });

  it('returns all-zero structural counts for empty/invalid content', () => {
    for (const bad of [null, undefined, 'string', 42]) {
      const meta = parser.extractMetadata(bad as any);
      expect(meta).toMatchObject({
        wordCount: 0,
        charCount: 0,
        readingTimeMinutes: 0,
        headingCount: 0,
        imageCount: 0,
        codeBlockCount: 0,
      });
    }
  });

  it('counts nested nodes (images inside deeper structures)', () => {
    const nested = doc([
      { type: 'blockquote', content: [para('quote'), image()] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [heading('h')] }] },
    ]);
    const meta = parser.extractMetadata(nested);
    expect(meta.imageCount).toBe(1);
    expect(meta.headingCount).toBe(1);
  });
});

describe('TiptapParser.sanitize', () => {
  it('escapes angle brackets in text nodes', () => {
    const result = parser.sanitize(doc([para('<script>alert(1)</script>')]));
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('coerces a non-doc root into an empty doc', () => {
    expect(parser.sanitize({ type: 'paragraph' })).toEqual({ type: 'doc', content: [] });
    expect(parser.sanitize(null)).toEqual({ type: 'doc', content: [] });
  });

  it('drops a link mark whose href uses a javascript: scheme', () => {
    const input = doc([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
        ],
      },
    ]);
    const result: any = parser.sanitize(input);
    expect(result.content[0].content[0].marks).toEqual([]);
  });

  it('keeps a safe link mark intact', () => {
    const input = doc([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'ok', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        ],
      },
    ]);
    const result: any = parser.sanitize(input);
    expect(result.content[0].content[0].marks[0].attrs.href).toBe('https://example.com');
  });

  it('nulls a dangerous image src', () => {
    const input = doc([{ type: 'image', attrs: { src: 'javascript:alert(1)' } }]);
    const result: any = parser.sanitize(input);
    expect(result.content[0].attrs.src).toBeNull();
  });
});
