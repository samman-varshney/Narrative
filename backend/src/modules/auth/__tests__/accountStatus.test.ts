import { accountStatusService } from '../accountStatus.service';
import { onUserSuspended, onUserUnsuspended, onUserDeleted } from '../subscribers/auth.subscriber';
import { sessionService } from '../session.service';
import { userRepository } from '../../user/user.repository';
import { redis } from '../../../core/providers/redis';

jest.mock('../../user/user.repository');
jest.mock('../session.service');
jest.mock('../../../core/providers/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

/**
 * Suspension enforcement on already-issued access tokens.
 *
 * An access token is valid for its whole lifetime and nothing consults the
 * database while it is — so without this layer, "suspended" means "suspended in
 * up to fifteen minutes", which is exactly long enough to finish a spam run.
 *
 * The tests below are mostly about FAILURE MODES, because that is where an
 * authorization cache goes wrong: a cache miss must fall back to the database, a
 * Redis outage must degrade rather than decide, and a "not found" must not cost
 * a query every time.
 */

const users = userRepository as jest.Mocked<typeof userRepository>;
const sessions = sessionService as jest.Mocked<typeof sessionService>;
const cache = redis as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  cache.get.mockResolvedValue(null);
  cache.set.mockResolvedValue('OK');
  cache.del.mockResolvedValue(1);
  users.findStatusById.mockResolvedValue({ id: 'u1', status: 'ACTIVE' } as never);
});

describe('reading a status', () => {
  it('serves a warm cache without touching the database', async () => {
    cache.get.mockResolvedValue('SUSPENDED');

    await expect(accountStatusService.getStatus('u1')).resolves.toBe('SUSPENDED');
    expect(users.findStatusById).not.toHaveBeenCalled();
  });

  it('falls back to PostgreSQL on a miss, and warms the cache', async () => {
    users.findStatusById.mockResolvedValue({ id: 'u1', status: 'SUSPENDED' } as never);

    await expect(accountStatusService.getStatus('u1')).resolves.toBe('SUSPENDED');
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('u1'),
      'SUSPENDED',
      'EX',
      expect.any(Number),
      // Short TTL: the write-through on suspension makes enforcement immediate;
      // this is only the backstop for a lost event or a restarted Redis.
    );
  });

  it('reads only the status column, not the whole user row', async () => {
    await accountStatusService.getStatus('u1');
    // `findById` would drag the password hash and the profile across the wire on
    // every guarded write on the platform.
    expect(users.findStatusById).toHaveBeenCalledWith('u1');
  });

  it('caches "no such user", so probing unknown ids is not free', async () => {
    users.findStatusById.mockResolvedValue(null);

    await expect(accountStatusService.getStatus('ghost')).resolves.toBeNull();
    expect(cache.set).toHaveBeenCalledWith(
      expect.any(String),
      'MISSING',
      'EX',
      expect.any(Number)
    );

    cache.get.mockResolvedValue('MISSING');
    jest.clearAllMocks();
    cache.get.mockResolvedValue('MISSING');

    await expect(accountStatusService.getStatus('ghost')).resolves.toBeNull();
    expect(users.findStatusById).not.toHaveBeenCalled();
  });

  it('treats an unrecognised cached value as a miss', async () => {
    cache.get.mockResolvedValue('SOMETHING_ELSE');

    await expect(accountStatusService.getStatus('u1')).resolves.toBe('ACTIVE');
    expect(users.findStatusById).toHaveBeenCalled();
  });
});

describe('when Redis is down', () => {
  it('still answers, from PostgreSQL', async () => {
    cache.get.mockRejectedValue(new Error('connection refused'));
    users.findStatusById.mockResolvedValue({ id: 'u1', status: 'SUSPENDED' } as never);

    await expect(accountStatusService.getStatus('u1')).resolves.toBe('SUSPENDED');
  });

  it('does not fail the request when the cache WRITE fails', async () => {
    cache.set.mockRejectedValue(new Error('connection refused'));
    await expect(accountStatusService.getStatus('u1')).resolves.toBe('ACTIVE');
  });
});

describe('when PostgreSQL is down', () => {
  it('propagates the error rather than assuming the account is fine', async () => {
    // Failing OPEN here would be the same as having no check at all, on exactly
    // the requests where it matters.
    users.findStatusById.mockRejectedValue(new Error('database down'));
    await expect(accountStatusService.getStatus('u1')).rejects.toThrow('database down');
  });
});

describe('the auth subscriber', () => {
  it('primes the cache and revokes sessions on suspension', async () => {
    await onUserSuspended({ userId: 'u1' });

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('u1'),
      'SUSPENDED',
      'EX',
      expect.any(Number)
    );
    expect(sessions.revokeAllSessions).toHaveBeenCalledWith('u1');
  });

  it('still cuts the account off when session revocation fails', async () => {
    sessions.revokeAllSessions.mockRejectedValue(new Error('database down'));

    await expect(onUserSuspended({ userId: 'u1' })).resolves.toBeUndefined();
    // The status cache was primed first, which is what stops the in-flight token.
    expect(cache.set).toHaveBeenCalledWith(
      expect.any(String),
      'SUSPENDED',
      'EX',
      expect.any(Number)
    );
  });

  it('re-enables the account on reinstatement, without restoring sessions', async () => {
    await onUserUnsuspended({ userId: 'u1' });

    expect(cache.set).toHaveBeenCalledWith(
      expect.any(String),
      'ACTIVE',
      'EX',
      expect.any(Number)
    );
    // Sessions were deleted; un-deleting a credential is not a thing. They sign
    // in again, which is the correct outcome.
    expect(sessions.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('closes the same window for a deleted account', async () => {
    await onUserDeleted({ userId: 'u1' });

    expect(cache.set).toHaveBeenCalledWith(
      expect.any(String),
      'DELETED',
      'EX',
      expect.any(Number)
    );
    expect(sessions.revokeAllSessions).toHaveBeenCalledWith('u1');
  });

  it('ignores a payload with no user', async () => {
    await onUserSuspended({});
    expect(sessions.revokeAllSessions).not.toHaveBeenCalled();
  });
});
