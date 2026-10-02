/**
 * A real kernel application wired for the passkey ceremonies, with a password
 * login route for the second-factor tests and a one-cookie jar.
 *
 * The application is real: real `SessionPlugin`, real `AuthPlugin` with the
 * `passkeys` option over a `MemoryPasskeyStore`, and the ceremonies driven
 * through `app.fetch` with a virtual authenticator — so a test that passes
 * here has exercised the plugin's real routes and verification path.
 *
 * @module
 */
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthSessionService, IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getCsrfToken, getSession, SessionPlugin } from '@setu-ts/session-plugin';

import { AuthPlugin, MemoryPasskeyStore, requireAuth } from '../../src/index.ts';
import type { IPasskeyStore, PasskeyOptions } from '../../src/index.ts';
import { AUTH_SESSION_KEY } from '../../src/sign-in/auth-session-service.ts';

/** Base URL for `app.fetch` requests (no socket). */
export const BASE = 'http://localhost';
/** The RP ID and origin the tests run against. */
export const RP_ID = 'localhost';
export const ORIGIN = BASE;
/** Session secret (≥32 chars). */
export const SESSION_SECRET = 'passkey-session-secret-at-least-32-characters';

/** A built application and the handles a passkey test needs. */
export interface PasskeyHarness {
  readonly app: IKernelApplication;
  readonly store: IPasskeyStore;
}

/** Options for {@linkcode buildPasskeyApp}. */
export interface BuildPasskeyOptions {
  /** Overrides parts of the passkeys option. */
  readonly passkeys?: Partial<PasskeyOptions>;
  /** The MFA policy the sign-in arm carries; absent means never required. */
  readonly mfaRequired?: (
    principal: { readonly id: string },
    methods: readonly string[],
  ) => boolean | Promise<boolean>;
  /** Overrides parts of the session plugin options (e.g. `csrf`). */
  readonly session?: Record<string, unknown>;
  /** Extra plugins. */
  readonly plugins?: readonly IPlugin[];
  /** The principal `resolvePrincipal` returns; `null` refuses every sign-in. */
  readonly principal?: { readonly id: string; readonly roles?: readonly string[] } | null;
}

/** A single-cookie jar tracking the session cookie across `app.fetch` calls. */
export class CookieJar {
  cookie: string | undefined;

  /** Records the response's `Set-Cookie`, clearing on an expiring one. */
  update(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0];
      this.cookie = /max-age=0/i.test(header) || pair.endsWith('=') ? undefined : pair;
    }
  }

  /** Sends a request with the jar's cookie and records the answer. */
  async fetch(
    app: IKernelApplication,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie !== undefined) {
      headers.set('cookie', this.cookie);
    }
    const response = await app.fetch(
      new Request(path.startsWith('http') ? path : `${BASE}${path}`, {
        ...init,
        headers,
      }),
    );
    this.update(response);
    return response;
  }

  /** Sends a JSON POST with the jar's cookie. */
  postJson(
    app: IKernelApplication,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return this.fetch(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }
}

/**
 * Builds and starts the application: the four passkey routes, a guarded
 * `/me` route, a CSRF token route, and a password login route for the
 * second-factor tests.
 */
export async function buildPasskeyApp(options: BuildPasskeyOptions = {}): Promise<PasskeyHarness> {
  const store = options.passkeys?.store ?? new MemoryPasskeyStore();
  const principal = options.principal === undefined
    ? { id: 'alice', roles: ['user'] }
    : options.principal;
  const passkeys: PasskeyOptions = {
    rpId: RP_ID,
    rpName: 'Setu Test',
    origins: [ORIGIN],
    store,
    resolvePrincipal: () => Promise.resolve(principal ?? null),
    ...options.passkeys,
  };

  // A passkey-only sign-in needs no `mfa`; it is set only when a test asks
  // for step-up.
  const mfaRequired = options.mfaRequired;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SESSION_SECRET, ...options.session }),
      AuthPlugin({
        signIn: {
          providers: [],
          passkeys,
          ...(mfaRequired === undefined ? {} : { mfa: { required: mfaRequired } }),
        },
      }),
      ...(options.plugins ?? []),
    ],
  });

  // Routes the tests read state through. None of them is part of the plugin.
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ user: ctx.request.user }),
  });
  app.router.get('/_csrf', async (ctx) => ctx.response.json({ token: await getCsrfToken(ctx) }));
  // Reads the signed-in record's methods, so a test asserts the recorded amr
  // rather than trusting a route's 200.
  app.router.get('/_record', (ctx) => {
    const session = getSession(ctx);
    const record = session.get<{ methods?: string[] }>(AUTH_SESSION_KEY);
    return ctx.response.json({ methods: record?.methods ?? [] });
  });
  // A password login through the one contract every sign-in method writes.
  // When the extra plugins answer `mfa.required: true` this resolves
  // `second-factor-required`, which is the pending state a passkey completes.
  app.router.post('/password-login', async (ctx) => {
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    // `{ id }` selects another principal; absent, the session signs in as alice.
    const body = await ctx.request.json<{ id?: string }>().catch(() => ({} as { id?: string }));
    const id = typeof body.id === 'string' ? body.id : 'alice';
    const outcome = await auth.signIn(ctx, { id, roles: ['user'] }, { methods: ['pwd'] });
    return ctx.response.json({ ok: true, outcome: outcome.status });
  });

  await app.start();
  return { app, store };
}
