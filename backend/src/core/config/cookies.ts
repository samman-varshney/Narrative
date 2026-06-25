import { CookieOptions } from 'express';

// Duration conversions
const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

export const COOKIE_CONFIG = {
  REFRESH_TOKEN: {
    name: 'refreshToken',
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict' as const,
      maxAge: 7 * ONE_DAY, // Must match JWT_REFRESH_EXPIRES_IN logically
      path: '/api/v1/auth', // Restrict cookie to auth routes
    } as CookieOptions,
  },
  // Add future cookies here (e.g., csrfToken, themePreference)
};
