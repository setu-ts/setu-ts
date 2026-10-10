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
  IPasskeyStore,
  IRefreshTokenRotation,
  ISamlRequestStore,
  IssuerAlgorithm,
  IssuerKeySource,
  ITotpStore,
  MemorySamlRequestStoreOptions,
  MfaOptions,
  OAuth2Provider,
  OidcProvider,
  PasskeyOptions,
  PasskeyRegistrationContext,
  PasskeySaveOptions,
  PasskeySaveResult,
  ProviderTokens,
  RecoveryVerifyResult,
  RefreshPrincipal,
  ReserveAttemptResult,
  SamlModule,
  SamlPendingRequest,
  SamlProfile,
  SamlProvider,
  SessionAuthOptions,
  SignInConfig,
  SignInProvider,
  SignInProviderBase,
  StoredPasskey,
  TokenEndpointAuth,
  TotpCompleteSignInResult,
  TotpEnrolment,
  TotpServiceOptions,
  TotpVerifyResult,
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
    const http: IAuthHttp = {
      get: () => Promise.resolve({ status: 200, body: '{}' }),
      // A key-set/discovery seam never posts; failing loudly here means a later
      // change that starts posting cannot hide inside this test.
      post: () => Promise.reject(new Error('post is not expected by this fixture')),
    };
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

    // requireMfa (M100d) is a guard factory like the rest; its behaviour is
    // covered by test/integration/require-mfa.test.ts.
    expect(auth.requireMfa).toBeDefined();
    expect(typeof auth.requireMfa).toBe('function');
  });

  it('exports stores', () => {
    expect(auth.MemoryAccessTokenRevocationStore).toBeDefined();
    expect(auth.MemoryRefreshTokenStore).toBeDefined();
    expect(auth.MemoryRateLimitStore).toBeDefined();
    expect(auth.RedisRateLimitStore).toBeDefined();
    // MemoryTotpStore (M100d) takes no arguments: it needs no clock, because
    // callers pass `now` to reserveAttempt.
    expect(auth.MemoryTotpStore).toBeDefined();
    expect(auth.MemoryTotpStore.length).toBe(0);
    // MemoryPasskeyStore (M100e) likewise takes no arguments.
    expect(auth.MemoryPasskeyStore).toBeDefined();
    expect(auth.MemoryPasskeyStore.length).toBe(0);
  });

  it('exports the M100e passkey types (declared against the barrel)', () => {
    // Compile-time: each M100e type resolves from the barrel. Dropping a
    // re-export stops this file compiling.
    const store: IPasskeyStore = new auth.MemoryPasskeyStore();
    const credential: StoredPasskey = {
      id: 'cred-1',
      principalId: 'alice',
      userHandle: 'handle',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      algorithm: -7,
      counter: 0,
      backedUp: false,
      transports: ['internal'],
      attestation: 'unverified',
      createdAt: 0,
    };
    const options: PasskeyOptions = {
      rpId: 'localhost',
      rpName: 'Test',
      origins: ['https://localhost'],
      store,
      resolvePrincipal: () => Promise.resolve(null),
    };
    expect(credential.attestation).toBe('unverified');
    expect(options.rpId).toBe('localhost');
    expect('userVerification' in options).toBe(false);
    const context: PasskeyRegistrationContext = {
      principal: { id: 'alice' },
      methods: ['pwd'],
      credentialCount: 0,
    };
    expect(context.credentialCount).toBe(0);
    const saveOptions: PasskeySaveOptions = { maxPerPrincipal: 16 };
    const saveResult: PasskeySaveResult = 'limit';
    expect([saveOptions.maxPerPrincipal, saveResult]).toEqual([16, 'limit']);
  });

  it('exports TotpService and the M100d MFA types (declared against the barrel)', () => {
    expect(auth.TotpService).toBeDefined();
    expect(typeof auth.TotpService).toBe('function');
    // Compile-time: each M100d type resolves from the barrel. Dropping a
    // re-export stops this file compiling.
    const store: ITotpStore = new auth.MemoryTotpStore();
    const enrolment: TotpEnrolment = {
      secret: 'AAA',
      label: 'alice',
      confirmed: false,
      lastClaimedStep: 0,
    };
    const reserved: ReserveAttemptResult = { allowed: true, count: 1 };
    const options: TotpServiceOptions = {
      store,
      runtime: undefined as unknown as TotpServiceOptions['runtime'],
      issuer: 'Test',
    };
    const mfa: MfaOptions = { required: () => true };
    const verified: TotpVerifyResult = 'not-enrolled';
    const recovery: RecoveryVerifyResult = 'invalid';
    const completed: TotpCompleteSignInResult = 'no-pending';
    expect(options.issuer).toBe('Test');
    expect(mfa.required({ id: 'u1' }, ['pwd'])).toBe(true);
    expect([enrolment.secret, reserved.count, verified, recovery, completed].length).toBe(5);
    // TotpServiceOptions carries no pendingTtlMs: `signIn.mfa.pendingTtlMs` is
    // the only owner of that TTL, so the property must not exist.
    expect('pendingTtlMs' in options).toBe(false);
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

  it('exports the M100c sign-in types and keeps the flow internal', () => {
    // Compile-time: every sign-in type resolves from the barrel. Dropping a
    // re-export stops this file compiling.
    const auth_: TokenEndpointAuth = 'none';
    const base: Omit<SignInProviderBase, 'toPrincipal'> = {
      name: 'idp',
      clientId: 'c',
      redirectUri: 'https://app.test/auth/idp/callback',
      tokenEndpointAuth: auth_,
    };
    const oidc: OidcProvider = {
      ...base,
      kind: 'oidc',
      issuer: 'https://idp.test',
      toPrincipal: () => null,
    };
    const oauth2: OAuth2Provider = {
      ...base,
      name: 'gh',
      redirectUri: 'https://app.test/auth/gh/callback',
      kind: 'oauth2',
      authorizationEndpoint: 'https://gh.test/a',
      tokenEndpoint: 'https://gh.test/t',
      userinfoEndpoint: 'https://gh.test/u',
      toPrincipal: () => null,
    };
    const providers: SignInProvider[] = [oidc, oauth2];
    const refreshPrincipal: RefreshPrincipal = (stored) => stored;
    const config: SignInConfig = { providers, refreshPrincipal };
    const tokens: ProviderTokens = { accessToken: 'a' };
    expect(config.providers.length).toBe(2);
    expect(tokens.accessToken).toBe('a');
    const barrel = auth as Record<string, unknown>;
    for (
      const internal of [
        'AuthSessionService',
        'AuthSessionStrategy',
        'compileSignIn',
        'registerSignInRoutes',
        'exchangeCode',
      ]
    ) {
      expect(barrel[internal]).toBeUndefined();
    }
  });

  it('exports the M100f SAML surface (declared against the barrel)', () => {
    // Compile-time: each M100f type resolves from the barrel.
    const options: MemorySamlRequestStoreOptions = {
      maxPendingRequests: auth.DEFAULT_MAX_PENDING_SAML_REQUESTS,
    };
    const store: ISamlRequestStore = new auth.MemorySamlRequestStore(options);
    const pending: SamlPendingRequest | null = null;
    const profile: SamlProfile | null = null;
    const module: SamlModule | null = null;
    const provider: SamlProvider | null = null;
    expect([pending, profile, module, provider]).toEqual([null, null, null, null]);
    expect(store).toBeInstanceOf(auth.MemorySamlRequestStore);
    expect(auth.DEFAULT_MAX_PENDING_SAML_REQUESTS).toBe(10_000);
    expect(new auth.SamlRuntimeLoadError('npm:x')).toBeInstanceOf(Error);
    for (
      const internal of ['registerSamlRoutes', 'loadSaml', 'describeError', 'compileSamlProvider']
    ) {
      expect((auth as Record<string, unknown>)[internal]).toBeUndefined();
    }
  });

  it('does not export internal implementations', () => {
    // JwtService, AuthService, RbacService, JwtStrategy, ApiKeyStrategy,
    // SessionStrategy, LocalStrategy, parseDuration, loadIoredis,
    // validateClient should NOT be exported. SessionStrategy (M73) is
    // configured through AuthPluginOptions.session; the option is the
    // configuration surface, so the class has no consumer beyond its own
    // test — the same reason JwtStrategy and ApiKeyStrategy are unexported.
    // promotePending (M100d) is the internal promotion of a pending MFA
    // sign-in; only TotpService completes a pending record, so the
    // function has no consumer beyond its own test.
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
      'promotePending',
    ];
    for (const name of internals) {
      expect(auth[name as keyof typeof auth]).toBeUndefined();
    }
  });
});

