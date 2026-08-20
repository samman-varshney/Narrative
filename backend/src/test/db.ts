import { prisma } from '../core/database/prisma';

/**
 * Helpers for tests that exercise real SQL against the local test database.
 *
 * These exist because mock-based repository tests only prove a query was BUILT
 * as intended — never that it BEHAVES as intended. Cursor pagination, unique
 * constraints, cascade deletes, and concurrent writes are all invisible to a
 * mocked Prisma delegate.
 *
 * Only import this from integration tests. Unit tests should keep mocking.
 */

let cachedTables: string[] | null = null;

async function tableNames(): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
  `;
  cachedTables = rows.map((r) => `"public"."${r.tablename}"`);
  return cachedTables;
}

/**
 * Empties every table. `CASCADE` handles FK order for us, so tables can be
 * truncated in one statement without dependency sorting.
 */
export async function resetDb(): Promise<void> {
  const tables = await tableNames();
  if (tables.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`
  );
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

// ---- Factories ----------------------------------------------------------
// Deterministic-but-unique values: a counter rather than randomness, so a
// failing test reproduces exactly. (Date.now()/Math.random() would not.)

let seq = 0;
const next = () => ++seq;

export async function makeUser(overrides: Partial<{
  email: string;
  username: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  role: 'USER' | 'ADMIN';
}> = {}) {
  const n = next();
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user${n}@test.local`,
      username: overrides.username ?? `user${n}`,
      name: overrides.name ?? `User ${n}`,
      passwordHash: 'not-a-real-hash',
      status: overrides.status ?? 'ACTIVE',
      role: overrides.role ?? 'USER',
    },
  });
}

export async function makeBlog(
  authorId: string,
  overrides: Partial<{
    title: string;
    slug: string;
    subtitle: string | null;
    status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'DELETED';
    visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE' | 'MEMBERS_ONLY';
    publishedAt: Date | null;
    readingTimeMinutes: number;
  }> = {}
) {
  const n = next();
  const status = overrides.status ?? 'PUBLISHED';
  return prisma.blog.create({
    data: {
      title: overrides.title ?? `Blog ${n}`,
      slug: overrides.slug ?? `blog-${n}`,
      subtitle: overrides.subtitle ?? null,
      authorId,
      status,
      visibility: overrides.visibility ?? 'PUBLIC',
      readingTimeMinutes: overrides.readingTimeMinutes ?? 0,
      publishedAt:
        overrides.publishedAt !== undefined
          ? overrides.publishedAt
          : status === 'PUBLISHED'
            ? new Date('2026-01-01T00:00:00Z')
            : null,
    },
  });
}

/** Tag vocabulary entry. `slug` defaults to the lowercased name. */
export async function makeTag(name: string, slug?: string) {
  return prisma.tag.create({ data: { name, slug: slug ?? name.toLowerCase() } });
}

/** Curated category. `slug` defaults to the lowercased name. */
export async function makeCategory(name: string, slug?: string) {
  return prisma.category.create({ data: { name, slug: slug ?? name.toLowerCase() } });
}

export async function tagBlog(blogId: string, tagId: string) {
  return prisma.blogTag.create({ data: { blogId, tagId } });
}

export async function categorizeBlog(blogId: string, categoryId: string) {
  return prisma.blogCategory.create({ data: { blogId, categoryId } });
}

/** Writes a user's settings row — used by tests that exercise privacy rules. */
export async function makeUserSettings(
  userId: string,
  settings: Partial<{ isPrivate: boolean; hideActivity: boolean; hideEmail: boolean }>
) {
  return prisma.userSettings.upsert({
    where: { userId },
    update: settings,
    create: { userId, ...settings },
  });
}

export async function makeBookmark(userId: string, blogId: string) {
  return prisma.bookmark.create({ data: { userId, blogId } });
}

export async function makeFollow(followerId: string, followingId: string) {
  return prisma.follow.create({ data: { followerId, followingId } });
}
