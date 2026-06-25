import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../../core/config/env';

export interface TokenPayload {
  userId: string;
  role: string;
}

export class TokensService {
  /**
   * Generates a short-lived Access Token
   */
  generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as any,
    });
  }

  /**
   * Generates a long-lived Refresh Token
   */
  generateRefreshToken(payload: TokenPayload): string {
    return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN as any,
    });
  }

  /**
   * Verifies an Access Token
   */
  verifyAccessToken(token: string): TokenPayload {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload;
  }

  /**
   * Verifies a Refresh Token
   */
  verifyRefreshToken(token: string): TokenPayload {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
  }

  /**
   * Hashes a raw refresh token using SHA-256 for secure database storage
   */
  hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}

export const tokensService = new TokensService();
