import { eventBus, EVENTS } from '../../../core/events/eventBus';
import { logger } from '../../../core/utils/logger';
import { accountStatusService } from '../accountStatus.service';
import { sessionService } from '../session.service';

/**
 * Auth's reaction to account-status facts.
 *
 * This is the ENFORCEMENT half of suspension, and it lives here rather than in
 * the Moderation module on purpose: revoking sessions and invalidating a cached
 * status are auth concerns, and moderation has no business knowing that either
 * mechanism exists. Auth subscribes to a fact ("this account is suspended"), the
 * same way Feed and Search subscribe to facts about blogs.
 *
 * The dependency direction is what matters. Nothing here imports the Moderation
 * module; the events are declared in `core/events`, and a suspension applied by
 * a future admin CLI, a support tool or a database console (followed by an emit)
 * would be enforced identically.
 *
 * ── Two mechanisms, because there are two kinds of credential ───────────────
 *   refresh tokens  are rows. Deleting the sessions makes them unusable
 *                   immediately and permanently — the account cannot mint a new
 *                   access token.
 *   access tokens   are signed and stateless; they cannot be recalled. The
 *                   status cache is what makes `requireActiveAccount` reject
 *                   them on the very next request instead of after their TTL.
 *
 * Without BOTH, suspension leaks: sessions alone leave the current access token
 * working for its remaining lifetime, and the cache alone lets the abuser
 * refresh into a fresh one the moment... well, it does not — `refreshTokens`
 * already refuses a non-ACTIVE user — but it leaves rows behind that would
 * spring back to life the instant the suspension is lifted, which is not what
 * "log out everywhere" means.
 */

interface UserStatusPayload {
  userId?: string;
}

/**
 * Suspension: cut the account off now.
 *
 * Order is deliberate. The status cache is primed FIRST, because that is what
 * stops the in-flight access token, and it is the cheap operation. Session
 * revocation follows; if it fails, the account still cannot act, and the next
 * refresh attempt is refused by `authService.refreshTokens` reading the
 * database anyway.
 */
export async function onUserSuspended(payload: UserStatusPayload): Promise<void> {
  const userId = payload?.userId;
  if (!userId) return;

  await accountStatusService.prime(userId, 'SUSPENDED');

  try {
    await sessionService.revokeAllSessions(userId);
  } catch (err) {
    logger.error({ err, userId }, 'auth: failed to revoke sessions for a suspended account');
  }
}

/**
 * Reinstatement: let the account act again.
 *
 * Sessions are NOT restored — they were deleted, and un-deleting a credential is
 * not a thing. The user signs in again, which is the correct outcome: a
 * suspension that ends with the abuser's old sessions still live would defeat
 * the revocation above.
 */
export async function onUserUnsuspended(payload: UserStatusPayload): Promise<void> {
  const userId = payload?.userId;
  if (!userId) return;

  await accountStatusService.prime(userId, 'ACTIVE');
}

/**
 * Account deletion. Auth already refuses a login and a refresh for a DELETED
 * user; this closes the same access-token window suspension has, and drops the
 * sessions so nothing lingers.
 */
export async function onUserDeleted(payload: UserStatusPayload): Promise<void> {
  const userId = payload?.userId;
  if (!userId) return;

  await accountStatusService.prime(userId, 'DELETED');

  try {
    await sessionService.revokeAllSessions(userId);
  } catch (err) {
    logger.error({ err, userId }, 'auth: failed to revoke sessions for a deleted account');
  }
}

/**
 * Self-deactivation: cut the account off the same way a suspension does.
 *
 * Identical mechanics to `onUserSuspended`, and kept as a separate handler
 * rather than aliased to it, because these two events differ in what they are
 * ALLOWED to grow into. Suspension already carries an actor and a reason and
 * will accumulate moderation-shaped behaviour; deactivation must not inherit
 * any of it by having been wired to the same function on a day when the bodies
 * happened to match.
 *
 * Session revocation is what makes the exit real: leaving them alive would let
 * the account keep refreshing into fresh access tokens, and "deactivated" would
 * mean nothing more than a hidden profile. It is also what forces reactivation
 * through `login`, which is the only place a password is checked.
 */
export async function onUserDeactivated(payload: UserStatusPayload): Promise<void> {
  const userId = payload?.userId;
  if (!userId) return;

  await accountStatusService.prime(userId, 'DEACTIVATED');

  try {
    await sessionService.revokeAllSessions(userId);
  } catch (err) {
    logger.error({ err, userId }, 'auth: failed to revoke sessions for a deactivated account');
  }
}

/**
 * Reactivation. Only the status cache to repair — the login that triggered this
 * mints its own session, and the revoked ones stay revoked for the same reason
 * they do after a suspension is lifted.
 */
export async function onUserReactivated(payload: UserStatusPayload): Promise<void> {
  const userId = payload?.userId;
  if (!userId) return;

  await accountStatusService.prime(userId, 'ACTIVE');
}

export function registerAuthSubscriber(): void {
  eventBus.on(EVENTS.USER_SUSPENDED, onUserSuspended);
  eventBus.on(EVENTS.USER_UNSUSPENDED, onUserUnsuspended);
  eventBus.on(EVENTS.USER_DELETED, onUserDeleted);
  eventBus.on(EVENTS.USER_DEACTIVATED, onUserDeactivated);
  eventBus.on(EVENTS.USER_REACTIVATED, onUserReactivated);
}
