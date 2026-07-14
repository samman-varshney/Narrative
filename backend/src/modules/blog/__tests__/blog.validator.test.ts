import {
  createBlogSchema,
  updateBlogSchema,
  tiptapContentSchema,
  seoInputSchema,
} from '../blog.validator';

describe('createBlogSchema', () => {
  it('accepts a minimal payload with just a title', () => {
    const result = createBlogSchema.safeParse({ title: 'Hello' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(createBlogSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects a title over 200 chars', () => {
    expect(createBlogSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
  });

  it('rejects an unknown visibility', () => {
    const r = createBlogSchema.safeParse({ title: 'x', visibility: 'SECRET' });
    expect(r.success).toBe(false);
  });

  it('rejects more than 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(createBlogSchema.safeParse({ title: 'x', tags }).success).toBe(false);
  });
});

describe('tiptapContentSchema', () => {
  it('accepts a doc-rooted object and preserves nested content', () => {
    const content = { type: 'doc', content: [{ type: 'paragraph' }] };
    const result = tiptapContentSchema.safeParse(content);
    expect(result.success).toBe(true);
    if (result.success) {
      // Must NOT strip the nested `content` array.
      expect((result.data as any).content).toHaveLength(1);
    }
  });

  it('rejects content whose root is not a doc', () => {
    expect(tiptapContentSchema.safeParse({ type: 'paragraph' }).success).toBe(false);
  });
});

describe('updateBlogSchema', () => {
  it('accepts an explicit valid slug', () => {
    expect(updateBlogSchema.safeParse({ slug: 'my-post-2' }).success).toBe(true);
  });

  it('rejects a slug with invalid characters', () => {
    expect(updateBlogSchema.safeParse({ slug: 'My Post!' }).success).toBe(false);
  });

  it('is fully optional (empty object allowed)', () => {
    expect(updateBlogSchema.safeParse({}).success).toBe(true);
  });
});

describe('seoInputSchema', () => {
  it('rejects a non-URL canonicalUrl', () => {
    expect(seoInputSchema.safeParse({ canonicalUrl: 'not a url' }).success).toBe(false);
  });

  it('allows an empty string for URL fields', () => {
    expect(seoInputSchema.safeParse({ canonicalUrl: '', ogImage: '' }).success).toBe(true);
  });
});
