import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';

/**
 * Single, shared PrismaClient instance for the whole application.
 *
 * Per the architecture (§12), the Prisma Client must never be instantiated
 * ad-hoc inside repositories/services — each `new PrismaClient()` opens its own
 * connection pool, which exhausts Postgres connections under load and leaks
 * connections across dev hot-reloads. Everything imports this singleton instead.
 *
 * Prisma 7 no longer reads the datasource URL from the schema. For a direct
 * PostgreSQL connection (Neon) the URL is supplied through the node-postgres
 * driver adapter, which owns the connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

