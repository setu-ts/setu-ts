import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as auth from '../../src/index.ts';

/**
 * Barrel exports test.
 *
 * Verifies that all expected value exports are present.
 * Types are verified by the type checker (deno check).
 */
describe('barrel exports', () => {
  it('exports the plugin factory', () => {
    expect(auth.AuthPlugin).toBeDefined();
    expect(typeof auth.AuthPlugin).toBe('function');
  });

  it('exports PasswordHasher', () => {
    expect(auth.PasswordHasher).toBeDefined();
    expect(typeof auth.PasswordHasher).toBe('function');
  });

  it('exports authMiddleware', () => {
    expect(auth.authMiddleware).toBeDefined();
    expect(typeof auth.authMiddleware).toBe('function');
  });

  it('exports rateLimitMiddleware', () => {
    expect(auth.rateLimitMiddleware).toBeDefined();
    expect(typeof auth.rateLimitMiddleware).toBe('function');
  });

  it('exports RefreshTokenService', () => {
    expect(auth.RefreshTokenService).toBeDefined();
    expect(typeof auth.RefreshTokenService).toBe('function');
  });

  it('exports guard factories', () => {
    expect(auth.requireAuth).toBeDefined();
    expect(typeof auth.requireAuth).toBe('function');

    expect(auth.requireRole).toBeDefined();
    expect(typeof auth.requireRole).toBe('function');

    expect(auth.requirePermission).toBeDefined();
    expect(typeof auth.requirePermission).toBe('function');

    expect(auth.requireAnyRole).toBeDefined();
    expect(typeof auth.requireAnyRole).toBe('function');

    expect(auth.requireAllPermissions).toBeDefined();
    expect(typeof auth.requireAllPermissions).toBe('function');

    expect(auth.publicRoute).toBeDefined();
    expect(typeof auth.publicRoute).toBe('function');
  });

  it('exports stores', () => {
    expect(auth.MemoryRefreshTokenStore).toBeDefined();
    expect(auth.MemoryRateLimitStore).toBeDefined();
    expect(auth.RedisRateLimitStore).toBeDefined();
  });

  it('type exports', () => {
    // Type exports are verified by deno check - this test just confirms
    // the module can be imported without errors
    expect(auth).toBeDefined();
  });

  it('does not export internal implementations', () => {
    // JwtService, AuthService, RbacService, JwtStrategy, ApiKeyStrategy,
    // LocalStrategy, parseDuration, loadIoredis, validateClient should NOT be exported
    const internals = [
      'JwtService',
      'AuthService',
      'RbacService',
      'JwtStrategy',
      'ApiKeyStrategy',
      'LocalStrategy',
      'parseDuration',
      'loadIoredis',
      'validateClient',
    ];
    for (const name of internals) {
      expect(auth[name as keyof typeof auth]).toBeUndefined();
    }
  });
});
