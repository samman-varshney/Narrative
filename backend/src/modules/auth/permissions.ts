import { Role } from '@prisma/client';
import { AppError } from '../../core/exceptions/AppError';

/**
 * The platform's permission catalogue.
 *
 * This is the AUTHORIZATION half of the existing auth system, not a second one:
 * identity still comes from the JWT that `requireAuth` verifies, and `req.user.role`
 * still comes from that token. What this adds is the mapping from a role to the
 * capabilities it holds, so that no controller, service or route ever names a
 * role again.
 *
 * ── Why a permission and not a role check ───────────────────────────────────
 * `role === 'ADMIN'` scattered through controllers is what makes adding a role
 * a codebase-wide edit — every site has to be found, and the ones that are
 * missed fail open or fail closed at random. With a catalogue, adding a support
 * administrator who may suspend accounts but not delete content is one entry in
 * ROLE_PERMISSIONS and nothing else.
 *
 * ── Granularity ─────────────────────────────────────────────────────────────
 * Permissions are named after the ACTION, never after the surface that happens
 * to expose it today (`content:hide`, not `admin:blogs:hide-button`). A screen
 * can then require several, and an action keeps its permission when it moves.
 *
 * ── The escalation boundary ─────────────────────────────────────────────────
 * A moderator handles the queue and acts on content and accounts. An
 * administrator additionally holds the three permissions that are destructive
 * or self-referential: erasing content outright, managing user accounts (which
 * includes changing roles), and platform settings. That split is the whole
 * reason the two roles exist, and it is expressed here once — see the
 * `MODERATOR_PERMISSIONS` / `ADMIN_ONLY_PERMISSIONS` sets below.
 */

export const PERMISSIONS = [
  // Reports and the moderation queue.
  'reports:view',
  'reports:review',
  'reports:resolve',

  // Content actions.
  'content:hide',
  'content:restore',
  'content:delete',

  // Account actions.
  'users:suspend',
  'users:unsuspend',
  'users:manage',

  // Oversight.
  'moderation:history:view',
  'platform:settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * What a moderator may do: work the queue, and act on content and accounts.
 *
 * Suspension is included deliberately. It is the one action that actually stops
 * an abuser mid-campaign, and a moderation team that has to escalate every
 * account to an administrator is a team that does not stop anything at 3am. It
 * is also fully reversible and fully audited, which is what makes it safe to
 * delegate — unlike the three permissions below.
 */
const MODERATOR_PERMISSIONS: readonly Permission[] = [
  'reports:view',
  'reports:review',
  'reports:resolve',
  'content:hide',
  'content:restore',
  'users:suspend',
  'users:unsuspend',
  'moderation:history:view',
];

/**
 * Administrator-only, and each for its own reason:
 *
 *   content:delete            irreversible from the moderator's side — a hide
 *                             can be undone by whoever disagrees, a deletion
 *                             cannot be undone by anyone.
 *   users:manage              includes changing roles, so granting it to
 *                             moderators would let any moderator make themselves
 *                             an administrator. Privilege escalation in one hop.
 *   platform:settings:manage  changes the rules everyone else is enforcing.
 */
const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  'content:delete',
  'users:manage',
  'platform:settings:manage',
];

/**
 * Role → permissions. The single source of truth for "who may do what".
 *
 * A `Record<Role, ...>` rather than a lookup with a default, so adding a value
 * to the `Role` enum without deciding what it may do is a COMPILE error rather
 * than a role that silently holds nothing (or, far worse, everything).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: [],
  MODERATOR: MODERATOR_PERMISSIONS,
  ADMIN: [...MODERATOR_PERMISSIONS, ...ADMIN_ONLY_PERMISSIONS],
};

/**
 * Memoized as Sets: permission checks run on every administrative request.
 *
 * A `Map`, not a plain object, and that is not a style preference. The lookup
 * key is a role string that arrives from a decoded token, and a plain object
 * would resolve `"__proto__"`, `"constructor"` and `"toString"` to inherited
 * members of `Object.prototype` — turning a nonsense role into a crash (or, with
 * a differently-shaped catalogue, into a match). A Map has no prototype chain to
 * walk, so an unknown key is simply absent.
 */
const PERMISSION_SETS = new Map<string, ReadonlySet<Permission>>(
  Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [role, new Set(perms)])
);

/**
 * Whether a role holds a permission.
 *
 * `role` is typed as a plain string because that is what a decoded JWT carries:
 * a token minted before a role was renamed, or forged with a nonsense role, must
 * resolve to "no permissions" rather than crash or match a partial name. An
 * unknown role is therefore simply unprivileged.
 */
export function hasPermission(role: string | undefined, permission: Permission): boolean {
  if (!role) return false;
  return PERMISSION_SETS.get(role)?.has(permission) ?? false;
}

/** Every permission a role holds. Used by the "who am I" administrative endpoint. */
export function permissionsFor(role: string | undefined): Permission[] {
  if (!role) return [];
  // Reads the same prototype-safe Map as `hasPermission`, so the two can never
  // disagree about what an unrecognised role holds.
  return [...(PERMISSION_SETS.get(role) ?? [])];
}

/**
 * Service-layer guard.
 *
 * Routes are gated by `requirePermission`, but the middleware only protects the
 * HTTP path. A service method is also called by subscribers, workers and tests,
 * and the moderation services are the ones where "somebody forgot the
 * middleware" is a privilege escalation rather than a bug — so the check is
 * repeated at the boundary that actually performs the action. Defence in depth,
 * and the reason the service takes an actor rather than a boolean.
 */
export function assertPermission(role: string | undefined, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    // Deliberately identical in shape to the middleware's rejection, and
    // deliberately vague: naming the missing permission tells an attacker which
    // capability to go looking for.
    throw new AppError('Forbidden: Insufficient permissions', 403, 'FORBIDDEN');
  }
}
