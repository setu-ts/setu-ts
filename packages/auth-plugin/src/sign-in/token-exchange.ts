/**
 * The authorization-code exchange and the userinfo read. Internal: called by the
 * sign-in callback route.
 *
 * Every request goes through the plugin's `IAuthHttp` seam, which owns form
 * encoding, the response byte cap, and redirect handling — so this module cannot
 * be talked into leaking a credential to a redirect target or into letting a
 * secret containing `&` inject a second form parameter.
 *
 * Failure outcomes carry a fixed reason code and, where the provider supplied an
 * OAuth `error` code, that code sanitised to the RFC 6749 §5.2 alphabet. A
 * provider's free-text `error_description` is never returned, logged, or placed
 * in a redirect: it is attacker-controlled text.
 *
 * @module
 */

import type { IAuthHttp } from '../interfaces/index.ts';
import type { ProviderTokens, TokenEndpointAuth } from '../interfaces/index.ts';
import { MAX_RESPONSE_BYTES } from '../issuers/key-set-cache.ts';

/** The response body cap for a token or userinfo endpoint. */
export const MAX_TOKEN_RESPONSE_BYTES = MAX_RESPONSE_BYTES;

/** Why an exchange or profile read did not produce usable data. */
export type TokenExchangeFailure =
  /** The provider answered a non-success status. */
  | 'provider-error'
  /** The body was not JSON, or was missing `access_token`. */
  | 'invalid-response'
  /** The userinfo response was not a JSON object. */
  | 'invalid-profile';

/** The outcome of an authorization-code exchange. */
export type TokenExchangeOutcome =
  | { readonly ok: true; readonly tokens: ProviderTokens }
  | {
    readonly ok: false;
    readonly reason: TokenExchangeFailure;
    /** The provider's own `error` code, sanitised; absent when it sent none. */
    readonly errorCode?: string;
  };

/** Parameters of {@linkcode exchangeCode}. */
export interface ExchangeCodeInput {
  /** The provider's token endpoint. */
  readonly tokenEndpoint: string;
  /** The configured client id. */
  readonly clientId: string;
  /** The client secret; required by both `client_secret_*` methods. */
  readonly clientSecret?: string;
  /** How to present the client credential. */
  readonly auth: TokenEndpointAuth;
  /** The code the provider returned. */
  readonly code: string;
  /** The PKCE verifier stored at login. */
  readonly verifier: string;
  /** The redirect URI, byte-identical to the one sent to the authorization endpoint. */
  readonly redirectUri: string;
  /** Aborts the request. */
  readonly signal: AbortSignal;
}

/**
 * Form-encodes one value using the same rules as `application/x-www-form-urlencoded`.
 *
 * `URLSearchParams` owns the encoding rather than a hand-rolled replace, so a
 * secret containing `&`, `+`, `=` or a newline cannot break out of its own
 * parameter and add another one to the request.
 */
function formEncode(value: string): string {
  return new URLSearchParams([['v', value]]).toString().slice('v='.length);
}

/**
 * Base64-encodes text as UTF-8 bytes (the `client_secret_basic` credential).
 *
 * `btoa` is 8-bit-only, so the text is encoded to UTF-8 first: a secret with a
 * non-ASCII character must produce the bytes the provider expects, not throw.
 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Keeps a provider's `error` code inside the RFC 6749 §5.2 alphabet.
 *
 * The code is a fixed identifier and useful in a log; the accompanying
 * `error_description` is free text and is dropped.
 */
function sanitizeErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^[A-Za-z0-9._-]{1,40}$/.exec(value);
  return match === null ? undefined : value;
}

/**
 * Parses a token endpoint body, refusing anything without an access token.
 *
 * @param status - The response status
 * @param body - The response body
 * @returns The tokens, or the reason the response is unusable
 */
export function parseTokenResponse(
  status: number,
  body: string,
): TokenExchangeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'invalid-response' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-response' };
  }
  const record = parsed as Record<string, unknown>;
  const errorCode = sanitizeErrorCode(record.error);
  if (status < 200 || status > 299) {
    return { ok: false, reason: 'provider-error', ...(errorCode ? { errorCode } : {}) };
  }
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    // A 200 with no access token is a provider misbehaving, not a grant.
    return { ok: false, reason: 'invalid-response' };
  }
  const tokenType = typeof record.token_type === 'string' ? record.token_type : undefined;
  const scope = typeof record.scope === 'string' ? record.scope : undefined;
  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : undefined;
  const idToken = typeof record.id_token === 'string' ? record.id_token : undefined;
  const expiresIn = typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
    ? record.expires_in
    : undefined;
  return {
    ok: true,
    tokens: {
      accessToken,
      ...(tokenType === undefined ? {} : { tokenType }),
      ...(scope === undefined ? {} : { scope }),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(idToken === undefined ? {} : { idToken }),
      ...(expiresIn === undefined ? {} : { expiresIn }),
    },
  };
}

