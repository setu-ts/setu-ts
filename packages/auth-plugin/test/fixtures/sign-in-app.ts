/**
 * A real kernel application wired for sign-in, plus a fake outside provider
 * answering through the `IAuthHttp` seam, and a one-cookie jar.
 *
 * The provider is fake only at the network boundary: its ID tokens are signed
 * with real Web Crypto keys and verified by the plugin's real verifier, so a
 * test that passes here has exercised every check the callback performs.
 *
 * @module
 */
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthSessionService, IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { getCsrfToken, getSession, SessionPlugin } from '@setu-ts/session-plugin';
import type { SessionPluginOptions } from '@setu-ts/session-plugin';

import { AuthPlugin, requireAuth } from '../../src/index.ts';
import type { OAuth2Provider, OidcProvider, SignInConfig } from '../../src/index.ts';
import { PENDING_SESSION_KEY } from '../../src/sign-in/pending-state.ts';
import { createFakeHttp, generateTestKey, signToken } from './issuer-tokens.ts';
import type { RecordedRequest, TestKey } from './issuer-tokens.ts';

/** Base URL for `app.fetch` requests (no socket). */
export const BASE = 'http://localhost';
/** The fake OIDC provider's issuer. */
export const ISSUER = 'https://idp.test';
/** The fake plain-OAuth 2.0 provider's endpoints. */
export const GH = {
  authorize: 'https://gh.test/login/oauth/authorize',
  token: 'https://gh.test/login/oauth/access_token',
  userinfo: 'https://gh.test/user',
} as const;
/** Client id both fake providers expect. */
export const CLIENT_ID = 'setu-app';
/** Session secret (≥32 chars). */
export const SESSION_SECRET = 'sign-in-session-secret-at-least-32-characters';

/** The discovery document the fake OIDC provider serves. */
export function discoveryDocument(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    end_session_endpoint: `${ISSUER}/logout`,
    ...extra,
  };
}

/** Mutable behaviour of the fake provider, set per test. */
export interface FakeProviderState {
  /** Claims placed in the next ID token; `nonce` is filled from the login URL unless set. */
  idClaims: Record<string, unknown>;
  /** Overrides the whole token-endpoint answer. */
  tokenAnswer: { status?: number; body: unknown } | null;
  /** Omit `id_token` from the token response. */
  omitIdToken: boolean;
  /** The nonce the last login redirect carried. */
  lastNonce: string | undefined;
  /** The userinfo answer for the oauth2 provider. */
  userinfo: { status?: number; body: unknown };
  /** The discovery document; `null` answers 500. */
  discovery: Record<string, unknown> | null;
}

/** A built application and the handles a test needs. */
export interface SignInHarness {
  readonly app: IKernelApplication;
  readonly state: FakeProviderState;
  readonly key: TestKey;
  /** Every outbound request the plugin made. */
  readonly requests: RecordedRequest[];
  /** What `onTokens` received, in order. */
  readonly tokens: unknown[];
  /** Signs the next ID token from `state.idClaims` and the last login's nonce. */
  readonly prepare: () => Promise<void>;
}

/** Options for {@linkcode buildSignInApp}. */
export interface BuildOptions {
  readonly session?: Partial<SessionPluginOptions>;
  readonly oidc?: Partial<OidcProvider>;
  readonly oauth2?: Partial<OAuth2Provider>;
  readonly signIn?: Partial<SignInConfig>;
  readonly plugins?: readonly IPlugin[];
  readonly onTokensThrows?: boolean;
  /** The discovery document to serve from the start. */
  readonly discovery?: Record<string, unknown>;
}

/** Seconds since the epoch; the verifier checks `exp`/`iat` against the runtime clock. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Builds and starts the application: an `idp` OIDC provider and a `gh` OAuth 2.0
 * provider, both behind the recording fake HTTP seam.
 */
