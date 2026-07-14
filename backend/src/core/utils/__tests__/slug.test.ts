import { slugify, nextIncrementalSlug, MAX_SLUG_LENGTH } from '../slug';

describe('slugify', () => {
  it('lowercases and dashes a simple title', () => {
    expect(slugify('My First Blog')).toBe('my-first-blog');
  });

  it('strips accents/diacritics', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
  });

  it('collapses symbols and punctuation to single dashes', () => {
    expect(slugify('C++  &  Rust!!!')).toBe('c-rust');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugify('   ...Hello...   ')).toBe('hello');
  });

  it('falls back to "untitled" for input with no alphanumerics', () => {
    expect(slugify('🎉🎊✨')).toBe('untitled');
    expect(slugify('')).toBe('untitled');
  });

  it('caps length at MAX_SLUG_LENGTH and does not end on a dash', () => {
    const long = 'a'.repeat(200);
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(result.endsWith('-')).toBe(false);
  });
});

describe('nextIncrementalSlug', () => {
  it('returns the bare base when it is free', () => {
    expect(nextIncrementalSlug('my-blog', [])).toBe('my-blog');
  });

  it('returns base-2 when the base is taken', () => {
    expect(nextIncrementalSlug('my-blog', ['my-blog'])).toBe('my-blog-2');
  });

  it('skips to the next free number, no random suffixes', () => {
    expect(nextIncrementalSlug('my-blog', ['my-blog', 'my-blog-2', 'my-blog-3'])).toBe(
      'my-blog-4'
    );
  });

  it('finds a gap rather than always appending to the max', () => {
    // base and base-3 taken, base-2 free → base-2
    expect(nextIncrementalSlug('my-blog', ['my-blog', 'my-blog-3'])).toBe('my-blog-2');
  });

  it('accepts a Set of taken slugs', () => {
    expect(nextIncrementalSlug('post', new Set(['post']))).toBe('post-2');
  });
});
