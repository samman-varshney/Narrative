import { Role } from '@prisma/client';
import {
  assertPermission,
  hasPermission,
  permissionsFor,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
} from '../../auth/permissions';

/**
 * The permission catalogue, asserted directly.
 *
 * This is the file every administrative route and every moderation service
 * defers to, so a mistake here is not a bug in one endpoint — it is the same bug
 * in all of them at once. These tests are deliberately about the SHAPE of the
 * model (nobody is unprivileged by accident, nobody is privileged by accident)
 * rather than about any one endpoint's behaviour.
 */

describe('the role model', () => {
  it('gives a regular user no administrative capability at all', () => {
    expect(ROLE_PERMISSIONS.USER).toEqual([]);
    for (const permission of PERMISSIONS) {
      expect(hasPermission('USER', permission)).toBe(false);
    }
  });

  it('covers every role in the schema', () => {
    // A `Record<Role, ...>` makes this a compile error too; asserting it here
    // catches the case where someone satisfies the type with a placeholder.
    for (const role of Object.values(Role)) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  it('makes an administrator a strict superset of a moderator', () => {
    for (const permission of ROLE_PERMISSIONS.MODERATOR) {
      expect(hasPermission('ADMIN', permission)).toBe(true);
    }
    expect(ROLE_PERMISSIONS.ADMIN.length).toBeGreaterThan(
      ROLE_PERMISSIONS.MODERATOR.length
    );
  });

  it('withholds the three escalation-sensitive permissions from moderators', () => {
    // Each for its own reason — irreversibility, privilege escalation, and
    // changing the rules everyone else enforces. See permissions.ts.
    const adminOnly: Permission[] = [
      'content:delete',
      'users:manage',
      'platform:settings:manage',
    ];

    for (const permission of adminOnly) {
      expect(hasPermission('MODERATOR', permission)).toBe(false);
      expect(hasPermission('ADMIN', permission)).toBe(true);
    }
  });

  it('lets a moderator work the queue and act on content and accounts', () => {
    const expected: Permission[] = [
      'reports:view',
      'reports:review',
      'reports:resolve',
      'content:hide',
      'content:restore',
      'users:suspend',
      'users:unsuspend',
      'moderation:history:view',
    ];

    for (const permission of expected) {
      expect(hasPermission('MODERATOR', permission)).toBe(true);
    }
  });
});

describe('unknown and malformed roles', () => {
  it.each([undefined, '', 'SUPERUSER', 'admin', 'Admin', 'MODERATOR ', '__proto__'])(
    'treats %p as unprivileged',
    (role) => {
      for (const permission of PERMISSIONS) {
        expect(hasPermission(role as string | undefined, permission)).toBe(false);
      }
    }
  );

  it('never matches a role by prefix or case', () => {
    // A decoded JWT carries whatever it carries. Matching loosely here would
    // make "ADMINISTRATOR_TRAINEE" an administrator.
    expect(hasPermission('ADMINISTRATOR', 'users:manage')).toBe(false);
    expect(hasPermission('MOD', 'content:hide')).toBe(false);
  });
});

describe('permissionsFor', () => {
  it('lists what a role holds, and nothing for an unknown one', () => {
    expect(permissionsFor('MODERATOR')).toEqual(ROLE_PERMISSIONS.MODERATOR);
    expect(permissionsFor('WHATEVER')).toEqual([]);
    expect(permissionsFor(undefined)).toEqual([]);
  });

  it('returns a copy, so a caller cannot edit the catalogue', () => {
    const list = permissionsFor('ADMIN');
    list.pop();
    expect(permissionsFor('ADMIN').length).toBe(ROLE_PERMISSIONS.ADMIN.length);
  });
});

describe('assertPermission', () => {
  it('passes silently when the role holds the permission', () => {
    expect(() => assertPermission('MODERATOR', 'content:hide')).not.toThrow();
  });

  it('throws a 403 that does not name the missing permission', () => {
    // Naming it would tell someone probing the API exactly which capability —
    // and therefore which role — to go after.
    try {
      assertPermission('USER', 'users:suspend');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 403, errorCode: 'FORBIDDEN' });
      expect((err as Error).message).not.toContain('users:suspend');
    }
  });
});
