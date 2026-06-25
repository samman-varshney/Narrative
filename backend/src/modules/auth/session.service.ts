import { PrismaClient, Session } from '@prisma/client';
import { tokensService } from './tokens.service';

const prisma = new PrismaClient();

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
    await this.revokeSession(oldRawToken);
    return this.createSession(userId, newRawToken, metadata);
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
}

export const sessionService = new SessionService();
