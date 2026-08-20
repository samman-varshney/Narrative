import { Session } from '@prisma/client';
import { tokensService } from './tokens.service';
import { prisma } from '../../core/database/prisma';

export class SessionService {
  /**
   * Creates a new session in PostgreSQL
   */
  async createSession(
    userId: string,
    rawRefreshToken: string,
    metadata?: { deviceId?: string; userAgent?: string; ipAddress?: string }
  ): Promise<Session> {
    const refreshTokenHash = tokensService.hashRefreshToken(rawRefreshToken);

    // Parse duration logic (hardcoded to 7 days for V1)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    return prisma.session.create({
      data: {
        userId,
        refreshTokenHash,
        deviceId: metadata?.deviceId,
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
        expiresAt,
      },
    });
  }

  /**
   * Validates if an active session exists for a given raw token
   */
  async validateSession(rawRefreshToken: string): Promise<Session | null> {
    const refreshTokenHash = tokensService.hashRefreshToken(rawRefreshToken);

    const session = await prisma.session.findUnique({
      where: { refreshTokenHash },
    });

    if (!session || session.expiresAt < new Date()) {
      return null;
    }

    // Update lastUsedAt
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });

    return session;
  }

  /**
   * Rotates a refresh token: revokes old session, creates new one
   */
  async rotateToken(
    oldRawToken: string,
    newRawToken: string,
    userId: string,
    metadata?: { deviceId?: string; userAgent?: string; ipAddress?: string }
  ): Promise<Session> {
    const oldRefreshTokenHash = tokensService.hashRefreshToken(oldRawToken);
    const newRefreshTokenHash = tokensService.hashRefreshToken(newRawToken);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    return prisma.$transaction(async (tx) => {
      try {
        await tx.session.delete({ where: { refreshTokenHash: oldRefreshTokenHash } });
      } catch (e) {
        // Ignore if not found
      }

      return tx.session.create({
        data: {
          userId,
          refreshTokenHash: newRefreshTokenHash,
          deviceId: metadata?.deviceId,
          userAgent: metadata?.userAgent,
          ipAddress: metadata?.ipAddress,
          expiresAt,
        },
      });
    });
  }

  /**
   * Revokes a specific session
   */
  async revokeSession(rawRefreshToken: string): Promise<void> {
    const refreshTokenHash = tokensService.hashRefreshToken(rawRefreshToken);
    await prisma.session.delete({
      where: { refreshTokenHash },
    }).catch(() => {
      // Ignore if not found
    });
  }

  /**
   * Revokes all sessions for a user
   */
  async revokeAllSessions(userId: string): Promise<void> {
    await prisma.session.deleteMany({
      where: { userId },
    });
  }

  /**
   * Retrieves all active sessions for a user
   */
  async getUserSessions(userId: string) {
    return prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  /**
   * This user's sign-in sessions, for the data export.
   *
   * Device, agent, IP and timestamps — never `refreshTokenHash`. The hash is a
   * live credential: exporting it would put a working key to the account inside
   * a file the user is about to email themselves or drop in cloud storage.
   *
   * Unlike `getUserSessions`, EXPIRED sessions are included: the sign-in history
   * is what makes this section worth exporting at all, and a list of only
   * currently-valid sessions is a status page, not a record.
   */
  async collectForExport(userId: string) {
    return prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }
}

export const sessionService = new SessionService();