describe('@setu-ts/auth-plugin barrel — authorization policies (M110a)', () => {
  it('exports the policy entry points and errors', () => {
    expect(typeof auth.definePolicy).toBe('function');
    expect(typeof auth.requirePolicy).toBe('function');
    expect(new auth.UnknownPolicyError('doc')).toBeInstanceOf(Error);
    const denied = new auth.AuthorizationDeniedError('insufficient-privileges', 'doc', 'edit');
    const failure: auth.PolicyDenial = denied.failure;
    expect(failure).toBe('insufficient-privileges');
  });

  it('re-exports IAuthorizationPolicyService and accepts policies in AuthPluginOptions', () => {
    const policy = auth.definePolicy({ name: 'doc', abilities: { edit: () => true } });
    const options: AuthPluginOptions = { jwt: { secret: 'x'.repeat(40) }, policies: [policy] };
    const describeOnly: Pick<auth.IAuthorizationPolicyService, 'describe'> = {
      describe: () => ({ anonymous: false }),
    };
    expect(options.policies).toHaveLength(1);
    expect(describeOnly.describe('doc', 'edit')).toEqual({ anonymous: false });
  });

  it('keeps the internals off the barrel', () => {
    const names = Object.keys(auth);
    for (
      const internal of [
        'PolicyService',
        'validatePolicyDefinition',
        'policyGuardOf',
        'scanPolicyGuards',
        'isAnonymousAbility',
      ]
    ) {
      expect(names).not.toContain(internal);
    }
  });
});