export async function buildSignInApp(options: BuildOptions = {}): Promise<SignInHarness> {
  const key = await generateTestKey('RS256', 'k1');
  const state: FakeProviderState = {
    idClaims: {},
    tokenAnswer: null,
    omitIdToken: false,
    lastNonce: undefined,
    userinfo: { body: { id: 42, login: 'octocat' } },
    discovery: options.discovery ?? discoveryDocument(),
  };
  const tokens: unknown[] = [];
  const signedTokens = new Map<string, string>();

  // The token route is synchronous (the fake seam's contract), so the ID token
  // is signed ahead of the call by `prepare`, which `followLogin` runs.
  const { http, requests } = createFakeHttp({
    [`${ISSUER}/.well-known/openid-configuration`]: () =>
      state.discovery === null ? { status: 500, body: 'down' } : { body: state.discovery },
    [`${ISSUER}/jwks`]: { body: { keys: [key.jwk] } },
    [`${ISSUER}/token`]: () => {
      if (state.tokenAnswer !== null) {
        return state.tokenAnswer;
      }
      const idToken = signedTokens.get('next');
      return {
        body: {
          access_token: 'provider-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          ...(state.omitIdToken || idToken === undefined ? {} : { id_token: idToken }),
        },
      };
    },
    [GH.token]: () => state.tokenAnswer ?? { body: { access_token: 'gh-token' } },
    [GH.userinfo]: () => state.userinfo,
  });

  const oidc: OidcProvider = {
    kind: 'oidc',
    name: 'idp',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'shh',
    scopes: ['openid', 'profile'],
    redirectUri: `${BASE}/auth/idp/callback`,
    toPrincipal: (claims) =>
      typeof claims.sub === 'string' ? { id: `idp:${claims.sub}`, roles: ['user'] } : null,
    onTokens: (received) => {
      tokens.push(received);
      if (options.onTokensThrows === true) {
        throw new Error('application callback failed');
      }
    },
    ...options.oidc,
  };
  const oauth2: OAuth2Provider = {
    kind: 'oauth2',
    name: 'gh',
    clientId: CLIENT_ID,
    clientSecret: 'shh',
    tokenEndpointAuth: 'client_secret_post',
    authorizationEndpoint: GH.authorize,
    tokenEndpoint: GH.token,
    userinfoEndpoint: GH.userinfo,
    redirectUri: `${BASE}/auth/gh/callback`,
    toPrincipal: (claims) => ({ id: `gh:${String(claims.id)}`, roles: ['user'] }),
    ...options.oauth2,
  };

  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SessionPlugin({ secret: SESSION_SECRET, ...options.session }),
      AuthPlugin({
        http,
        signIn: { providers: [oidc, oauth2], ...options.signIn },
      }),
      ...(options.plugins ?? []),
    ],
  });

  // Routes the tests read state through. None of them is part of the plugin.
  app.router.get('/me', {
    middleware: [requireAuth()],
    handler: (ctx) => ctx.response.json({ user: ctx.request.user }),
  });
  app.router.get('/_session', (ctx) => {
    const session = getSession(ctx);
    return ctx.response.json({ id: session.id, pending: session.get(PENDING_SESSION_KEY) ?? [] });
  });
  // Ages every pending entry past its ten-minute lifetime.
  app.router.post('/_age-pending', (ctx) => {
    const session = getSession(ctx);
    const pending = session.get<Record<string, unknown>[]>(PENDING_SESSION_KEY) ?? [];
    session.set(PENDING_SESSION_KEY, pending.map((entry) => ({ ...entry, createdAt: 0 })));
    return ctx.response.json({ ok: true });
  });
  app.router.get('/_csrf', async (ctx) => ctx.response.json({ token: await getCsrfToken(ctx) }));
  // A password login through the one contract every sign-in method writes.
  app.router.post('/password-login', async (ctx) => {
    const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    await auth.signIn(ctx, { id: 'alice', roles: ['user'], claims: { amr: ['hwk'] } }, {
      methods: ['pwd'],
    });
    return ctx.response.json({ ok: true });
  });

  await app.start();

  // Pre-signs the ID token for the next callback, bound to the nonce the login
  // redirect carried, so a test can swap claims first and re-sign.
  return {
    app,
    state,
    key,
    requests,
    tokens,
    prepare: async () => {
      const now = nowSeconds();
      signedTokens.set(
        'next',
        await signToken(key, {
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: 'user-1',
          iat: now,
          exp: now + 300,
          nonce: state.lastNonce,
          ...state.idClaims,
        }),
      );
    },
  };
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
        redirect: 'manual',
      }),
    );
    this.update(response);
    return response;
  }
}

/**
 * Drives `GET /auth/<provider>/login`, records the nonce the redirect carried,
 * pre-signs the next ID token, and returns the authorization URL's parameters.
 */
export async function followLogin(
  harness: SignInHarness,
  jar: CookieJar,
  provider = 'idp',
  query = '',
): Promise<URLSearchParams> {
  const response = await jar.fetch(harness.app, `/auth/${provider}/login${query}`);
  if (response.status !== 302) {
    throw new Error(`login answered ${response.status}: ${await response.text()}`);
  }
  await response.body?.cancel();
  const params = new URL(response.headers.get('location') ?? '').searchParams;
  harness.state.lastNonce = params.get('nonce') ?? undefined;
  await harness.prepare();
  return params;
}

/** Drives the callback for `state` with `code`, plus any extra query. */
export function callback(
  harness: SignInHarness,
  jar: CookieJar,
  params: Record<string, string>,
  provider = 'idp',
): Promise<Response> {
  const search = new URLSearchParams(params).toString();
  return jar.fetch(harness.app, `/auth/${provider}/callback?${search}`);
}

/** The pending entry for `state`, read back through the app's own session. */
export async function pendingEntry(
  harness: SignInHarness,
  jar: CookieJar,
  state: string | null,
): Promise<Record<string, unknown> | undefined> {
  const session = await json(await jar.fetch(harness.app, '/_session'));
  return (session.pending as Record<string, unknown>[]).find((entry) => entry.state === state);
}

/** Reads a response body as JSON. */
export async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}
