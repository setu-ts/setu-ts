/**
 * Validation and defaulting of `AuthPluginOptions.signIn`. Internal: called by
 * `AuthPlugin` at construction, so every refusal happens before an application
 * exists rather than at the first login.
 *
 * The `oidc` arm compiles to a {@linkcode CompiledIssuer} through M100b's
 * `compileIssuers`, with `audience` set to the provider's `clientId`: an ID
 * token from the provider is then verified by exactly the same code, against
 * exactly the same discovery-checked keys, as an access token from that provider
 * would be. The two arms cannot disagree about a provider.
 *
 * @module
 */

import type { CompiledIssuer } from '../issuers/trusted-issuer.ts';
import { compileIssuers, isAcceptableUrl } from '../issuers/trusted-issuer.ts';
import { AuthPluginConfigurationError } from '../errors.ts';
import type {
  MfaOptions,
  OAuth2Provider,
  OidcProvider,
  ProviderTokens,
  RefreshPrincipal,
  SignInConfig,
  SignInProvider,
  TokenEndpointAuth,
} from '../interfaces/index.ts';
import type { IPrincipal } from '@setu-ts/common';
import { safeReturnTo } from './return-to.ts';

/** Default route prefix. */
export const DEFAULT_SIGN_IN_BASE_PATH = '/auth';

