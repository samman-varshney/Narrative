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
  status: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED' | 'DELETED';
  role: 'USER' | 'MODERATOR' | 'ADMIN';
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

/** A comment on a blog. `path` mirrors what the repository writes for a root. */
export async function makeComment(
  blogId: string,
  authorId: string,
  overrides: Partial<{ content: string; parentId: string | null; isHidden: boolean }> = {}
) {
  const n = next();
  const created = await prisma.comment.create({
    data: {
      blogId,
      authorId,
      content: overrides.content ?? `Comment ${n}`,
      parentId: overrides.parentId ?? null,
      depth: overrides.parentId ? 1 : 0,
      isHidden: overrides.isHidden ?? false,
      ...(overrides.isHidden && { hiddenAt: new Date() }),
    },
  });
  return prisma.comment.update({
    where: { id: created.id },
    data: { path: created.id },
  });
}

/**
 * A report row, written directly.
 *
 * Bypasses the service on purpose: the suites that use this are testing the
 * QUERIES over a populated table (pagination, filters, index usage), and going
 * through the service would drag the Redis guard, the duplicate rules and the
 * event bus into a test about SQL. Suites that exercise the filing rules go
 * through `reportService` instead.
 */
export async function makeReport(
  overrides: Partial<{
    reporterId: string | null;
    source: 'USER' | 'AUTOMATED';
    targetType: 'BLOG' | 'COMMENT' | 'USER';
    targetId: string;
    targetOwnerId: string | null;
    reason:
      | 'SPAM'
      | 'HARASSMENT'
      | 'HATE_SPEECH'
      | 'VIOLENCE'
      | 'SEXUAL_CONTENT'
      | 'MISINFORMATION'
      | 'SELF_HARM'
      | 'COPYRIGHT'
      | 'IMPERSONATION'
      | 'OTHER';
    status: 'PENDING' | 'REVIEWING' | 'RESOLVED' | 'DISMISSED';
    assignedToId: string | null;
    createdAt: Date;
  }> = {}
) {
  const n = next();
  return prisma.report.create({
    data: {
      reporterId: overrides.reporterId ?? null,
      source: overrides.source ?? 'USER',
      targetType: overrides.targetType ?? 'BLOG',
      targetId: overrides.targetId ?? `target-${n}`,
      targetOwnerId: overrides.targetOwnerId ?? null,
      reason: overrides.reason ?? 'SPAM',
      status: overrides.status ?? 'PENDING',
      assignedToId: overrides.assignedToId ?? null,
      ...(overrides.createdAt && { createdAt: overrides.createdAt }),
    },
  });
}

/** An audit row, written directly. Same reasoning as `makeReport`. */
export async function makeModerationAction(
  actorId: string,
  overrides: Partial<{
    action:
      | 'CONTENT_HIDDEN'
      | 'CONTENT_RESTORED'
      | 'CONTENT_DELETED'
      | 'USER_SUSPENDED'
      | 'USER_UNSUSPENDED'
      | 'REPORT_CLAIMED'
      | 'REPORT_RESOLVED'
      | 'REPORT_DISMISSED';
    targetType: 'BLOG' | 'COMMENT' | 'USER' | 'REPORT';
    targetId: string;
    subjectUserId: string | null;
    reportId: string | null;
    reason: string | null;
    createdAt: Date;
  }> = {}
) {
  const n = next();
  return prisma.moderationAction.create({
    data: {
      actorId,
      action: overrides.action ?? 'CONTENT_HIDDEN',
      targetType: overrides.targetType ?? 'BLOG',
      targetId: overrides.targetId ?? `target-${n}`,
      subjectUserId: overrides.subjectUserId ?? null,
      reportId: overrides.reportId ?? null,
      reason: overrides.reason ?? null,
      ...(overrides.createdAt && { createdAt: overrides.createdAt }),
    },
  });
}