describe('scoped RBAC exports (M110b)', () => {
  it('exports the guards, the error and the option types', () => {
    expect(typeof auth.requireScopedRole).toBe('function');
    expect(typeof auth.requireScopedPermission).toBe('function');
    expect(new auth.GrantResolutionError('source-failed').name).toBe('GrantResolutionError');
    const grant: auth.StaticGrant = { subject: 'u', role: 'viewer', scope: null };
    const limit: auth.ScopedRoleLimit = { scopeTypes: ['tenant'] };
    const mapper: auth.ClaimsGrantMapper = () => [];
    const timing: auth.ScopedRbacTiming = { kind: 'cache', ttlMs: 1_000, maxEntries: 1 };
    const source: auth.GrantSourceConfig = { kind: 'static', grants: [grant] };
    const options: auth.ScopedRbacOptions = {
      sources: [source, { kind: 'claims', map: mapper }],
      grantableIn: { viewer: limit },
      timing,
    };
    const guard: auth.ScopedGuardOptions = { scope: null };
    const reason: auth.GrantResolutionReason = 'grant-limit';
    // @ts-expect-error -- only the three source-resolution reasons reach sign-in
    const wrong: auth.GrantResolutionReason = 'scope-cycle';
    expect([options.sources.length, guard.scope, reason, wrong]).toEqual([
      2,
      null,
      'grant-limit',
      'scope-cycle',
    ]);
  });

  it('keeps the scoped internals off the barrel', () => {
    for (
      const internal of [
        'compileScopedRbac',
        'createScopedRbac',
        'ScopedEvaluator',
        'GrantResolver',
        'brandPolicyGuard',
        'walkScopeChain',
      ]
    ) {
      expect(Object.hasOwn(auth, internal)).toBe(false);
    }
  });
});