/** A provider name becomes a URL segment, so it is kebab-case only. */
const PROVIDER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A base path is one or more kebab segments, with no trailing or doubled slash. */
const BASE_PATH = /^\/(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;

const TOKEN_ENDPOINT_AUTH: readonly TokenEndpointAuth[] = [
  'client_secret_basic',
  'client_secret_post',
  'none',
];

/** A validated provider with every default applied, plus its route paths. */
export interface CompiledProvider {
  /** Kebab-case provider name. */
  readonly name: string;
  /** `oidc` or `oauth2`. */
  readonly kind: 'oidc' | 'oauth2';
  /** `<basePath>/<name>/login`. */
  readonly loginPath: string;
  /** `<basePath>/<name>/callback`. */
  readonly callbackPath: string;
  /** The exact `redirect_uri` sent to the provider. */
  readonly redirectUri: string;
  /** The client id; also the required audience of an `oidc` ID token. */
  readonly clientId: string;
  /** How the client credential is presented. */
  readonly tokenEndpointAuth: TokenEndpointAuth;
  /** The client secret, when one is used. */
  readonly clientSecret?: string;
  /** Requested scopes. */
  readonly scopes: readonly string[];
  /** Where to send a callback failure, with a fixed `?error=` code. */
  readonly failureRedirect?: string;
  /** Maps verified claims to a principal. */
  readonly toPrincipal: (
    claims: Readonly<Record<string, unknown>>,
  ) => IPrincipal | null | Promise<IPrincipal | null>;
  /** Receives the provider tokens; absent means they are dropped. */
  readonly onTokens?: (tokens: ProviderTokens) => void | Promise<void>;
  /** The token endpoint. For `oidc` it comes from discovery at request time. */
  readonly tokenEndpoint?: string;
  /** The authorization endpoint. For `oidc` it comes from discovery at request time. */
  readonly authorizationEndpoint?: string;
  /** The profile endpoint; `oauth2` only, since `oidc` reads claims from the ID token. */
  readonly userinfoEndpoint?: string;
  /** The `oidc` issuer URL, verified against the ID token's `iss`. */
  readonly issuer?: string;
  /** The compiled issuer behind the shared key-set cache and verifier. */
  readonly compiledIssuer?: CompiledIssuer;
  /** RP-initiated logout, when configured. */
  readonly rpInitiatedLogout?: {
    readonly postLogoutRedirectUri: string;
    readonly idTokenHint: boolean;
  };
}

/** A validated `signIn` option. */
export interface CompiledSignIn {
  /** Route prefix, defaults to `/auth`. */
  readonly basePath: string;
  /** The providers, in configuration order. */
  readonly providers: readonly CompiledProvider[];
  /** The single logout route. */
  readonly logoutPath: string;
  /** The one provider configured for RP-initiated logout, if any. */
  readonly rpLogoutProvider: CompiledProvider | null;
  /**
   * The per-request re-read handed to the `auth-session` strategy, or `null` when
   * the session snapshot is trusted. Carried through here so the plugin does not
   * have to re-read the raw option.
   */
  readonly refreshPrincipal: RefreshPrincipal | null;
  /**
   * The MFA policy, or `null` when no second factor is required.
   */
  readonly mfa: MfaOptions | null;
}

function refuse(name: string, reason: string): never {
  throw new AuthPluginConfigurationError(`auth-plugin: signIn['${name}'] ${reason}`);
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

/** Applies the credential rules, which depend on each other. */
function resolveAuth(
  provider: SignInProvider,
  name: string,
): { auth: TokenEndpointAuth; secret?: string } {
  const hasSecret = typeof provider.clientSecret === 'string' && provider.clientSecret.length > 0;
  const requested = provider.tokenEndpointAuth;
  if (requested !== undefined && !TOKEN_ENDPOINT_AUTH.includes(requested)) {
    refuse(name, `tokenEndpointAuth must be one of ${TOKEN_ENDPOINT_AUTH.join(', ')}`);
  }
  const auth: TokenEndpointAuth = requested ?? (hasSecret ? 'client_secret_basic' : 'none');
  // Both refusals are about a credential that is half-configured: sending a code
  // to a provider that cannot authenticate the client, or storing a secret no
  // request ever uses, are both silent failures waiting to happen.
  if (auth !== 'none' && !hasSecret) {
    refuse(name, `tokenEndpointAuth '${auth}' needs a clientSecret`);
  }
  if (auth === 'none' && hasSecret) {
    refuse(
      name,
      'has a clientSecret but tokenEndpointAuth none, so the secret would never be sent',
    );
  }
  return hasSecret ? { auth, secret: provider.clientSecret } : { auth };
}

/** Validates the fields the two arms share, including their route paths. */
function compileBase(
  provider: SignInProvider,
  name: string,
  basePath: string,
): Omit<CompiledProvider, 'kind'> {
  if (typeof provider.clientId !== 'string' || provider.clientId.length === 0) {
    refuse(name, 'needs a non-empty clientId');
  }
  if (!isFunction(provider.toPrincipal)) {
    refuse(name, 'needs a toPrincipal function');
  }
  if (provider.onTokens !== undefined && !isFunction(provider.onTokens)) {
    refuse(name, 'onTokens must be a function');
  }
  if (typeof provider.redirectUri !== 'string' || !isAcceptableUrl(provider.redirectUri)) {
    refuse(name, 'redirectUri must be https, or http on a loopback host');
  }
  // The registered route and the value the provider matches against must be the
  // same string; a mismatch is a login that fails at the provider with an error
  // that names neither the route nor the option.
  // Compared on the parsed path, so a query does not defeat it; a leading
  // reverse-proxy mount prefix is still allowed.
  const callbackPath = `${basePath}/${name}/callback`;
  if (!new URL(provider.redirectUri).pathname.endsWith(callbackPath)) {
    refuse(name, `redirectUri path must end with ${callbackPath}`);
  }
  if (provider.failureRedirect !== undefined) {
    // A failure redirect is a redirect: it gets the same same-origin check as
    // `returnTo`, and an unsafe one is a configuration error rather than a
    // silent fallback that would hide the mistake.
    if (safeReturnTo(provider.failureRedirect, '') !== provider.failureRedirect) {
      refuse(name, 'failureRedirect must be a same-origin absolute path');
    }
  }
  const credential = resolveAuth(provider, name);
  return {
    name,
    loginPath: `${basePath}/${name}/login`,
    callbackPath: `${basePath}/${name}/callback`,
    redirectUri: provider.redirectUri,
    clientId: provider.clientId,
    tokenEndpointAuth: credential.auth,
    ...(credential.secret === undefined ? {} : { clientSecret: credential.secret }),
    scopes: [],
    ...(provider.failureRedirect === undefined
      ? {}
      : { failureRedirect: provider.failureRedirect }),
    toPrincipal: provider.toPrincipal,
    ...(provider.onTokens === undefined ? {} : { onTokens: provider.onTokens }),
  };
}

/** Validates the `oidc` arm and compiles its issuer through M100b. */
function compileOidc(
  provider: OidcProvider,
  base: Omit<CompiledProvider, 'kind'>,
): CompiledProvider {
  const name = base.name;
  if (typeof provider.issuer !== 'string' || !isAcceptableUrl(provider.issuer)) {
    refuse(name, 'issuer must be an https URL, or http on a loopback host');
  }
  if (provider.rpInitiatedLogout !== undefined) {
    const post = provider.rpInitiatedLogout.postLogoutRedirectUri;
    if (typeof post !== 'string' || !isAcceptableUrl(post)) {
      refuse(
        name,
        'rpInitiatedLogout.postLogoutRedirectUri must be https, or http on a loopback host',
      );
    }
    if (
      provider.rpInitiatedLogout.idTokenHint !== undefined &&
      provider.rpInitiatedLogout.idTokenHint !== true
    ) {
      refuse(name, 'rpInitiatedLogout.idTokenHint must be true when present');
    }
  }
  // Scopes: `openid` is what makes an ID token appear, so asking for the OIDC
  // arm without it would produce a callback with nothing to verify.
  const scopes = provider.scopes ?? ['openid'];
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
    refuse(name, 'scopes must be an array of strings');
  }
  if (!scopes.includes('openid')) {
    refuse(name, 'an oidc provider needs the openid scope');
  }
  // The ID token's audience is this client: RFC 9207 / OIDC §3.1.3.7. Compiling
  // through compileIssuers means the issuer URL, the algorithm allowlist, and the
  // key-set timings are validated by the same code M100b pins.
  const [compiledIssuer] = compileIssuers([
    {
      name,
      issuer: provider.issuer,
      audience: base.clientId,
      keys: { discovery: true },
      toPrincipal: provider.toPrincipal,
    },
  ]);
  const rp = provider.rpInitiatedLogout;
  return {
    ...base,
    kind: 'oidc',
    scopes,
    issuer: provider.issuer,
    compiledIssuer,
    ...(rp === undefined ? {} : {
      rpInitiatedLogout: {
        postLogoutRedirectUri: rp.postLogoutRedirectUri,
        idTokenHint: rp.idTokenHint === true,
      },
    }),
  };
}

/** Validates the `oauth2` arm: three endpoints, no ID token. */
function compileOAuth2(
  provider: OAuth2Provider,
  base: Omit<CompiledProvider, 'kind'>,
): CompiledProvider {
  const name = base.name;
  for (
    const field of ['authorizationEndpoint', 'tokenEndpoint', 'userinfoEndpoint'] as const
  ) {
    const value = provider[field];
    if (typeof value !== 'string' || !isAcceptableUrl(value)) {
      refuse(name, `${field} must be https, or http on a loopback host`);
    }
  }
  const scopes = provider.scopes ?? [];
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
    refuse(name, 'scopes must be an array of strings');
  }
  // Plain-JavaScript callers bypass the arm's type: `rpInitiatedLogout` is not a
  // field of `oauth2`, and accepting it there would silently do nothing, because
  // the logout route only knows how to end an OIDC session. Checked with `in`
  // rather than a cast, exactly as compileIssuers guards `keys`.
  if ('rpInitiatedLogout' in provider) {
    refuse(name, 'rpInitiatedLogout is only available on an oidc provider');
  }
  return {
    ...base,
    kind: 'oauth2',
    scopes,
    authorizationEndpoint: provider.authorizationEndpoint,
    tokenEndpoint: provider.tokenEndpoint,
    userinfoEndpoint: provider.userinfoEndpoint,
  };
}

