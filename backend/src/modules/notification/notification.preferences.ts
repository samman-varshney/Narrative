import { z } from 'zod';
import { NotificationType } from '@prisma/client';
import type { ResolvedPreferences, ChannelToggles } from './notification.types';

/**
 * Notification preferences, stored as typed JSON in `UserSettings.notificationPreferences`.
 *
 * That column already existed but was unreachable — no validator accepted it and
 * nothing defined its shape. This module owns that shape.
 *
 * Two absences must both resolve to defaults, not to "everything off":
 *   - the column is null (user never touched preferences), and
 *   - the whole UserSettings row is missing (it is created lazily on first write).
 * Silently defaulting to off would make notifications vanish for most users.
 */

const channelTogglesSchema = z.object({
  inApp: z.boolean(),
  email: z.boolean(),
});

/**
 * Partial by design, on both axes: a stored blob only carries the types the user
 * actually changed, and within a type only the channels they changed. Everything
 * else falls back to DEFAULT_PREFERENCES.
 */
export const notificationPreferencesSchema = z.partialRecord(
  z.enum(NotificationType),
  channelTogglesSchema.partial()
);

export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

/**
 * Defaults, chosen so the noisy channel is opt-in per type:
 * high-signal, low-volume events may email; anything a busy blog produces in
 * bulk stays in-app only.
 */
export const DEFAULT_PREFERENCES: ResolvedPreferences = {
  FOLLOW: { inApp: true, email: true },
  REPLY: { inApp: true, email: true },
  COMMENT: { inApp: true, email: false }, // can be high-volume on a popular post
  BLOG: { inApp: true, email: true },
  SYSTEM: { inApp: true, email: true }, // account/security matters — reachable
  MENTION: { inApp: true, email: true }, // reserved
  LIKE: { inApp: true, email: false }, // reserved; inherently high-volume
};

/**
 * Merges a stored (possibly null, partial, or malformed) blob over the defaults.
 * Never throws: bad stored data falls back to defaults rather than blocking a
 * notification, because a preferences parse error must not silence a user.
 */
export function resolvePreferences(stored: unknown): ResolvedPreferences {
  const resolved = structuredClone(DEFAULT_PREFERENCES);

  if (stored == null) return resolved;

  const parsed = notificationPreferencesSchema.safeParse(stored);
  if (!parsed.success) return resolved;

  for (const [type, toggles] of Object.entries(parsed.data)) {
    const key = type as NotificationType;
    if (!(key in resolved) || !toggles) continue;
    resolved[key] = { ...resolved[key], ...toggles } as ChannelToggles;
  }

  return resolved;
}
