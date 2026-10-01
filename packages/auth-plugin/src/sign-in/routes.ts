/**
 * The sign-in routes: login, callback, and logout (plan §3.4–§3.8). Internal:
 * registered by `AuthPlugin` when its `signIn` option is configured.
 *
 * Two routes per provider (`GET <basePath>/<name>/login`,
 * `GET <basePath>/<name>/callback`) and ONE logout for the whole plugin
 * (`POST <basePath>/logout`). Logout is `POST` so the session plugin's form CSRF
 * check applies when configured; the README's logout form therefore carries the
 * CSRF token field, because without it a composition with `csrf` configured
 * answers 403 on every logout.
 *
 * Failure handling is fixed by construction. Every refusal answers with one of a
 * small set of fixed strings — either a `401`/`403` body or a redirect carrying
 * one of the {@linkcode SignInErrorCode} values — and nothing a provider said
 * ever reaches a URL, a body, or a log line. A throwing seam is a refusal too:
 * no exception escapes these handlers, so a provider outage cannot become a 500
 * whose message quotes the provider.
 *
 * @module
 */

import type {
  IAuthSessionService,
  IRequestContext,
  IRouterApi,
  IRuntimeServices,
  ISessionService,
  RouteDefinition,
} from '@setu-ts/common';
import { respondWithError } from '@setu-ts/common';
import type { IAuthHttp } from '../interfaces/index.ts';
import type { CompiledProvider, CompiledSignIn } from './config.ts';
import type { IssuerKeySet } from '../issuers/key-set-cache.ts';
import { JwtVerifier } from '../issuers/jwt-verifier.ts';
import { isAcceptableUrl } from '../issuers/trusted-issuer.ts';
import { encodeBase64Url } from '../utils/base64url.ts';
import { ID_TOKEN_SESSION_KEY, RP_PROVIDER_SESSION_KEY } from './auth-session-service.ts';
import { addPending, takePending } from './pending-state.ts';
import { createPkcePair } from './pkce.ts';
import { safeReturnTo } from './return-to.ts';
import { authorizationUrl, exchangeCode, fetchUserInfo } from './token-exchange.ts';

/** State and nonce entropy in bytes. */
const ENTROPY_BYTES = 32;

/** Wall-clock budget for one provider round trip (discovery, token, userinfo). */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** The query parameter carrying the post-sign-in target at the login route. */
export const RETURN_TO_QUERY_PARAM = 'returnTo';

/**
 * The fixed `?error=` codes a callback failure redirects with.
 *
 * These are the ONLY values that ever appear in a redirect, so an application can
 * branch on them and a provider's own wording never reaches a URL.
 */
export type SignInErrorCode =
  | 'provider-denied'
  | 'state-invalid'
  | 'exchange-failed'
  | 'profile-unavailable';

/** The fixed detail a login route answers `503` with when endpoints are unavailable. */
export const PROVIDER_UNAVAILABLE_DETAIL = 'provider-unavailable';

/** The fixed detail a callback answers with when `toPrincipal` refuses. */
export const PRINCIPAL_REFUSED_DETAIL = 'principal-refused';

/** Deps for {@linkcode registerSignInRoutes}. */
export interface SignInRouteDeps {
  /** Where the routes are registered. */
  readonly router: IRouterApi;
  /** The compiled `signIn` option. */
  readonly config: CompiledSignIn;
  /** Opens the session for a request; the session middleware must have run. */
  readonly sessionService: ISessionService;
  /** Records the signed-in principal. */
  readonly authSessionService: IAuthSessionService;
  /** The outbound HTTP seam shared with the issuer key-set cache. */
  readonly http: IAuthHttp;
  /** Runtime services (entropy, clock, timers). */
  readonly runtime: IRuntimeServices;
  /** Key-set caches by provider name, for discovery-backed endpoints. */
  readonly keySets: ReadonlyMap<string, IssuerKeySet>;
  /** Best-effort debug reporting; a throwing implementation is ignored. */
  readonly debug?: (message: string) => void;
}

/** A provider's endpoints, from discovery (`oidc`) or configuration (`oauth2`). */
interface ResolvedEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly endSessionEndpoint: string | null;
}

/**
 * Runs `body` with a signal that aborts after `timeoutMs`, mapping any throw —
 * the abort included — to `null`.
 *
 * The timer comes from `runtime` rather than `AbortSignal.timeout`, matching the
 * rest of the plugin, so a test's fake clock controls it and the handle is one the
 * runtime can clear. A throwing seam must not escape as a 500: `null` means
 * "the provider did not answer", and the caller turns that into a fixed refusal.
 */
