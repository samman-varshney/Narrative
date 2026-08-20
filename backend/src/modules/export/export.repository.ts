import type { ExportStatus, Prisma } from '@prisma/client';
import { prisma } from '../../core/database/prisma';

/**
 * The ExportRequest table — the only table this module owns, and the only one it
 * touches. Everything that ends up INSIDE an export is read through the service
 * of the module that owns it.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 * `artifact` is a bytea column holding up to 25 MB. Prisma returns every scalar
 * by default, so a bare `findMany` here would stream every stored artifact out
 * of Postgres to render a list of status badges — and it would do it on the
 * request path, invisibly, getting slower as the feature succeeded.
 *
 * So NOTHING in this file selects `*`. `METADATA_FIELDS` is the explicit column
 * list every read uses, and exactly one method (`findArtifact`) may read the
 * bytes. If a new query is added here, it selects from `METADATA_FIELDS` unless
 * its entire purpose is to serve a download.
 */

/** Every column except `artifact`. The default projection for this table. */
const METADATA_FIELDS = {
  id: true,
  userId: true,
  status: true,
  sizeBytes: true,
  checksum: true,
  error: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
  expiresAt: true,
  downloadCount: true,
} satisfies Prisma.ExportRequestSelect;

export type ExportRequestMetadata = Prisma.ExportRequestGetPayload<{
  select: typeof METADATA_FIELDS;
}>;

export class ExportRepository {
  async create(userId: string): Promise<ExportRequestMetadata> {
    return prisma.exportRequest.create({
      data: { userId },
      select: METADATA_FIELDS,
    });
  }

  async findById(id: string): Promise<ExportRequestMetadata | null> {
    return prisma.exportRequest.findUnique({ where: { id }, select: METADATA_FIELDS });
  }

  async listForUser(userId: string, limit: number): Promise<ExportRequestMetadata[]> {
    return prisma.exportRequest.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      take: limit,
      select: METADATA_FIELDS,
    });
  }

  /** The most recent request of any status — the cooldown reads this. */
  async findLatestForUser(userId: string): Promise<ExportRequestMetadata | null> {
    return prisma.exportRequest.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      select: METADATA_FIELDS,
    });
  }

  /** Whether the user already has a build queued or running. */
  async countInFlight(userId: string): Promise<number> {
    return prisma.exportRequest.count({
      where: { userId, status: { in: ['PENDING', 'PROCESSING'] } },
    });
  }

  /**
   * The ONE read permitted to touch the bytes.
   *
   * Returns the artifact together with the fields the download path must check,
   * so ownership and expiry are decided on the same row that produced the bytes
   * rather than on a second read that could disagree with it.
   */
  async findArtifact(id: string) {
    return prisma.exportRequest.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        expiresAt: true,
        checksum: true,
        sizeBytes: true,
        artifact: true,
      },
    });
  }

  /**
   * Conditional status transition, mirroring `userRepository.transitionStatus`.
   *
   * The worker is at-least-once: BullMQ retries a job whose process died, and
   * two dispatches of the same export must not both build it. Claiming
   * PENDING → PROCESSING through a conditional UPDATE means the second one sees
   * `false` and stops, rather than racing the first and overwriting its result.
   */
  async transition(
    id: string,
    expected: ExportStatus[],
    next: ExportStatus,
    fields: Prisma.ExportRequestUpdateManyMutationInput = {}
  ): Promise<boolean> {
    const result = await prisma.exportRequest.updateMany({
      where: { id, status: { in: expected } },
      data: { status: next, ...fields },
    });
    return result.count === 1;
  }

  /** Stores a finished artifact and marks the request READY, atomically. */
  async markReady(
    id: string,
    artifact: Buffer,
    checksum: string,
    expiresAt: Date
  ): Promise<boolean> {
    const result = await prisma.exportRequest.updateMany({
      where: { id, status: 'PROCESSING' },
      data: {
        status: 'READY',
        // Copied into a plain Uint8Array: Prisma's Bytes input is
        // `Uint8Array<ArrayBuffer>`, and Node's Buffer is
        // `Uint8Array<ArrayBufferLike>` — which may be backed by a
        // SharedArrayBuffer and so is not assignable.
        artifact: new Uint8Array(artifact),
        sizeBytes: artifact.length,
        checksum,
        expiresAt,
        completedAt: new Date(),
        error: null,
      },
    });
    return result.count === 1;
  }

  async incrementDownloadCount(id: string): Promise<void> {
    await prisma.exportRequest.update({
      where: { id },
      data: { downloadCount: { increment: 1 } },
    });
  }

  /**
   * The sweep: drop the bytes of every artifact past its expiry.
   *
   * The ROW survives as EXPIRED — a user must be able to see that an export they
   * requested existed and has lapsed, rather than finding no trace of it. Only
   * the payload goes.
   */
  async expireArtifacts(now: Date): Promise<number> {
    const result = await prisma.exportRequest.updateMany({
      where: { status: 'READY', expiresAt: { lte: now } },
      data: { status: 'EXPIRED', artifact: null },
    });
    return result.count;
  }
}

export const exportRepository = new ExportRepository();
