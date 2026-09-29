/**
 * Tests for AuthPlugin factory.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthPlugin } from '../../src/plugin/auth-plugin.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type {
  IAuthorizationDiagnosticsSource,
  IAuthService,
  IAuthStrategy,
  IJwtService,
  IPluginContext,
  IPrincipal,
  IRequest,
  ISessionService,
  MiddlewareFunction,
  MiddlewareOptions,
  SessionView,
} from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../../src/errors.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import manifest from '../../deno.json' with { type: 'json' };

/**
 * Creates a fake plugin context for testing AuthPlugin.
 */
function createFakeContext(): {
  ctx: IPluginContext;
  onCloseHandlers: Array<() => Promise<void>>;
  registered: Map<string, unknown>;
  middlewareAdded: Array<{ fn: MiddlewareFunction; options?: MiddlewareOptions }>;
} {
  const registered = new Map<string, unknown>();
  const onCloseHandlers: Array<() => Promise<void>> = [];
  const middlewareAdded: Array<{ fn: MiddlewareFunction; options?: MiddlewareOptions }> = [];

  const runtime = createFakeRuntime();

  const ctx: IPluginContext = {
    services: {
      has: (token: string) => registered.has(token),
      get: <T>(token: string): T => {
        if (token === 'runtime') {
          return runtime as T;
        }
        return registered.get(token) as T;
      },
      getAll: <T>(_token: string): readonly T[] => [],
      register: (token: string, svc: unknown) => {
        registered.set(token, svc);
      },
      registerFactory: () => {},
      unregister: () => false,
    },
    middleware: {
      add: (fn, options) => {
        middlewareAdded.push(options === undefined ? { fn } : { fn, options });
      },
    },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    environment: {
      validate: () => {},
    },
    health: {
      register: () => {},
    },
    metrics: {
      register: () => {},
    },
    openapi: {
      addSchema: () => {},
    },
    decorators: {
      register: () => {},
    },
    cli: {
      register: () => {},
    },
    lifecycle: {
      onClose: (fn: () => Promise<void>) => {
        onCloseHandlers.push(fn);
      },
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onStopping: () => {},
      onShutdown: () => {},
    },
    runtime,
    options: {},
    app: null as unknown as IPluginContext['app'],
  };

  return { ctx, onCloseHandlers, registered, middlewareAdded };
}