export async function attempt<T>(
  runtime: IRuntimeServices,
  timeoutMs: number,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const controller = new AbortController();
  // Raced rather than trusted: an injected seam that ignores the signal would
  // otherwise hold the request, and the application's shutdown drain, open.
  const expired = Promise.withResolvers<null>();
  const timer = runtime.setTimeout(() => {
    controller.abort();
    expired.resolve(null);
  }, timeoutMs);
  try {
    return await Promise.race([body(controller.signal), expired.promise]);
  } catch {
    return null;
  } finally {
    runtime.clearTimeout(timer);
  }
}

/**
 * Resolves a provider's endpoints.
 *
 * For `oidc` they come from the SAME cached, issuer-checked discovery document
 * that supplies `jwks_uri`, so the authorization redirect and the verification
 * cannot be pointed at different servers by one spoofed document. Returns `null`
 * when the document cannot be read or lacks the endpoint the caller needs.
 */
async function resolveEndpoints(
  provider: CompiledProvider,
  keySets: ReadonlyMap<string, IssuerKeySet>,
): Promise<ResolvedEndpoints | null> {
  if (provider.kind === 'oauth2') {
    // compileSignIn has already refused a missing or non-https endpoint.
    return {
      authorizationEndpoint: provider.authorizationEndpoint ?? '',
      tokenEndpoint: provider.tokenEndpoint ?? '',
      endSessionEndpoint: null,
    };
  }
  const keySet = keySets.get(provider.name);
  const issuer = provider.compiledIssuer;
  if (keySet === undefined || issuer === undefined) {
    return null;
  }
  const document = await keySet.discovery();
  if (document === null) {
    return null;
  }
  const authorizationEndpoint = document.authorization_endpoint;
  const tokenEndpoint = document.token_endpoint;
  // The same https-or-loopback rule `jwks_uri` gets: an `http` token endpoint
  // would receive the client secret in cleartext, and an authorization endpoint
  // becomes a `Location` header the user's browser follows.
  if (!isEndpoint(authorizationEndpoint) || !isEndpoint(tokenEndpoint)) {
    return null;
  }
  const endSession = document.end_session_endpoint;
  return {
    authorizationEndpoint,
    tokenEndpoint,
    endSessionEndpoint: isEndpoint(endSession) ? endSession : null,
  };
}

/** A discovery-supplied endpoint: a string that is https, or http on loopback. */
function isEndpoint(value: unknown): value is string {
  return typeof value === 'string' && isAcceptableUrl(value);
}

/**
 * Answers a callback failure: a redirect with a fixed code when the provider
 * configured `failureRedirect`, otherwise a `401` with the code as its detail,
 * written through the error responder so it honours the application's
 * configured error format.
 *
 * The caller must return the result, which is why this returns rather than throws
 * — a thrown refusal would reach the kernel's error handler on top of a response
 * that has already been written.
 */
function fail(
  provider: CompiledProvider,
  ctx: IRequestContext,
  code: SignInErrorCode,
): FlowOutcome {
  const target = provider.failureRedirect;
  if (target === undefined) {
    // Fixed detail, never a provider message: an unauthorized caller learns only
    // which check failed, in one of four words.
    respondWithError(ctx, { status: 401, title: 'Unauthorized', detail: code });
    return null;
  }
  // The code is one of four literals, so nothing here can be influenced by the
  // caller or by the provider.
  const separator = target.includes('?') ? '&' : '?';
  return `${target}${separator}error=${code}`;
}

/**
 * What a sign-in flow resolves to: the URL to redirect to, or `null` when it has
 * already written a refusal through the error responder.
 */
type FlowOutcome = string | null;

/** Where a flow hands its redirect target to the route's terminal handler. */
export const REDIRECT_STATE_KEY = 'auth-plugin:sign-in-redirect';

/**
 * Wraps a sign-in flow as a route.
 *
 * The flow runs as route middleware and the terminal redirect is the handler.
 * The split exists because a refusal is written through `respondWithError` —
 * so it honours the application's configured error format (M70f) — and that
 * seam writes the response without producing the `HandlerResult` a route
 * handler must return. A middleware may short-circuit without one; a refusal
 * therefore never calls `next()`, and the handler runs only for a redirect.
 */
function flowRoute(flow: (ctx: IRequestContext) => Promise<FlowOutcome>): RouteDefinition {
  return {
    middleware: [async (ctx, next) => {
      const target = await flow(ctx);
      if (target === null) {
        return;
      }
      ctx.state.set(REDIRECT_STATE_KEY, target);
      await next();
    }],
    handler: (ctx) => ctx.response.redirect(String(ctx.state.get(REDIRECT_STATE_KEY)), 302),
  };
}