/**
 * Exchanges an authorization code for tokens.
 *
 * The request is `application/x-www-form-urlencoded` with `grant_type`
 * `authorization_code`, the PKCE `code_verifier`, and the client credential in
 * whichever form `tokenEndpointAuth` selects. `redirect_uri` is sent exactly as
 * configured: RFC 6749 §4.1.3 requires it to match the authorization request,
 * and providers reject a mismatch with `invalid_grant`.
 *
 * @param http - The outbound HTTP seam
 * @param input - Endpoints, credential, code, verifier, and redirect URI
 * @returns The provider's tokens, or the reason the exchange failed
 */
export async function exchangeCode(
  http: IAuthHttp,
  input: ExchangeCodeInput,
): Promise<TokenExchangeOutcome> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  };
  const headers: Record<string, string> = {};
  if (input.auth === 'client_secret_basic') {
    if (typeof input.clientSecret !== 'string' || input.clientSecret.length === 0) {
      return { ok: false, reason: 'invalid-response' };
    }
    // RFC 6749 §2.3.1: both halves are form-encoded before being joined with ':'.
    headers.authorization = `Basic ${
      base64Utf8(`${formEncode(input.clientId)}:${formEncode(input.clientSecret)}`)
    }`;
  } else if (input.auth === 'client_secret_post') {
    if (typeof input.clientSecret !== 'string' || input.clientSecret.length === 0) {
      return { ok: false, reason: 'invalid-response' };
    }
    form.client_secret = input.clientSecret;
  }
  // `auth === 'none'`: a public client. PKCE is the only credential, which is
  // why a code captured on the front channel still cannot be redeemed.
  const response = await http.post(input.tokenEndpoint, {
    signal: input.signal,
    maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    form,
    headers,
  });
  return parseTokenResponse(response.status, response.body);
}

/**
 * Reads a provider's userinfo document with an access token.
 *
 * @param http - The outbound HTTP seam
 * @param options - The endpoint, token, and abort signal
 * @returns The profile claims, or the reason the read failed
 */
export async function fetchUserInfo(
  http: IAuthHttp,
  options: {
    readonly userinfoEndpoint: string;
    readonly accessToken: string;
    readonly signal: AbortSignal;
  },
): Promise<
  { readonly ok: true; readonly claims: Readonly<Record<string, unknown>> } | {
    readonly ok: false;
    readonly reason: TokenExchangeFailure;
  }
> {
  // RFC 6750 §2.1: the access token rides the Authorization header. Without it
  // every provider answers 401, so no oauth2 sign-in could ever succeed.
  const response = await http.get(options.userinfoEndpoint, {
    signal: options.signal,
    maxBytes: MAX_TOKEN_RESPONSE_BYTES,
    headers: { authorization: `Bearer ${options.accessToken}` },
  });
  if (response.status < 200 || response.status > 299) {
    return { ok: false, reason: 'provider-error' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { ok: false, reason: 'invalid-profile' };
  }
  // GitHub answers userinfo as an array for some endpoints; anything that is not
  // an object has no claims to map.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-profile' };
  }
  return { ok: true, claims: parsed as Record<string, unknown> };
}

/**
 * Builds the authorization URL a login route redirects to.
 *
 * @param options - Endpoint, client id, scopes, state, nonce, PKCE challenge, redirect URI
 * @returns The URL, with every parameter form-encoded by `URLSearchParams`
 */
export function authorizationUrl(options: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce?: string;
  readonly challenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scopes.join(' '),
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
  });
  // `nonce` is OIDC-only; an oauth2 provider that receives it may reject the
  // request, so it is omitted rather than sent empty.
  if (typeof options.nonce === 'string') {
    params.set('nonce', options.nonce);
  }
  // The endpoint may already carry a query; join with `&` so `?` is never doubled.
  const separator = options.authorizationEndpoint.includes('?') ? '&' : '?';
  return `${options.authorizationEndpoint}${separator}${params.toString()}`;
}
