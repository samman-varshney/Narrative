import { prisma } from '../../../core/database/prisma';
import { redis } from '../../../core/providers/redis';
import { resetGenerationMemo } from '../rss.cache';

/**
 * Shared fixtures for the RSS suites.
 *
 * The test Redis is a real one (logical DB 1, per jest.setup.js) and is shared
 * with the rate limiters and BullMQ, so `FLUSHDB` would take out unrelated
 * state. Cleanup is scoped to the RSS keyspace instead — `SCAN`, never `KEYS`,
 * for the same reason the production code avoids it.
 */
export async function clearRssKeys(): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'rss:v1:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');

  // Generations are memoized in-process for a few seconds; without this a suite
  // would keep using the counter it read before the flush and write into a
  // keyspace it just deleted.
  resetGenerationMemo();
}

let seq = 0;
const next = () => ++seq;

/**
 * A blog with the fields RSS actually reads.
 *
 * `src/test/db.ts`'s `makeBlog` covers the lifecycle columns every suite needs;
 * this adds the four RSS-specific ones — body, SEO row, cover and an explicit
 * `updatedAt` — rather than widening the shared factory for one module. The
 * Feed and Dashboard suites take the same approach.
 *
 * `updatedAt` needs a second write because Prisma's `@updatedAt` overrides
 * whatever the create supplies. Feeds derive `lastBuildDate` and every HTTP
 * validator from that column, so a test cannot leave it to wall-clock time and
 * still assert on a date.
 */
export async function makeRssBlog(
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
    metaDescription: string | null;
    canonicalUrl: string | null;
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

  if (overrides.metaDescription !== undefined || overrides.canonicalUrl !== undefined) {
    await prisma.blogSEO.create({
      data: {
        blogId: blog.id,
        metaDescription: overrides.metaDescription ?? null,
        canonicalUrl: overrides.canonicalUrl ?? null,
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

/**
 * Sets a blog's `updatedAt` explicitly.
 *
 * Prisma's `@updatedAt` rewrites the column on EVERY write, so any fixture step
 * that touches the blog after `makeRssBlog` — attaching a cover, adding a tag
 * through a relation — silently moves it to now. Feeds derive `lastBuildDate`
 * and every HTTP validator from that column, so a test asserting on a date must
 * call this LAST, once the row is otherwise final.
 */
export async function touchUpdatedAt(blogId: string, updatedAt: Date) {
  return prisma.blog.update({ where: { id: blogId }, data: { updatedAt } });
}

/** Attaches a Media row as a blog's cover, so an item can carry an enclosure. */
export async function attachCover(
  blogId: string,
  uploaderId: string,
  overrides: Partial<{ secureUrl: string; mimeType: string; fileSize: number; deletedAt: Date }> = {}
) {
  const n = next();
  const media = await prisma.media.create({
    data: {
      publicId: `covers/secret-internal-path-${n}`,
      url: overrides.secureUrl ?? `https://cdn.test/cover-${n}.jpg`,
      secureUrl: overrides.secureUrl ?? `https://cdn.test/cover-${n}.jpg`,
      originalFilename: `cover-${n}.jpg`,
      mimeType: overrides.mimeType ?? 'image/jpeg',
      extension: 'jpg',
      fileSize: overrides.fileSize ?? 12345,
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

/** A minimal Tiptap document carrying `text` in one paragraph. */
export function tiptapDoc(text: string): unknown {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Counts the database round trips a block of work performs.
 *
 * Spies on every Prisma entry point the RSS module can reach, calling each
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
    jest.spyOn(prisma.blogTag, 'findMany'),
    jest.spyOn(prisma.blogCategory, 'findMany'),
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

/** Every `<item>` block in a rendered feed, in document order. */
export function itemBlocks(xml: string): string[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1] as string);
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