/** Answers `403` for an identity the application's `toPrincipal` refused. */
function refusePrincipal(ctx: IRequestContext): void {
  respondWithError(ctx, { status: 403, title: 'Forbidden', detail: PRINCIPAL_REFUSED_DETAIL });
}

/**
 * Registers one provider's login route: mint `state`, a PKCE pair, and (for
 * `oidc`) a `nonce`, store them in the session, and redirect to the provider.
 */
function registerLogin(
  router: IRouterApi,
  provider: CompiledProvider,
  deps: SignInRouteDeps,
): void {
  router.get(
    provider.loginPath,
    flowRoute(async (ctx): Promise<FlowOutcome> => {
      const endpoints = await resolveEndpoints(provider, deps.keySets);
      if (endpoints === null) {
        // Refused rather than redirecting to a half-known authorization URL: the
        // alternative is sending a user's browser to an endpoint we never read.
        // `503`, not `401`: nothing is wrong with the caller — the provider's
        // discovery document could not be read.
        respondWithError(ctx, {
          status: 503,
          title: 'Service Unavailable',
          detail: PROVIDER_UNAVAILABLE_DETAIL,
        });
        return null;
      }

      const session = deps.sessionService.from(ctx);
      const state = encodeBase64Url(deps.runtime.randomBytes(ENTROPY_BYTES));
      const pkce = await createPkcePair(deps.runtime);
      const nonce = provider.kind === 'oidc'
        ? encodeBase64Url(deps.runtime.randomBytes(ENTROPY_BYTES))
        : undefined;
      // `returnTo` is read HERE and stored in the entry; the callback never trusts a
      // value that arrived on its own URL, which is where an attacker could put one.
      const returnTo = safeReturnTo(ctx.query[RETURN_TO_QUERY_PARAM]);
      addPending(session, {
        state,
        provider: provider.name,
        verifier: pkce.verifier,
        ...(nonce === undefined ? {} : { nonce }),
        returnTo,
        createdAt: deps.runtime.now(),
      });

      return authorizationUrl({
        authorizationEndpoint: endpoints.authorizationEndpoint,
        clientId: provider.clientId,
        scopes: provider.scopes,
        redirectUri: provider.redirectUri,
        state,
        ...(nonce === undefined ? {} : { nonce }),
        challenge: pkce.challenge,
      });
    }),
  );
}

/**
 * Verifies an `oidc` ID token and returns its claims, or `null`.
 *
 * The verifier is the one M100b uses for bearer access tokens from the same
 * provider, so an ID token cannot be checked to a weaker standard than an access
 * token from that provider. On top of it: the `nonce` must match the attempt, and
 * when `aud` carries several values the authorized party (`azp`) must name this
 * client — otherwise a token minted for a different client of the same issuer
 * would be accepted.
 */
async function verifyIdToken(
  provider: CompiledProvider,
  idToken: string,
  expectedNonce: string | undefined,
  deps: SignInRouteDeps,
): Promise<Readonly<Record<string, unknown>> | null> {
  const keySet = deps.keySets.get(provider.name);
  const issuer = provider.compiledIssuer;
  if (keySet === undefined || issuer === undefined) {
    return null;
  }
  const verifier = new JwtVerifier({
    keySet,
    runtime: deps.runtime,
    algorithms: issuer.algorithms,
    // The audience IS the client id: compileSignIn put it there deliberately, so
    // an ID token minted for another client fails here rather than at the app.
    audience: issuer.audience,
    clockToleranceSec: issuer.clockToleranceSec,
  });
  const outcome = await verifier.verify(idToken);
  if (outcome.ok === false) {
    deps.debug?.(`auth-plugin: signIn['${provider.name}'] id_token refused (${outcome.reason})`);
    return null;
  }
  const claims = outcome.claims;
  // OIDC Core §3.1.3.7 step 2. The shared verifier leaves `iss` to its caller
  // (M100b binds it by the issuer lookup), so the ID-token path checks it here.
  if (claims.iss !== provider.issuer) {
    deps.debug?.(`auth-plugin: signIn['${provider.name}'] id_token iss mismatch`);
    return null;
  }
  if (expectedNonce === undefined || claims.nonce !== expectedNonce) {
    // Without a matching nonce this may be an ID token replayed from another
    // login attempt by the same provider.
    deps.debug?.(`auth-plugin: signIn['${provider.name}'] id_token nonce mismatch`);
    return null;
  }
  const aud = claims.aud;
  if (Array.isArray(aud) && aud.length > 1 && claims.azp !== provider.clientId) {
    deps.debug?.(`auth-plugin: signIn['${provider.name}'] id_token azp mismatch`);
    return null;
  }
  return claims;
}

