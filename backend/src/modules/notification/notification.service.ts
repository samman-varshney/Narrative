import { NotificationType, Prisma } from '@prisma/client';
import {
  notificationRepository,
  NotificationWithActor,
} from './notification.repository';
import { NotificationListQuery, UpdatePreferencesInput } from './notification.validator';
import {
  resolvePreferences,
  DEFAULT_PREFERENCES,
  notificationPreferencesSchema,
} from './notification.preferences';
import type { ResolvedPreferences } from './notification.types';
import { userRepository } from '../user/user.repository';
import { AppError } from '../../core/exceptions/AppError';
import { buildCursorPage } from '../../core/utils/pagination';

export interface NotificationActorDTO {
  id: string;
  username: string;
  name: string;
  avatar: string | null;
  isVerified: boolean;
}

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  actor: NotificationActorDTO | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationListResult {
  items: NotificationDTO[];
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
  unreadCount: number;
}

/**
 * Read-side API for notifications. Writes belong to the orchestrator — nothing
 * outside this module may create a notification, so there is deliberately no
 * public `create` here.
 */
export class NotificationService {
  async list(
    recipientId: string,
    query: NotificationListQuery
  ): Promise<NotificationListResult> {
    const [rows, totalCount, unreadCount] = await Promise.all([
      notificationRepository.findByRecipient(recipientId, query),
      notificationRepository.countByRecipient(recipientId, query),
      notificationRepository.unreadCount(recipientId),
    ]);

    const page = buildCursorPage(rows, query.limit, (r) => r.id);

    return {
      items: page.items.map((r) => this.toDTO(r)),
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      totalCount,
      unreadCount,
    };
  }

  async unreadCount(recipientId: string): Promise<{ unreadCount: number }> {
    return { unreadCount: await notificationRepository.unreadCount(recipientId) };
  }

  /**
   * Marks one notification read. The repository scopes the update by
   * `recipientId`, so another user's notification simply matches nothing — we
   * then 404 rather than 403, so this cannot be used to probe which ids exist.
   */
  async markRead(
    recipientId: string,
    id: string
  ): Promise<{ unreadCount: number }> {
    const { count } = await notificationRepository.markRead(recipientId, id);

    if (count === 0) {
      // Either it does not exist, belongs to someone else, or was already read.
      // Distinguish only the last case, which is a legitimate no-op.
      const existing = await notificationRepository.findById(id);
      if (!existing || existing.recipientId !== recipientId) {
        throw new AppError('Notification not found', 404, 'NOTIFICATION_NOT_FOUND');
      }
    }

    return this.unreadCount(recipientId);
  }

  async markAllRead(recipientId: string): Promise<{ updated: number; unreadCount: number }> {
    const { count } = await notificationRepository.markAllRead(recipientId);
    return { updated: count, unreadCount: 0 };
  }

  async getPreferences(userId: string): Promise<ResolvedPreferences> {
    const settings = await userRepository.findSettingsByUserId(userId);
    return resolvePreferences(settings?.notificationPreferences ?? null);
  }

  /**
   * Patches preferences. The incoming partial is merged over what is stored, so
   * a client sending only `{ FOLLOW: { email: false } }` does not silently reset
   * every other type to defaults.
   *
   * `input` is the RAW request body. `validateRequest` parses it but discards
   * the result, and Zod objects STRIP unknown keys from their output rather than
   * rejecting them — so a body like `{ FOLLOW: { inApp: false, junk: "..." } }`
   * validates cleanly and, if spread directly, writes `junk` into the JSON
   * column forever. Everything below therefore re-parses and copies only the two
   * known toggles.
   */
  async updatePreferences(
    userId: string,
    input: UpdatePreferencesInput
  ): Promise<ResolvedPreferences> {
    const settings = await userRepository.findSettingsByUserId(userId);
    const storedDelta = notificationPreferencesSchema.safeParse(
      settings?.notificationPreferences ?? {}
    );

    // Merge into the stored DELTA, not the resolved matrix. Persisting the full
    // 7-type matrix would freeze this user's defaults forever: any later change
    // to DEFAULT_PREFERENCES would never reach anyone who had touched settings.
    const delta: Record<string, Record<string, boolean>> = storedDelta.success
      ? (structuredClone(storedDelta.data) as any)
      : {};

    const patch = notificationPreferencesSchema.safeParse(input);
    const clean = patch.success ? patch.data : {};

    for (const [type, toggles] of Object.entries(clean)) {
      if (!(type in DEFAULT_PREFERENCES) || !toggles) continue;
      // Named assignments, not a spread: the stored blob must only ever contain
      // keys this module defines, whatever the client sent.
      const next = { ...(delta[type] ?? {}) };
      if (toggles.inApp !== undefined) next.inApp = toggles.inApp;
      if (toggles.email !== undefined) next.email = toggles.email;
      delta[type] = next;
    }

    const merged = resolvePreferences(delta);

    await userRepository.updateSettings(userId, {
      // Cast: the shape is a validated ResolvedPreferences, but Prisma's Json
      // input type needs a structural index signature that a typed record lacks.
      notificationPreferences: delta as unknown as Prisma.InputJsonObject,
    });

    return merged;
  }

  private toDTO(row: NotificationWithActor): NotificationDTO {
    return {
      id: row.id,
      type: row.type,
      actor: row.actor
        ? {
            id: row.actor.id,
            username: row.actor.username,
            name: row.actor.name,
            avatar: row.actor.avatar,
            isVerified: row.actor.isVerified,
          }
        : null,
      entityType: row.entityType,
      entityId: row.entityId,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      isRead: row.isRead,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }
}

export const notificationService = new NotificationService();
