import { env } from '../../../core/config/env';
import { prisma } from '../../../core/database/prisma';
import { redis } from '../../../core/providers/redis';
import { resetGenerationMemo } from '../seo.cache';
import type { AuthorSeoSource, BlogSeoSource, TermSeoSource } from '../seo.types';

/**
 * Shared fixtures for the SEO suites.
 *
 * The test Redis is a real one (logical DB 1, per jest.setup.js) and is shared
 * with the rate limiters and BullMQ, so `FLUSHDB` would take out unrelated
 * state. Cleanup is scoped to the SEO keyspace instead — `SCAN`, never `KEYS`,
 * for the same reason the production code avoids it.
 */
export async function clearSeoKeys(): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'seo:v1:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');

  // Generations are memoized in-process for a few seconds; without this a suite
  // would keep using the counter it read before the flush and write into a
  // keyspace it just deleted.
  resetGenerationMemo();
}

/**
 * Runs a block with indexing forced on or off.
 *
 * `env` is parsed once at import, so a test cannot influence it through
 * `process.env`. Mutating the parsed object is the pattern the RSS URL suite
 * already uses, and the accessors in `seo.config` read it on every call — so
 * the change takes effect immediately and is restored afterwards whatever the
 * block does.
 *
 * It matters for almost every assertion in these suites: under `NODE_ENV=test`
 * the default is "not indexable", which is the correct production behaviour and
 * would otherwise make every directive read `noindex`.
 */
export async function withIndexing<T>(enabled: boolean, run: () => Promise<T> | T): Promise<T> {
  const original = env.SEO_INDEXING_ENABLED;
  (env as { SEO_INDEXING_ENABLED?: string }).SEO_INDEXING_ENABLED = enabled ? 'true' : 'false';
  try {
    return await run();
  } finally {
    (env as { SEO_INDEXING_ENABLED?: string }).SEO_INDEXING_ENABLED = original;
  }
}

/** Sets an env value for the duration of a suite, restoring it afterwards. */
export function overrideEnv<K extends keyof typeof env>(key: K, value: (typeof env)[K]): () => void {
  const original = env[key];
  (env as Record<string, unknown>)[key as string] = value;
  return () => {
    (env as Record<string, unknown>)[key as string] = original;
  };
}

let seq = 0;
const next = () => ++seq;

/**
 * A blog with the fields SEO actually reads.
 *
 * `src/test/db.ts`'s `makeBlog` covers the lifecycle columns every suite needs;
 * this adds the SEO-specific ones — the override row, the body, the cover and
 * an explicit `updatedAt` — rather than widening the shared factory for one
 * module. The RSS, Feed and Dashboard suites take the same approach.
 *
 * `updatedAt` needs a second write because Prisma's `@updatedAt` overrides
 * whatever the create supplies, and sitemaps derive every `<lastmod>` from that
 * column.
 */
export async function makeSeoBlog(
  authorId: string,
  overrides: Partial<{
    title: string;
    slug: string;
    subtitle: string | null;
    status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'DELETED';
    visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE' | 'MEMBERS_ONLY';
    isHidden: boolean;
    publishedAt: Date | null;
    updatedAt: Date;
    content: unknown;
    coverImage: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalUrl: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    twitterCard: string | null;
  }> = {}
) {
  const n = next();
  const status = overrides.status ?? 'PUBLISHED';

  const blog = await prisma.blog.create({
    data: {
      title: overrides.title ?? `Blog ${n}`,
      slug: overrides.slug ?? `blog-${n}`,
      subtitle: overrides.subtitle ?? null,
      authorId,
      status,
      visibility: overrides.visibility ?? 'PUBLIC',
      isHidden: overrides.isHidden ?? false,
      ...(overrides.isHidden && { hiddenAt: new Date() }),
      coverImage: overrides.coverImage ?? null,
      ...(overrides.content !== undefined && { content: overrides.content as never }),
      publishedAt:
        overrides.publishedAt !== undefined
          ? overrides.publishedAt
          : status === 'PUBLISHED'
            ? new Date('2026-01-01T00:00:00Z')
            : null,
    },
  });

  const seoFields = [
    'metaTitle',
    'metaDescription',
    'canonicalUrl',
    'ogTitle',
    'ogDescription',
    'ogImage',
    'twitterCard',
  ] as const;

  if (seoFields.some((field) => overrides[field] !== undefined)) {
    await prisma.blogSEO.create({
      data: {
        blogId: blog.id,
        metaTitle: overrides.metaTitle ?? null,
        metaDescription: overrides.metaDescription ?? null,
        canonicalUrl: overrides.canonicalUrl ?? null,
        ogTitle: overrides.ogTitle ?? null,
        ogDescription: overrides.ogDescription ?? null,
        ogImage: overrides.ogImage ?? null,
        twitterCard: overrides.twitterCard ?? null,
      },
    });
  }

  if (overrides.updatedAt) {
    return prisma.blog.update({
      where: { id: blog.id },
      data: { updatedAt: overrides.updatedAt },
    });
  }

  return blog;
}