describe('AuthPlugin', () => {
  it('supports API-key authentication without JWT', async () => {
    const plugin = AuthPlugin({ apiKey: { validate: () => Promise.resolve(null) } });
    const { ctx, registered } = createFakeContext();

    await plugin.register!(ctx);

    expect(plugin.provides).not.toContain(CAPABILITIES.JWT);
    expect(registered.has(CAPABILITIES.JWT)).toBe(false);
    expect(registered.has(CAPABILITIES.AUTH)).toBe(true);
  });

  it('refuses an empty passive strategy chain and names every configuration arm', () => {
    const plugin = AuthPlugin({});
    const { ctx } = createFakeContext();

    expect(() => plugin.register!(ctx)).toThrow(AuthPluginConfigurationError);
    for (const arm of ['jwt', 'apiKey', 'session', 'strategies']) {
      expect(() => plugin.register!(ctx)).toThrow(arm);
    }
  });

  it('refuses local-only configuration because local cannot authenticate a request', () => {
    const plugin = AuthPlugin({ local: { verify: () => Promise.resolve(null) } });
    const { ctx } = createFakeContext();

    expect(() => plugin.register!(ctx)).toThrow(AuthPluginConfigurationError);
  });

  it('registers global authentication middleware at priority 300 by default', async () => {
    const plugin = AuthPlugin({ apiKey: { validate: () => Promise.resolve(null) } });
    const { ctx, middlewareAdded } = createFakeContext();

    await plugin.register!(ctx);

    expect(middlewareAdded).toHaveLength(1);
    expect(middlewareAdded[0]?.options).toEqual({ name: 'auth', priority: 300 });
  });

  it('moves or disables global authentication middleware when configured', async () => {
    const moved = AuthPlugin({
      apiKey: { validate: () => Promise.resolve(null) },
      middleware: { priority: 425 },
    });
    const movedContext = createFakeContext();
    await moved.register!(movedContext.ctx);
    expect(movedContext.middlewareAdded[0]?.options?.priority).toBe(425);

    const disabled = AuthPlugin({
      apiKey: { validate: () => Promise.resolve(null) },
      middleware: false,
    });
    const disabledContext = createFakeContext();
    await disabled.register!(disabledContext.ctx);
    expect(disabledContext.middlewareAdded).toHaveLength(0);
  });

  it('refuses non-integer middleware priorities at construction', () => {
    for (const priority of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() =>
        AuthPlugin({
          apiKey: { validate: () => Promise.resolve(null) },
          middleware: { priority },
        })
      ).toThrow(AuthPluginConfigurationError);
    }
  });

  it('supports JWT-only registration without an RBAC configuration', async () => {
    const plugin = AuthPlugin({ jwt: { secret: 'test-secret' } });
    const { ctx, registered } = createFakeContext();

    await plugin.register!(ctx);

    expect(plugin.provides).toEqual([
      CAPABILITIES.JWT,
      CAPABILITIES.AUTH,
      CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
    ]);
    expect(registered.has(CAPABILITIES.JWT)).toBe(true);
    expect(registered.has(CAPABILITIES.AUTH)).toBe(true);
    expect(registered.has(CAPABILITIES.AUTHORIZATION)).toBe(false);
    // The authorization-diagnostics source is always registered, even without
    // RBAC — without the observation option it answers `disabled`.
    expect(registered.has(CAPABILITIES.AUTHORIZATION_DIAGNOSTICS)).toBe(true);
    const source = registered.get(
      CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
    ) as IAuthorizationDiagnosticsSource;
    expect(source.read('instance', 0).state).toBe('disabled');
  });

  it('answers unsupported (rbac-not-configured) when the option is present without RBAC', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      authorizationDiagnostics: { enabled: true, roles: {}, permissions: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    const source = registered.get(
      CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
    ) as IAuthorizationDiagnosticsSource;
    const batch = source.read('instance', 0);
    expect(batch.state).toBe('unsupported');
    expect(batch.coverage).toBe('rbac-not-configured');
  });

  it('refuses a malformed authorizationDiagnostics option at construction, with or without RBAC', () => {
    const malformed = { enabled: false, roles: {}, permissions: {} };
    expect(() =>
      AuthPlugin({ jwt: { secret: 'test-secret' }, authorizationDiagnostics: malformed })
    )
      .toThrow('Authorization diagnostics: enabled must be the literal true.');
    expect(() =>
      AuthPlugin({
        jwt: { secret: 'test-secret' },
        rbac: { roles: {} },
        authorizationDiagnostics: malformed,
      })
    ).toThrow('Authorization diagnostics: enabled must be the literal true.');
  });

  it('returns a plugin with correct name and version', () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    expect(plugin.name).toBe('auth-plugin');
    expect(plugin.version).toBe(manifest.version);
  });

  it('lists the three capability tokens in provides', () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    expect(plugin.provides).toContain(CAPABILITIES.JWT);
    expect(plugin.provides).toContain(CAPABILITIES.AUTH);
    expect(plugin.provides).toContain(CAPABILITIES.AUTHORIZATION);
  });

  it('has NORMAL priority', () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });

  it('throws when jwt.secret and jwt keys are both missing', () => {
    expect(() =>
      AuthPlugin({
        jwt: {},
        rbac: { roles: {} },
      })
    ).toThrow();
  });

  it('registers IJwtService under jwt token', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.JWT)).toBe(true);
  });

  it('registers IAuthService under authentication token', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.AUTH)).toBe(true);
  });

  it('registers IAuthorizationService under authorization token', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.AUTHORIZATION)).toBe(true);
  });

  it('onClose handlers run without error', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    const { ctx, onCloseHandlers } = createFakeContext();
    await plugin.register!(ctx);
    expect(onCloseHandlers.length).toBeGreaterThan(0);
    for (const handler of onCloseHandlers) {
      await handler();
    }
  });

  it('builds with HS256 when secret is provided', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'my-secret-key' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.JWT)).toBe(true);
  });

  it('builds with RS256 when keys are provided', async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );

    const [spki, pkcs8] = await Promise.all([
      crypto.subtle.exportKey('spki', keyPair.publicKey),
      crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    ]);

    const publicKeyPem = formatPem(new Uint8Array(spki), 'PUBLIC KEY');
    const privateKeyPem = formatPem(new Uint8Array(pkcs8), 'PRIVATE KEY');

    const plugin = AuthPlugin({
      jwt: { privateKey: privateKeyPem, publicKey: publicKeyPem },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.JWT)).toBe(true);
  });

  it('includes apiKey strategy when configured', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      apiKey: {
        validate: () => Promise.resolve(null as IPrincipal | null),
      },
      rbac: { roles: {} },
    });
    const { ctx } = createFakeContext();
    await plugin.register!(ctx);
    // Should not throw
  });

  it('includes local strategy when configured', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      local: {
        verify: () => Promise.resolve(null as IPrincipal | null),
      },
      rbac: { roles: {} },
    });
    const { ctx } = createFakeContext();
    await plugin.register!(ctx);
    // Should not throw
  });

  it('uses the default (always-null) local strategy when local is not configured', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    const authService = registered.get(CAPABILITIES.AUTH) as IAuthService;
    // Exercises the default local fallback (`() => Promise.resolve(null)`).
    const result = await authService.verifyCredentials({ identifier: 'x', secret: 'y' });
    expect(result).toBeNull();
  });

  it('registers with jwt.audience option set', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret', audience: 'my-audience' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.JWT)).toBe(true);
  });

  it('registers with jwt.issuer option set', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret', issuer: 'my-issuer' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.JWT)).toBe(true);
  });

  it('registers with apiKey.header option set', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      apiKey: {
        header: 'x-api-key',
        validate: () => Promise.resolve(null as IPrincipal | null),
      },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);
    expect(registered.has(CAPABILITIES.AUTH)).toBe(true);
  });

  it('forwards jwt.header and jwt.scheme to the JWT strategy', async () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret', header: 'x-auth-token', scheme: 'token' },
      rbac: { roles: {} },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register!(ctx);

    const jwt = registered.get(CAPABILITIES.JWT) as IJwtService;
    const auth = registered.get(CAPABILITIES.AUTH) as IAuthService;
    const token = await jwt.sign({ sub: 'carol' });

    const viaConfigured = await auth.authenticate(
      makeRequest({ 'x-auth-token': `Token ${token}` }),
    );
    expect(viaConfigured).not.toBeNull();
    expect(viaConfigured!.id).toBe('carol');

    // The default header must NOT authenticate once a custom one is configured.
    const viaDefault = await auth.authenticate(
      makeRequest({ authorization: `Bearer ${token}` }),
    );
    expect(viaDefault).toBeNull();
  });
});