/**
 * Validates and compiles the `signIn` option.
 *
 * @param config - The configured value
 * @returns The compiled configuration, with route paths and defaults applied
 * @throws {AuthPluginConfigurationError} On an empty provider list, a duplicate or
 *   malformed name, a bad base path, a credential/secret mismatch, a `redirectUri`
 *   that does not end with the provider's callback path, a `failureRedirect` that is
 *   not same-origin, an `oidc` provider without the `openid` scope, an `oauth2`
 *   provider with `rpInitiatedLogout`, or more than one provider configured for
 *   RP-initiated logout, or an invalid `mfa` option (see {@linkcode compileMfa})
 */
export function compileSignIn(config: SignInConfig): CompiledSignIn {
  const configured = config.basePath ?? DEFAULT_SIGN_IN_BASE_PATH;
  if (configured !== '/' && !(BASE_PATH.test(configured) && !configured.endsWith('/'))) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: signIn.basePath must be / or kebab-case segments without a trailing slash, got '${
        String(
          config.basePath,
        )
      }'`,
    );
  }
  // `/` means no prefix at all; keeping it literal would build `//acme/login`.
  const basePath = configured === '/' ? '' : configured;
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    throw new AuthPluginConfigurationError('auth-plugin: signIn needs at least one provider');
  }

  const names = new Set<string>();
  const providers = config.providers.map((provider) => {
    const name = provider?.name;
    if (typeof name !== 'string' || !PROVIDER_NAME.test(name)) {
      throw new AuthPluginConfigurationError(
        `auth-plugin: signIn provider name must be kebab-case, got '${String(name)}'`,
      );
    }
    if (names.has(name)) {
      refuse(name, 'duplicates another provider name');
    }
    names.add(name);
    // A missing `kind` is refused rather than guessed at: the two arms produce
    // different callbacks, and a default would silently choose one.
    if (provider.kind === 'oidc') {
      return compileOidc(provider, compileBase(provider, name, basePath));
    } else if (provider.kind === 'oauth2') {
      return compileOAuth2(provider, compileBase(provider, name, basePath));
    } else {
      throw new AuthPluginConfigurationError(
        `auth-plugin: signIn['${name}'] kind must be 'oidc' or 'oauth2'`,
      );
    }
  });

  // One logout route serves the whole plugin, so more than one provider claiming
  // RP-initiated logout is ambiguous: the route could not know whose
  // end-session endpoint to call.
  const rpLogoutProviders = providers.filter((provider) =>
    provider.rpInitiatedLogout !== undefined
  );
  if (rpLogoutProviders.length > 1) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: only one signIn provider may set rpInitiatedLogout, got ${
        rpLogoutProviders.map((provider) => provider.name).join(', ')
      }`,
    );
  }

  // A non-function `refreshPrincipal` would otherwise fail per request, on the
  // path that is hardest to notice: every signed-in request answering anonymous.
  if (config.refreshPrincipal !== undefined && !isFunction(config.refreshPrincipal)) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: signIn.refreshPrincipal must be a function',
    );
  }

  return {
    basePath,
    providers,
    logoutPath: `${basePath}/logout`,
    rpLogoutProvider: rpLogoutProviders[0] ?? null,
    refreshPrincipal: config.refreshPrincipal ?? null,
    mfa: compileMfa(config.mfa),
  };
}

/**
 * Validates the MFA policy at construction.
 *
 * `pendingTtlMs` must be a positive safe integer: every comparison against `NaN`
 * is `false`, so `NaN` (what `Number(env.X)` yields for an unset variable) would
 * make a pending record never expire, while `0` or a negative value would refuse
 * every completion. `challengePath` is a redirect, so it gets the same
 * same-origin check as `failureRedirect`.
 *
 * @param mfa - The raw option, or `undefined`
 * @returns The validated option, or `null` when absent
 * @throws {AuthPluginConfigurationError} On a non-function `required`, an
 *   out-of-domain `pendingTtlMs`, or a `challengePath` that is not a same-origin
 *   absolute path
 */
export function compileMfa(mfa: MfaOptions | undefined): MfaOptions | null {
  if (mfa === undefined) {
    return null;
  }
  if (!isFunction(mfa.required)) {
    throw new AuthPluginConfigurationError('auth-plugin: signIn.mfa.required must be a function');
  }
  if (
    mfa.pendingTtlMs !== undefined &&
    !(Number.isSafeInteger(mfa.pendingTtlMs) && mfa.pendingTtlMs > 0)
  ) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: signIn.mfa.pendingTtlMs must be a positive integer number of milliseconds',
    );
  }
  if (
    mfa.challengePath !== undefined &&
    // `''` passes the comparison below (the fallback IS `''`), and a `Location: ""`
    // re-requests the callback that has just spent its code.
    (mfa.challengePath === '' || safeReturnTo(mfa.challengePath, '') !== mfa.challengePath)
  ) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: signIn.mfa.challengePath must be a same-origin absolute path',
    );
  }
  return mfa;
}
