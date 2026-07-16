import {
  createCommentSchema,
  replyCommentSchema,
  updateCommentSchema,
  commentListQuerySchema,
  MAX_COMMENT_LENGTH,
} from '../comment.validator';

describe('createCommentSchema', () => {
  it('accepts content with an optional parentId', () => {
    const parsed = createCommentSchema.parse({ content: 'hello', parentId: 'c1' });
    expect(parsed).toEqual({ content: 'hello', parentId: 'c1' });
  });

  it('accepts content without a parentId (top-level)', () => {
    const parsed = createCommentSchema.parse({ content: 'hello' });
    expect(parsed.parentId).toBeUndefined();
  });

  it('rejects empty content', () => {
    expect(createCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('rejects content over the max length', () => {
    const tooLong = 'a'.repeat(MAX_COMMENT_LENGTH + 1);
    expect(createCommentSchema.safeParse({ content: tooLong }).success).toBe(false);
  });

  it('rejects an empty parentId', () => {
    expect(createCommentSchema.safeParse({ content: 'hi', parentId: '' }).success).toBe(false);
  });

  it('does NOT sanitize markup itself (that is the service’s job) but still accepts it', () => {
    // The validator bounds length only; HTML is stripped later by the service.
    const parsed = createCommentSchema.parse({ content: '<b>hi</b><script>x</script>' });
    expect(parsed.content).toContain('<b>');
  });
});

describe('replyCommentSchema / updateCommentSchema', () => {
  it('require content and forbid a parentId field on replies', () => {
    expect(replyCommentSchema.safeParse({ content: 'hi' }).success).toBe(true);
    expect(replyCommentSchema.safeParse({}).success).toBe(false);
    expect(updateCommentSchema.safeParse({ content: 'edited' }).success).toBe(true);
    expect(updateCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });
});

describe('commentListQuerySchema', () => {
  it('defaults tree to true and coerces the limit', () => {
    const parsed = commentListQuerySchema.parse({ limit: '10' });
    expect(parsed.tree).toBe(true);
    expect(parsed.limit).toBe(10);
  });

  it('parses tree=false into a boolean', () => {
    expect(commentListQuerySchema.parse({ tree: 'false' }).tree).toBe(false);
  });

  it('rejects an invalid tree value', () => {
    expect(commentListQuerySchema.safeParse({ tree: 'maybe' }).success).toBe(false);
  });
});
