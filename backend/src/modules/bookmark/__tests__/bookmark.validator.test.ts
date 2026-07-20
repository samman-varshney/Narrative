import {
  blogIdParamSchema,
  bookmarkListQuerySchema,
} from '../bookmark.validator';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../../core/utils/pagination';

describe('bookmark validators', () => {
  describe('blogIdParamSchema', () => {
    it('accepts a non-empty blogId', () => {
      expect(blogIdParamSchema.parse({ blogId: 'blog1' })).toEqual({ blogId: 'blog1' });
    });

    it('rejects an empty blogId', () => {
      expect(blogIdParamSchema.safeParse({ blogId: '' }).success).toBe(false);
    });

    it('rejects a missing blogId', () => {
      expect(blogIdParamSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('bookmarkListQuerySchema', () => {
    it('defaults sort to recent and limit to the shared page default', () => {
      const parsed = bookmarkListQuerySchema.parse({});
      expect(parsed.sort).toBe('recent');
      expect(parsed.limit).toBe(DEFAULT_PAGE_LIMIT);
      expect(parsed.cursor).toBeUndefined();
    });

    it('coerces a numeric limit from its query-string form', () => {
      expect(bookmarkListQuerySchema.parse({ limit: '5' }).limit).toBe(5);
    });

    it('rejects a limit above MAX_PAGE_LIMIT', () => {
      const result = bookmarkListQuerySchema.safeParse({ limit: String(MAX_PAGE_LIMIT + 1) });
      expect(result.success).toBe(false);
    });

    it('rejects a limit below 1', () => {
      expect(bookmarkListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    });

    it('accepts both sort directions', () => {
      expect(bookmarkListQuerySchema.parse({ sort: 'oldest' }).sort).toBe('oldest');
      expect(bookmarkListQuerySchema.parse({ sort: 'recent' }).sort).toBe('recent');
    });

    it('rejects an unknown sort value', () => {
      expect(bookmarkListQuerySchema.safeParse({ sort: 'popular' }).success).toBe(false);
    });

    it('accepts optional authorId and tag filters', () => {
      const parsed = bookmarkListQuerySchema.parse({ authorId: 'a1', tag: 'rust' });
      expect(parsed).toMatchObject({ authorId: 'a1', tag: 'rust' });
    });

    it('rejects an over-long tag', () => {
      const result = bookmarkListQuerySchema.safeParse({ tag: 'x'.repeat(51) });
      expect(result.success).toBe(false);
    });

    it('rejects an empty tag', () => {
      expect(bookmarkListQuerySchema.safeParse({ tag: '' }).success).toBe(false);
    });
  });
});
