import { userIdParamSchema, followListQuerySchema } from '../follow.validator';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../../core/utils/pagination';

describe('follow validators', () => {
  describe('userIdParamSchema', () => {
    it('accepts a non-empty userId', () => {
      expect(userIdParamSchema.parse({ userId: 'abc123' })).toEqual({ userId: 'abc123' });
    });

    it('rejects a missing or empty userId', () => {
      expect(userIdParamSchema.safeParse({}).success).toBe(false);
      expect(userIdParamSchema.safeParse({ userId: '' }).success).toBe(false);
    });
  });

  describe('followListQuerySchema', () => {
    it('defaults limit to DEFAULT_PAGE_LIMIT when omitted', () => {
      const result = followListQuerySchema.parse({});
      expect(result.limit).toBe(DEFAULT_PAGE_LIMIT);
      expect(result.cursor).toBeUndefined();
    });

    it('coerces a numeric-string limit from the query', () => {
      const result = followListQuerySchema.parse({ limit: '15' });
      expect(result.limit).toBe(15);
    });

    it('accepts an optional cursor', () => {
      const result = followListQuerySchema.parse({ cursor: 'f42', limit: '5' });
      expect(result).toEqual({ cursor: 'f42', limit: 5 });
    });

    it('rejects limit above the maximum', () => {
      expect(followListQuerySchema.safeParse({ limit: String(MAX_PAGE_LIMIT + 1) }).success).toBe(false);
    });

    it('rejects zero, negative, and non-numeric limits', () => {
      expect(followListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
      expect(followListQuerySchema.safeParse({ limit: '-3' }).success).toBe(false);
      expect(followListQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
    });

    it('rejects a non-integer limit', () => {
      expect(followListQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
    });
  });
});
