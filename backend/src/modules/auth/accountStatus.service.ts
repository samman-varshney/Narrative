import { UserStatus } from '@prisma/client';
import { userRepository } from '../user/user.repository';
import { redis } from '../../core/providers/redis';
import { logger } from '../../core/utils/logger';

/**
 * Account-status enforcement for already-issued access tokens.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * Auth already refuses a login and a refresh for a suspended account. Neither
 * helps against the token the abuser is holding right now: an access token is
 * valid for its full lifetime (15 minutes by default) and nothing consults the
 * database while it is. Suspension that takes effect in a quarter of an hour is
 * not suspension — it is exactly long enough to finish a spam run.
 *
 * So a suspended account's status has to be checked ON the request. The
 * alternatives were considered and rejected:
 *
 *   short-lived tokens   makes every user refresh constantly to shorten one
 *                        abuser's window. Wrong trade, applied to everyone.
 *   a JWT denylist       the same Redis lookup this does, but keyed on tokens
 *                        rather than users — so a suspension has to enumerate
 *                        the account's live tokens, which nothing tracks.
 *   status in the token  unfixable: the claim is frozen at mint time, which is
 *                        the very problem.
 *
 * ── PostgreSQL is authoritative, Redis is a cache ───────────────────────────
 * `User.status` is the truth. Redis holds a short-lived copy so the check costs
 * a GET rather than a query on the hot path, and every cache miss reads the
 * database. A Redis outage degrades this to "one indexed primary-key lookup per
 * guarded request" — slower, never wrong. The reverse (trusting Redis when the
 * database says otherwise) is what "do not make Redis the source of truth"
 * forbids, and it is why nothing here writes a status.
 *
 * ── Why the TTL is short AND the cache is written through ───────────────────
 * Suspension primes this cache directly (via the auth subscriber on
 * USER_SUSPENDED), so enforcement is immediate in the normal case. The 60-second
 * TTL is the backstop for the abnormal one: a Redis restart, a lost event, a
 * status changed by a database console. Worst case the platform is one minute
 * behind; typical case, zero.
 */

const CACHE_VERSION = 'v1';
const KEY_PREFIX = `auth:status:${CACHE_VERSION}:`;

/** Short by design — see the note above. */
const TTL_SECONDS = 60;

/** Cached marker for "no such user", so a probe for unknown ids is not free. */
const MISSING = 'MISSING';

const key = (userId: string): string => `${KEY_PREFIX}${userId}`;

const isUserStatus = (value: string): value is UserStatus =>
  value === 'ACTIVE' ||
  value === 'DEACTIVATED' ||
  value === 'SUSPENDED' ||
  value === 'DELETED';

export class AccountStatusService {
  /**
   * The account's current status, or null when the account does not exist.
   *
   * Never throws for a cache problem: Redis failures log and fall through to the
   * database. A database failure DOES propagate — at that point the request
   * cannot be served anyway, and failing open on an authorization check because
   * a query failed is how a suspended account gets a free pass.
   */
  async getStatus(userId: string): Promise<UserStatus | null> {
    const cached = await this.readCache(userId);
    if (cached !== undefined) return cached;

    const user = await userRepository.findStatusById(userId);
    const status = user?.status ?? null;

    await this.writeCache(userId, status);
    return status;
  }

  /** True only for an account that exists and is ACTIVE. */
  async isActive(userId: string): Promise<boolean> {
    return (await this.getStatus(userId)) === 'ACTIVE';
  }

  /**
   * Write-through, called by the auth subscriber when a status change is
   * observed. Makes enforcement immediate instead of TTL-bounded.
   */
  async prime(userId: string, status: UserStatus): Promise<void> {
    await this.writeCache(userId, status);
  }

  /** Drops the cached copy; the next check re-reads PostgreSQL. */
  async invalidate(userId: string): Promise<void> {
    try {
      await redis.del(key(userId));
    } catch (err) {
      logger.warn({ err, userId }, 'auth: failed to invalidate cached account status');
    }
  }

  /**
   * `undefined` = cache miss (ask the database), `null` = cached "no such user",
   * otherwise the cached status. Three outcomes, so a miss and a cached absence
   * are never confused — the bug that would turn every unknown id into a
   * database read forever.
   */
  private async readCache(userId: string): Promise<UserStatus | null | undefined> {
    try {
      const raw = await redis.get(key(userId));
      if (raw === null) return undefined;
      if (raw === MISSING) return null;
      if (isUserStatus(raw)) return raw;
      return undefined; // unrecognised value (an old format): treat as a miss
    } catch (err) {
      logger.warn({ err, userId }, 'auth: account status cache read failed');
      return undefined;
    }
  }

  private async writeCache(userId: string, status: UserStatus | null): Promise<void> {
    try {
      await redis.set(key(userId), status ?? MISSING, 'EX', TTL_SECONDS);
    } catch (err) {
      logger.warn({ err, userId }, 'auth: account status cache write failed');
    }
  }
}

export const accountStatusService = new AccountStatusService();
