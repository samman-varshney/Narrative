import { accountStatusService } from '../modules/auth/accountStatus.service';
import type { UserStatus } from '@prisma/client';

/**
 * Test seam for the account-status guard.
 *
 * `requireActiveAccount` protects every write route by asking whether the
 * caller's account is still in good standing, which means a database lookup
 * (cached in Redis) for a user id. Route-level integration tests mint a token
 * for a fictional user id and mock the service under test — there is no such row
 * to find — so without this every one of them would 401 on a guard that is not
 * what they are testing.
 *
 * Suites that DO exercise suspension call `stubAccountStatus('SUSPENDED')`
 * instead, or use real users through `src/test/db.ts`.
 */
export function stubAccountStatus(status: UserStatus | null = 'ACTIVE') {
  return jest.spyOn(accountStatusService, 'getStatus').mockResolvedValue(status);
}

/** The common case: every caller in this suite is an active account. */
export function allowActiveAccounts() {
  return stubAccountStatus('ACTIVE');
}