/** Sets a blog's `updatedAt` explicitly. Call LAST, once the row is final. */
export async function touchUpdatedAt(blogId: string, updatedAt: Date) {
  return prisma.blog.update({ where: { id: blogId }, data: { updatedAt } });
}

/** Attaches a Media row as a blog's cover. */
export async function attachCover(
  blogId: string,
  uploaderId: string,
  overrides: Partial<{ secureUrl: string; deletedAt: Date }> = {}
) {
  const n = next();
  const media = await prisma.media.create({
    data: {
      publicId: `covers/secret-internal-path-${n}`,
      url: overrides.secureUrl ?? `https://cdn.test/cover-${n}.jpg`,
      secureUrl: overrides.secureUrl ?? `https://cdn.test/cover-${n}.jpg`,
      originalFilename: `cover-${n}.jpg`,
      mimeType: 'image/jpeg',
      extension: 'jpg',
      fileSize: 12345,
      resourceType: 'IMAGE',
      provider: 'cloudinary',
      uploadedById: uploaderId,
      ...(overrides.deletedAt && { deletedAt: overrides.deletedAt }),
    },
  });

  await prisma.blog.update({
    where: { id: blogId },
    data: { coverMediaId: media.id, coverImage: media.secureUrl },
  });

  return media;
}

/** Writes a user's developer profile — the source of `sameAs` and `twitter:creator`. */
export async function makeDeveloperProfile(
  userId: string,
  links: Partial<{ x: string; github: string; linkedin: string; portfolio: string }>
) {
  return prisma.developerProfile.upsert({
    where: { userId },
    update: links,
    create: { userId, ...links },
  });
}

/** A minimal Tiptap document carrying `text` in one paragraph. */
export function tiptapDoc(text: string): unknown {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

// ---------------------------------------------------------------------------
// Pure-unit fixtures
// ---------------------------------------------------------------------------
//
// Literal source objects for the resolver and indexability suites, which must
// run without a database. Each is a complete, valid, PUBLIC baseline that a
// test narrows with one override — so a test reads as "this one field is what
// makes the difference", which is exactly what it is asserting.

export function blogSource(overrides: Partial<BlogSeoSource> = {}): BlogSeoSource {
  return {
    id: 'blog-1',
    title: 'A Post',
    slug: 'a-post',
    subtitle: null,
    coverImage: null,
    status: 'PUBLISHED',
    visibility: 'PUBLIC',
    isHidden: false,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    authorId: 'user-1',
    seo: null,
    author: {
      id: 'user-1',
      username: 'grace',
      name: 'Grace Hopper',
      avatar: null,
      bio: null,
      status: 'ACTIVE',
      x: null,
    },
    categories: [],
    tags: [],
    coverSecureUrl: null,
    ...overrides,
  };
}

export function authorSource(overrides: Partial<AuthorSeoSource> = {}): AuthorSeoSource {
  return {
    id: 'user-1',
    username: 'grace',
    name: 'Grace Hopper',
    bio: null,
    avatar: null,
    status: 'ACTIVE',
    isPrivate: false,
    x: null,
    socialLinks: [],
    createdAt: new Date('2025-06-01T00:00:00Z'),
    publicPostCount: 3,
    lastPublishedAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

export function termSource(overrides: Partial<TermSeoSource> = {}): TermSeoSource {
  return {
    id: 'tag-1',
    name: 'TypeScript',
    slug: 'typescript',
    publicPostCount: 2,
    lastPublishedAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Counts the database round trips a block of work performs.
 *
 * Spies on every Prisma entry point the SEO module can reach, calling each
 * through to the real implementation. This is how the N+1 assertions are made
 * honest: counting repository METHOD calls would prove only that the service
 * called a batching method, not that the method batched. Counting the driver
 * calls proves the query count itself.
 */
export async function countQueries<T>(
  work: () => Promise<T>
): Promise<{ result: T; queries: number }> {
  const spies = [
    jest.spyOn(prisma, '$queryRaw'),
    jest.spyOn(prisma.blog, 'findMany'),
    jest.spyOn(prisma.blog, 'findUnique'),
    jest.spyOn(prisma.user, 'findUnique'),
    jest.spyOn(prisma.tag, 'findUnique'),
    jest.spyOn(prisma.category, 'findUnique'),
  ];

  try {
    const result = await work();
    const queries = spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
    return { result, queries };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** Every `<url>` block in a rendered sitemap, in document order. */
export function urlBlocks(xml: string): string[] {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1] as string);
}

/** The text content of the first `<tag>` inside `source`, or null. */
export function elementText(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? (match[1] as string) : null;
}

/** Every occurrence of `<tag>`'s text content inside `source`. */
export function allElementText(source: string, tag: string): string[] {
  return [
    ...source.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')),
  ].map((match) => match[1] as string);
}

/** The `content` of a `<meta>` tag by its name/property, from a head fragment. */
export function metaContent(html: string, key: string): string | null {
  const match = html.match(
    new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)" />`)
  );
  return match ? (match[1] as string) : null;
}

/** Every `content` value for a repeated `<meta>` key. */
export function allMetaContent(html: string, key: string): string[] {
  return [
    ...html.matchAll(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)" />`, 'g')),
  ].map((match) => match[1] as string);
}
