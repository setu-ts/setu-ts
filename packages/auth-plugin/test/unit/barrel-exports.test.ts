import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as auth from '../../src/index.ts';
import type { IPrincipal, SessionView } from '@setu-ts/common';
import type {
  AuthMiddlewareOption,
  AuthorizationDiagnosticsOptions,
  AuthPluginOptions,
  IAuthHttp,
  IAuthorizationDiagnosticsSource,
  IRefreshTokenRotation,
  IssuerAlgorithm,
  IssuerKeySource,
  SessionAuthOptions,
  TrustedIssuer,
} from '../../src/index.ts';

/**
 * Barrel exports test.
 *
 * Verifies that all expected value exports are present.
 * Types are verified by the type checker (deno check).
 */
describe('barrel exports', () => {
  it('exports AuthPluginConfigurationError', () => {
    const error = new auth.AuthPluginConfigurationError('invalid auth configuration');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuthPluginConfigurationError');
  });

  it('exports the JWT-optional middleware option types', () => {
    const middleware: AuthMiddlewareOption = { priority: 300, exclude: ['/health'] };
    const options: AuthPluginOptions = {
      apiKey: { validate: () => Promise.resolve(null) },
      middleware,
    };
    expect(options.jwt).toBeUndefined();
    expect(options.middleware).toBe(middleware);
  });

  it('exports the outside-issuer option types and keeps the verifier internal', () => {
    const algorithm: IssuerAlgorithm = 'EdDSA';
    const keys: IssuerKeySource = { discovery: true };
    const http: IAuthHttp = { get: () => Promise.resolve({ status: 200, body: '{}' }) };
    const issuer: TrustedIssuer = {
      name: 'idp',
      issuer: 'https://idp.test',
      audience: 'api',
      keys,
      algorithms: [algorithm],
      toPrincipal: () => null,
    };
    const options: AuthPluginOptions = { issuers: [issuer], http };
    expect(options.issuers?.[0].keys).toBe(keys);
    const barrel = auth as Record<string, unknown>;
    for (
      const internal of [
        'IssuerStrategy',
        'IssuerKeySet',
        'createDefaultAuthHttp',
        'compileIssuers',
      ]
    ) {
      expect(barrel[internal]).toBeUndefined();
    }
  });

  it('exports the plugin factory', () => {
    expect(auth.AuthPlugin).toBeDefined();
    expect(typeof auth.AuthPlugin).toBe('function');
  });

  it('exports PasswordHasher', () => {
    expect(auth.PasswordHasher).toBeDefined();
    expect(typeof auth.PasswordHasher).toBe('function');
  });

  it('exports MalformedPasswordHashError', () => {
    expect(auth.MalformedPasswordHashError).toBeDefined();
    expect(typeof auth.MalformedPasswordHashError).toBe('function');
    const error = new auth.MalformedPasswordHashError('test');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MalformedPasswordHashError');
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
    expect(auth.MemoryAccessTokenRevocationStore).toBeDefined();
    expect(auth.MemoryRefreshTokenStore).toBeDefined();
    expect(auth.MemoryRateLimitStore).toBeDefined();
    expect(auth.RedisRateLimitStore).toBeDefined();
  });

  it('type exports', () => {
    // Type exports are verified by deno check - this test just confirms
    // the module can be imported without errors
    expect(auth).toBeDefined();
  });

  it('exports the IRefreshTokenRotation type', () => {
    const result: IRefreshTokenRotation = { record: null, rotated: false };
    expect(result.rotated).toBe(false);
  });

  it('exports the SessionAuthOptions type (declared against the barrel)', () => {
    // Compile-time: `SessionAuthOptions` resolves from the barrel and a
    // `toPrincipal` callback is assignable to it (M73). Dropping the
    // re-export stops this file compiling — a type-only export is invisible
    // to every runtime assertion.
    const options: SessionAuthOptions = {
      toPrincipal: (view: SessionView): IPrincipal | null =>
        view.data.uid === undefined ? null : { id: String(view.data.uid) },
    };

    expect(options.toPrincipal({ id: 's1', data: { uid: 'u1' } })).toEqual({ id: 'u1' });
  });

  it('exports the M98h authorization-diagnostics types (declared against the barrel)', () => {
    // Compile-time: `AuthorizationDiagnosticsOptions` and
    // `IAuthorizationDiagnosticsSource` resolve from the barrel. Dropping
    // either re-export stops this file compiling — a type-only export is
    // invisible to every runtime assertion.
    const options: AuthorizationDiagnosticsOptions = {
      enabled: true,
      roles: { admin: 'A' },
      permissions: { 'users:read': 'P' },
    };
    const source: IAuthorizationDiagnosticsSource =
      undefined as unknown as IAuthorizationDiagnosticsSource;
    void source;
    expect(options.enabled).toBe(true);
  });

  it('does not export internal implementations', () => {
    // JwtService, AuthService, RbacService, JwtStrategy, ApiKeyStrategy,
    // SessionStrategy, LocalStrategy, parseDuration, loadIoredis,
    // validateClient should NOT be exported. SessionStrategy (M73) is
    // configured through AuthPluginOptions.session; the option is the
    // configuration surface, so the class has no consumer beyond its own
    // test — the same reason JwtStrategy and ApiKeyStrategy are unexported.
    const internals = [
      'JwtService',
      'AuthService',
      'RbacService',
      'JwtStrategy',
      'ApiKeyStrategy',
      'SessionStrategy',
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