/**
 * Registers one provider's callback route.
 *
 * The order is fixed (plan §3.6): provider-reported error → `state` → code →
 * endpoints → token exchange → ID-token or userinfo verification → `toPrincipal`
 * → `signIn` → `onTokens` → redirect. The pending entry is consumed BEFORE the
 * exchange, so a replayed callback finds nothing.
 */
function registerCallback(
  router: IRouterApi,
  provider: CompiledProvider,
  deps: SignInRouteDeps,
): void {
  router.get(
    provider.callbackPath,
    flowRoute(async (ctx): Promise<FlowOutcome> => {
      const session = deps.sessionService.from(ctx);
      // A provider that reports its own failure first — the user denied, or the
      // request was rejected. `error_description` is read by nobody.
      if (typeof ctx.query.error === 'string') {
        return fail(provider, ctx, 'provider-denied');
      }
      const taken = takePending(
        session,
        ctx.query.state ?? null,
        provider.name,
        deps.runtime.now(),
      );
      if (taken.ok === false) {
        // `unknown-state`, `wrong-provider`, and `expired` all mean the same thing
        // to the caller: this callback does not belong to an attempt this server
        // started. All three are reported as `state-invalid`.
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] callback refused (state-invalid)`);
        return fail(provider, ctx, 'state-invalid');
      }
      const entry = taken.entry;
      // RFC 9207: a provider that names itself in `iss` must name the issuer this
      // attempt was started against. The pending entry already binds the provider
      // by NAME; this binds it by the provider's own assertion, which is what
      // defeats a mix-up between two providers sharing a redirect. Checked after
      // the entry is consumed, so a mix-up attempt cannot be retried.
      const reportedIssuer = ctx.query.iss;
      if (
        reportedIssuer !== undefined && provider.issuer !== undefined &&
        reportedIssuer !== provider.issuer
      ) {
        deps.debug?.(`auth-plugin: signIn['${provider.name}'] callback refused (iss mismatch)`);
        return fail(provider, ctx, 'state-invalid');
      }
      const code = ctx.query.code;
      if (typeof code !== 'string' || code.length === 0) {
        return fail(provider, ctx, 'exchange-failed');
      }
      const endpoints = await resolveEndpoints(provider, deps.keySets);
      if (endpoints === null) {
        return fail(provider, ctx, 'exchange-failed');
      }

      const exchanged = await attempt(
        deps.runtime,
        PROVIDER_TIMEOUT_MS,
        (signal) =>
          exchangeCode(deps.http, {
            tokenEndpoint: endpoints.tokenEndpoint,
            clientId: provider.clientId,
            ...(provider.clientSecret === undefined ? {} : { clientSecret: provider.clientSecret }),
            auth: provider.tokenEndpointAuth,
            code,
            verifier: entry.verifier,
            redirectUri: provider.redirectUri,
            signal,
          }),
      );
      if (exchanged === null || exchanged.ok === false) {
        return fail(provider, ctx, 'exchange-failed');
      }
      const tokens = exchanged.tokens;

      let claims: Readonly<Record<string, unknown>>;
      if (provider.kind === 'oidc') {
        const idToken = tokens.idToken;
        if (typeof idToken !== 'string') {
          // An oidc provider that returns no ID token gave us no verifiable
          // assertion of who the user is, so there is nothing to map.
          return fail(provider, ctx, 'exchange-failed');
        }
        const verified = await verifyIdToken(provider, idToken, entry.nonce, deps);
        if (verified === null) {
          return fail(provider, ctx, 'exchange-failed');
        }
        claims = verified;
      } else {
        const profile = await attempt(
          deps.runtime,
          PROVIDER_TIMEOUT_MS,
          (signal) =>
            fetchUserInfo(deps.http, {
              userinfoEndpoint: provider.userinfoEndpoint ?? '',
              accessToken: tokens.accessToken,
              signal,
            }),
        );
        if (profile === null || profile.ok === false) {
          return fail(provider, ctx, 'profile-unavailable');
        }
        claims = profile.claims;
      }

      let principal;
      try {
        principal = await provider.toPrincipal(claims);
      } catch {
        // A throwing mapper is a refusal, not a 500: the exception text may quote
        // claims, and the outcome for the user is the same as returning `null`.
        refusePrincipal(ctx);
        return null;
      }
      if (principal === null) {
        // The application refused this identity (a deactivated account, say): 403,
        // not a redirect, because nothing about the attempt was malformed.
        refusePrincipal(ctx);
        return null;
      }

      // Awaited: an unawaited rejection would leave the user looking at a
      // redirected page where no identity was recorded.
      const outcome = await deps.authSessionService.signIn(ctx, principal, {
        methods: ['fed'],
      });
      // The ID token is stored only when RP-initiated logout opted in: a provider ID
      // token routinely runs to kilobytes, and past the session cookie's 4096-byte
      // budget the session plugin throws at commit — which would break the SIGN-IN,
      // not the logout that wanted the token.
      // Written AFTER signIn, which clears both keys: this sign-in owns them —
      // including when it is held pending a second factor, since the promotion
      // that completes it keeps them.
      if (provider.rpInitiatedLogout !== undefined) {
        session.set(RP_PROVIDER_SESSION_KEY, provider.name);
        if (provider.rpInitiatedLogout.idTokenHint && typeof tokens.idToken === 'string') {
          session.set(ID_TOKEN_SESSION_KEY, tokens.idToken);
        }
      }
      if (provider.onTokens !== undefined) {
        try {
          await provider.onTokens(tokens);
        } catch {
          // The provider has authenticated the user. Dropping the tokens is better
          // than failing a completed login because an application callback threw.
          deps.debug?.(`auth-plugin: signIn['${provider.name}'] onTokens threw`);
        }
      }
      // A sign-in held back for a second factor is not signed in, so sending the
      // browser to `returnTo` would land it on a page that answers anonymous with
      // no hint of why. The configured code form is where it goes instead.
      if (outcome.status === 'second-factor-required') {
        return deps.config.mfa?.challengePath ?? entry.returnTo;
      }
      return entry.returnTo;
    }),
  );
}

/**
 * Registers the single logout route.
 *
 * Reads the stored ID token BEFORE destroying the session, because on the store
 * strategy `signOut` deletes the entry the session id points at, and the hint has
 * to be in hand before that happens.
 */
function registerLogout(router: IRouterApi, deps: SignInRouteDeps): void {
  router.post(
    deps.config.logoutPath,
    flowRoute(async (ctx): Promise<FlowOutcome> => {
      const provider = deps.config.rpLogoutProvider;
      const session = deps.sessionService.from(ctx);
      // Only a session that actually signed in through the RP-logout provider is
      // sent there: a password user, a user of another provider, or an anonymous
      // POST ends the local session only.
      const wantsRpLogout = provider !== null && provider.rpInitiatedLogout !== undefined &&
        session.get<string>(RP_PROVIDER_SESSION_KEY) === provider.name;
      const idTokenHint = wantsRpLogout ? session.get<string>(ID_TOKEN_SESSION_KEY) : undefined;

      // Local session first: whatever the provider does afterwards, this application
      // must stop asserting the identity.
      deps.authSessionService.signOut(ctx);

      if (!wantsRpLogout || provider === null) {
        return '/';
      }
      const endpoints = await resolveEndpoints(provider, deps.keySets);
      const endSession = endpoints?.endSessionEndpoint;
      if (endSession === null || endSession === undefined) {
        // Discovery does not advertise an end-session endpoint, so there is no
        // provider session to end; the local sign-out is the whole answer.
        deps.debug?.(
          `auth-plugin: signIn['${provider.name}'] has no end_session_endpoint; local logout only`,
        );
        return '/';
      }
      const params = new URLSearchParams({
        client_id: provider.clientId,
        post_logout_redirect_uri: provider.rpInitiatedLogout.postLogoutRedirectUri,
      });
      // OpenID Connect RP-Initiated Logout 1.0 §2 accepts a request without
      // `id_token_hint`; it is sent only when the application opted in and one is
      // actually stored.
      if (provider.rpInitiatedLogout.idTokenHint === true && typeof idTokenHint === 'string') {
        params.set('id_token_hint', idTokenHint);
      }
      const separator = endSession.includes('?') ? '&' : '?';
      return `${endSession}${separator}${params.toString()}`;
    }),
  );
}

/**
 * Registers every sign-in route for the compiled configuration.
 *
 * @param deps - The router, compiled configuration, and the services the routes need
 */
export function registerSignInRoutes(deps: SignInRouteDeps): void {
  for (const provider of deps.config.providers) {
    registerLogin(deps.router, provider, deps);
    registerCallback(deps.router, provider, deps);
  }
  registerLogout(deps.router, deps);
}
