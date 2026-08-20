import { AppError } from '../../../core/exceptions/AppError';
import type { ISearchEngine } from '../engines/ISearchEngine';
import { SearchService } from '../search.service';
import { isRecordable } from '../search.terms';

// The service must be testable without Redis or Postgres: it owns orchestration,
// not retrieval. Cache and stores are mocked; the engine is injected.
jest.mock('../search.cache', () => ({
  // Pass-through by default so tests assert on orchestration, not on caching
  // (which search.cache.test.ts covers against a real Redis).
  withCache: jest.fn((_scope: string, _parts: unknown, loader: () => Promise<unknown>) =>
    loader()
  ),
}));
jest.mock('../search.history', () => ({
  searchHistoryStore: {
    record: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue([]),
    clear: jest.fn().mockResolvedValue(0),
  },
}));
jest.mock('../search.terms', () => ({
  ...jest.requireActual('../search.terms'),
  searchTermsStore: {
    record: jest.fn().mockResolvedValue(undefined),
    popular: jest.fn().mockResolvedValue([]),
  },
}));

import { withCache } from '../search.cache';
import { searchHistoryStore } from '../search.history';
import { searchTermsStore } from '../search.terms';

const emptyPage = { items: [], nextCursor: null, hasMore: false };

function makeEngine(overrides: Partial<ISearchEngine> = {}): jest.Mocked<ISearchEngine> {
  return {
    name: 'fake',
    searchBlogs: jest.fn().mockResolvedValue(emptyPage),
    searchUsers: jest.fn().mockResolvedValue(emptyPage),
    searchTags: jest.fn().mockResolvedValue(emptyPage),
    searchCategories: jest.fn().mockResolvedValue(emptyPage),
    suggest: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as jest.Mocked<ISearchEngine>;
}

const BLOG_QUERY = {
  q: 'JavaScript',
  limit: 20,
  sort: 'relevance' as const,
};

describe('SearchService', () => {
  let engine: jest.Mocked<ISearchEngine>;
  let service: SearchService;

  beforeEach(() => {
    jest.clearAllMocks();
    engine = makeEngine();
    service = new SearchService(engine);
  });

  describe('normalization', () => {
    it('hands the engine a normalized query, never the raw request string', async () => {
      await service.searchBlogs({ ...BLOG_QUERY, q: '  JavaScript   Promises  ' });

      expect(engine.searchBlogs).toHaveBeenCalledWith(
        expect.objectContaining({
          raw: 'JavaScript Promises',
          normalized: 'javascript promises',
          prefixPattern: 'javascript promises%',
        }),
        expect.anything(),
        expect.anything()
      );
    });

    it('rejects an invalid query before touching the engine', async () => {
      await expect(service.searchBlogs({ ...BLOG_QUERY, q: '   ' })).rejects.toThrow(AppError);

      expect(engine.searchBlogs).not.toHaveBeenCalled();
    });
  });

  describe('filter mapping', () => {
    it('forwards only the filters the caller actually supplied', async () => {
      await service.searchBlogs({ ...BLOG_QUERY, author: 'grace', tag: ['react'] });

      // Absent keys must be absent, not present-and-undefined: the cache key and
      // cursor fingerprint are derived from this object.
      expect(engine.searchBlogs).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        author: 'grace',
        tags: ['react'],
      });
    });

    it('passes an empty filter bag when none were supplied', async () => {
      await service.searchBlogs(BLOG_QUERY);

      expect(engine.searchBlogs).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {}
      );
    });

    it('drops an empty repeated filter rather than sending an empty IN list', async () => {
      await service.searchBlogs({ ...BLOG_QUERY, tag: [], category: [] });

      expect(engine.searchBlogs).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {}
      );
    });

    it('forwards date and reading-time bounds', async () => {
      const from = new Date('2026-01-01T00:00:00Z');
      const to = new Date('2026-06-01T00:00:00Z');

      await service.searchBlogs({ ...BLOG_QUERY, from, to, minReadingTime: 0, maxReadingTime: 10 });

      expect(engine.searchBlogs).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        from,
        to,
        minReadingTime: 0, // zero is a real bound, not a missing one
        maxReadingTime: 10,
      });
    });
  });

  describe('pagination request', () => {
    it('omits the cursor key entirely when no cursor was given', async () => {
      await service.searchBlogs(BLOG_QUERY);

      expect(engine.searchBlogs).toHaveBeenCalledWith(
        expect.anything(),
        { limit: 20, sort: 'relevance' },
        expect.anything()
      );
    });

    it('forwards the cursor, limit and sort when given', async () => {
      await service.searchBlogs({ ...BLOG_QUERY, cursor: 'abc', limit: 5, sort: 'newest' });

      expect(engine.searchBlogs).toHaveBeenCalledWith(
        expect.anything(),
        { cursor: 'abc', limit: 5, sort: 'newest' },
        expect.anything()
      );
    });
  });

  describe('caching', () => {
    it('caches under the blogs scope with every result-shaping input in the key', async () => {
      await service.searchBlogs({ ...BLOG_QUERY, author: 'grace', cursor: 'c1' });

      expect(withCache).toHaveBeenCalledWith(
        'blogs',
        {
          q: 'javascript',
          sort: 'relevance',
          limit: 20,
          cursor: 'c1',
          filters: { author: 'grace' },
        },
        expect.any(Function)
      );
    });

    it('never puts the viewer in the cache key, because results do not vary by viewer', async () => {
      await service.searchBlogs(BLOG_QUERY, 'user-1');

      const [, parts] = (withCache as jest.Mock).mock.calls[0];
      expect(JSON.stringify(parts)).not.toContain('user-1');
    });

    it('uses a distinct scope per entity', async () => {
      await service.searchUsers({ q: 'grace', limit: 20, sort: 'relevance' });
      await service.searchTags({ q: 'react', limit: 20, sort: 'relevance' });
      await service.searchCategories({ q: 'eng', limit: 20, sort: 'relevance' });

      const scopes = (withCache as jest.Mock).mock.calls.map((call) => call[0]);
      expect(scopes).toEqual(['users', 'tags', 'categories']);
    });
  });

  describe('side effects', () => {
    it('records the term and the history for an authenticated search', async () => {
      engine.searchBlogs.mockResolvedValue({
        items: [{ id: 'b1' }, { id: 'b2' }],
        nextCursor: null,
        hasMore: false,
      } as never);

      await service.searchBlogs(BLOG_QUERY, 'user-1');

      expect(searchTermsStore.record).toHaveBeenCalledWith('javascript', 2);
      expect(searchHistoryStore.record).toHaveBeenCalledWith('user-1', 'javascript');
    });

    it('records the term but no history for an anonymous search', async () => {
      await service.searchBlogs(BLOG_QUERY);

      expect(searchTermsStore.record).toHaveBeenCalled();
      expect(searchHistoryStore.record).not.toHaveBeenCalled();
    });

    it('records the normalized term, so casing and spacing cannot fragment counts', async () => {
      await service.searchBlogs({ ...BLOG_QUERY, q: '  JavaScript  ' }, 'user-1');

      expect(searchTermsStore.record).toHaveBeenCalledWith('javascript', 0);
      expect(searchHistoryStore.record).toHaveBeenCalledWith('user-1', 'javascript');
    });

    it('does not record history for tag or category lookups', async () => {
      // Those endpoints back typeahead widgets; every keystroke would otherwise
      // land in the user's visible history.
      await service.searchTags({ q: 'react', limit: 20, sort: 'relevance' });
      await service.searchCategories({ q: 'eng', limit: 20, sort: 'relevance' });

      expect(searchHistoryStore.record).not.toHaveBeenCalled();
      expect(searchTermsStore.record).not.toHaveBeenCalled();
    });

    it('still returns results when recording throws', async () => {
      (searchTermsStore.record as jest.Mock).mockRejectedValue(new Error('redis down'));
      (searchHistoryStore.record as jest.Mock).mockRejectedValue(new Error('redis down'));

      await expect(service.searchBlogs(BLOG_QUERY, 'user-1')).resolves.toEqual(emptyPage);
    });
  });

  describe('globalSearch', () => {
    it('fans out to every entity concurrently and returns a capped slice of each', async () => {
      engine.searchBlogs.mockResolvedValue({ items: [{ id: 'b' }], nextCursor: null, hasMore: true } as never);
      engine.searchUsers.mockResolvedValue({ items: [{ id: 'u' }], nextCursor: null, hasMore: false } as never);

      const result = await service.globalSearch({ q: 'javascript', limit: 5 });

      expect(result).toEqual({
        query: 'javascript',
        blogs: [{ id: 'b' }],
        users: [{ id: 'u' }],
        tags: [],
        categories: [],
      });
      for (const call of [engine.searchBlogs, engine.searchUsers, engine.searchTags]) {
        expect(call).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ limit: 5, sort: 'relevance' }),
          ...(call === engine.searchBlogs ? [{}] : [])
        );
      }
    });

    it('counts hits across all four entity types when recording the term', async () => {
      engine.searchBlogs.mockResolvedValue({ items: [{ id: 'b' }], nextCursor: null, hasMore: false } as never);
      engine.searchTags.mockResolvedValue({ items: [{ id: 't' }], nextCursor: null, hasMore: false } as never);

      await service.globalSearch({ q: 'javascript', limit: 5 });

      expect(searchTermsStore.record).toHaveBeenCalledWith('javascript', 2);
    });
  });

  describe('suggest', () => {
    it('puts popular terms ahead of vocabulary matches', async () => {
      (searchTermsStore.popular as jest.Mock).mockResolvedValue([
        { text: 'javascript promises', source: 'POPULAR' },
      ]);
      engine.suggest.mockResolvedValue([{ text: 'javascript', source: 'TAG', slug: 'javascript' }]);

      const result = await service.suggest({ q: 'jav', limit: 10 });

      expect(result.map((s) => s.source)).toEqual(['POPULAR', 'TAG']);
    });

    it('de-duplicates case-insensitively across sources', async () => {
      (searchTermsStore.popular as jest.Mock).mockResolvedValue([
        { text: 'react', source: 'POPULAR' },
      ]);
      engine.suggest.mockResolvedValue([
        { text: 'React', source: 'TAG', slug: 'react' },
        { text: 'redis', source: 'TAG', slug: 'redis' },
      ]);

      const result = await service.suggest({ q: 're', limit: 10 });

      expect(result).toEqual([
        { text: 'react', source: 'POPULAR' },
        { text: 'redis', source: 'TAG', slug: 'redis' },
      ]);
    });

    it('honours the limit across the merged list', async () => {
      (searchTermsStore.popular as jest.Mock).mockResolvedValue([
        { text: 'a', source: 'POPULAR' },
        { text: 'b', source: 'POPULAR' },
      ]);
      engine.suggest.mockResolvedValue([
        { text: 'c', source: 'TAG' },
        { text: 'd', source: 'TAG' },
      ]);

      await expect(service.suggest({ q: 'x', limit: 3 })).resolves.toHaveLength(3);
    });

    it('never records a suggestion lookup in history or popularity', async () => {
      await service.suggest({ q: 'jav', limit: 10 });

      expect(searchTermsStore.record).not.toHaveBeenCalled();
      expect(searchHistoryStore.record).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    it('reads and clears the token user’s own history', async () => {
      await service.listHistory('user-1', 10);
      await service.clearHistory('user-1');

      expect(searchHistoryStore.list).toHaveBeenCalledWith('user-1', 10);
      expect(searchHistoryStore.clear).toHaveBeenCalledWith('user-1');
    });
  });
});

describe('isRecordable', () => {
  it.each([
    ['javascript', true],
    ['react hooks', true],
    ['a', false], // too short to be a useful suggestion
    ['x'.repeat(61), false], // too long
    ['someone@example.com', false], // email-shaped
    ['https://example.com/secret', false], // URL-shaped
    ['www.example.com', false],
    ['4111111111111111', false], // long digit run: card/phone/id shaped
    ['postgres 18', true], // short digit runs are fine
  ])('%s -> %s', (term, expected) => {
    expect(isRecordable(term)).toBe(expected);
  });
});