describe('AuthPlugin — session strategy and caller strategies (M73)', () => {
  it('declares the session capability as an optional dependency', () => {
    const plugin = AuthPlugin({ jwt: { secret: 'test-secret' } });
    expect(plugin.optionalDependencies).toContain(CAPABILITIES.SESSION);
  });

  it('throws at register() when options.session is set but the session capability is absent', () => {
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      session: { toPrincipal: () => null },
    });
    const { ctx } = createFakeContext();
    // register() is synchronous, so the throw is a sync throw — wrap it.
    expect(() => plugin.register!(ctx)).toThrow('auth-plugin');
    expect(() => plugin.register!(ctx)).toThrow('options.session');
    expect(() => plugin.register!(ctx)).toThrow('session-plugin');
  });

  it('registers the session strategy when the session capability is present', async () => {
    const { ctx, registered } = createFakeContext();
    // Simulate SessionPlugin having registered its service under the token.
    registered.set(CAPABILITIES.SESSION, fakeSessionService({ id: 's1', data: { uid: 'u1' } }));
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      session: { toPrincipal: (view) => ({ id: String(view.data.uid) }) },
    });
    await plugin.register!(ctx);
    const auth = registered.get(CAPABILITIES.AUTH) as IAuthService;
    const principal = await auth.authenticate(makeRequest({ cookie: 'sid=s1' }));
    expect(principal).toEqual({ id: 'u1' });
  });

  it('prefers the jwt principal over the session principal (jwt → api-key → session order)', async () => {
    const { ctx, registered } = createFakeContext();
    registered.set(
      CAPABILITIES.SESSION,
      fakeSessionService({ id: 's1', data: { uid: 'session-user' } }),
    );
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      session: { toPrincipal: (view) => ({ id: String(view.data.uid) }) },
    });
    await plugin.register!(ctx);
    const jwt = registered.get(CAPABILITIES.JWT) as IJwtService;
    const auth = registered.get(CAPABILITIES.AUTH) as IAuthService;
    const token = await jwt.sign({ sub: 'jwt-user' });
    // A request satisfying BOTH jwt and session must authenticate as jwt.
    const principal = await auth.authenticate(
      makeRequest({ authorization: `Bearer ${token}`, cookie: 'sid=s1' }),
    );
    expect(principal).toEqual({ id: 'jwt-user' });
  });

  it('appends caller strategies after the built-ins, in declaration order', async () => {
    const { ctx, registered } = createFakeContext();
    const seen: string[] = [];
    const first: IAuthStrategy = {
      name: 'custom-a',
      authenticate: () => {
        seen.push('custom-a');
        return Promise.resolve(null);
      },
    };
    const second: IAuthStrategy = {
      name: 'custom-b',
      authenticate: () => {
        seen.push('custom-b');
        return Promise.resolve({ id: 'from-custom-b' });
      },
    };
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      strategies: [first, second],
    });
    await plugin.register!(ctx);
    const auth = registered.get(CAPABILITIES.AUTH) as IAuthService;
    const principal = await auth.authenticate(makeRequest({}));
    expect(principal).toEqual({ id: 'from-custom-b' });
    // jwt (no header → null) ran first, then the caller strategies in the
    // order they were declared.
    expect(seen).toEqual(['custom-a', 'custom-b']);
  });

  it('throws at register() when a caller strategy reuses a built-in name', () => {
    const { ctx } = createFakeContext();
    const duplicate: IAuthStrategy = {
      name: 'jwt',
      authenticate: () => Promise.resolve(null),
    };
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      strategies: [duplicate],
    });
    expect(() => plugin.register!(ctx)).toThrow("duplicate strategy name 'jwt'");
  });

  it('throws at register() when two caller strategies share a name', () => {
    const { ctx } = createFakeContext();
    const a: IAuthStrategy = {
      name: 'custom',
      authenticate: () => Promise.resolve(null),
    };
    const b: IAuthStrategy = {
      name: 'custom',
      authenticate: () => Promise.resolve(null),
    };
    const plugin = AuthPlugin({
      jwt: { secret: 'test-secret' },
      strategies: [a, b],
    });
    expect(() => plugin.register!(ctx)).toThrow("duplicate strategy name 'custom'");
  });

  it('leaves the chain unchanged when neither session nor strategies is configured', async () => {
    const { ctx, registered } = createFakeContext();
    const plugin = AuthPlugin({ jwt: { secret: 'test-secret' } });
    await plugin.register!(ctx);
    const jwt = registered.get(CAPABILITIES.JWT) as IJwtService;
    const auth = registered.get(CAPABILITIES.AUTH) as IAuthService;
    const token = await jwt.sign({ sub: 'solo' });
    // The jwt strategy still authenticates exactly as before the change.
    const principal = await auth.authenticate(makeRequest({ authorization: `Bearer ${token}` }));
    expect(principal).toEqual({ id: 'solo' });
    // And a request with no credential still resolves to null.
    expect(await auth.authenticate(makeRequest({}))).toBeNull();
  });
});

/**
 * An ISessionService that opens a fixed view from any headers — stands in for
 * the session-plugin's service under CAPABILITIES.SESSION.
 */
function fakeSessionService(view: SessionView): ISessionService {
  return {
    from: () => {
      throw new Error('from() is not used by these tests');
    },
    fromHeaders: () => Promise.resolve(view),
  };
}

/**
 * Build a minimal IRequest carrying the given headers.
 */
function makeRequest(headers: Record<string, string>): IRequest {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    h.set(key, value);
  }
  return {
    method: 'GET',
    url: 'http://localhost/',
    path: '/',
    headers: h,
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
}

/**
 * Format DER bytes as a PEM string.
 */
function formatPem(der: Uint8Array, label: string): string {
  const binary = String.fromCharCode(...der);
  const base64 = btoa(binary);
  const lines: string[] = [`-----BEGIN ${label}-----`];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  lines.push(`-----END ${label}-----`);
  return lines.join('\n');
}
