/**
 * The one writer of `WWW-Authenticate: Bearer` challenges (M132 §3.3).
 *
 * Every 401 producer in the plugin — guards, policy guards, decorator
 * middleware, a thrown `AuthorizationDeniedError` — gets the header from the
 * `bearer-challenge` middleware rather than from each refusal site, so
 * `ErrorResponseInit` (which has no header field) stays untouched.
 *
 * No request-supplied byte ever reaches the header: values come from
 * configuration, from build-time-validated scope tokens, or from fixed error
 * codes, and `formatBearerChallenge` quotes them.
 *
 * @module
 */

import type { IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { REQUIRED_SCOPES_STATE_KEY, httpStatusHintOf } from '@setu-ts/common';
import { isScopeToken } from './claims.ts';

/** The fixed error codes an RFC 6750 challenge may carry. */
export type BearerErrorCode = 'invalid_token' | 'insufficient_scope';

/** Values a {@linkcode formatBearerChallenge} call may carry. */
export interface BearerChallengeOptions {
  /** The RFC 6750 `error` attribute. */
  readonly error?: BearerErrorCode;
  /** Scopes for the RFC 6750 `scope` attribute, in the order to list them. */
  readonly scopes?: readonly string[];
  /** The RFC 9728 `resource_metadata` URL. */
  readonly resourceMetadata?: string;
}

/** Escapes a value for an HTTP quoted-string. */
function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds one `WWW-Authenticate: Bearer` value.
 *
 * Parameters are omitted when absent; a bare `Bearer` is what RFC 6750 §3.1
 * wants when the request carried no credentials. `scopes` is listed only when
 * non-empty.
 *
 * @param options - Error code, required scopes, and resource metadata URL
 * @returns The header value
 */
export function formatBearerChallenge(options: BearerChallengeOptions = {}): string {
  const parameters: string[] = [];
  if (options.error !== undefined) {
    parameters.push(`error="${quote(options.error)}"`);
  }
  if (options.scopes !== undefined && options.scopes.length > 0) {
    parameters.push(`scope="${quote(options.scopes.join(' '))}"`);
  }
  if (options.resourceMetadata !== undefined) {
    parameters.push(`resource_metadata="${quote(options.resourceMetadata)}"`);
  }
  return parameters.length === 0 ? 'Bearer' : `Bearer ${parameters.join(', ')}`;
}

/**
 * Whether the request carried a credential in the header and scheme the bearer
 * strategies read (`jwt.header`/`jwt.scheme`, `Authorization: Bearer` by
 * default), so a refusal means the token was invalid rather than absent.
 */
function carriesBearer(ctx: IRequestContext, header: string, scheme: string): boolean {
  const value = ctx.request.headers.get(header);
  if (value === null) {
    return false;
  }
  return value.split(' ')[0]?.toLowerCase() === scheme;
}

/** Reads required scopes recorded by `requireScopes` or the MCP access gate, if valid. */
function requiredScopesOf(ctx: IRequestContext): readonly string[] | undefined {
  const value = ctx.state.get(REQUIRED_SCOPES_STATE_KEY);
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const scopes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isScopeToken(entry)) {
      return undefined;
    }
    scopes.push(entry);
  }
  return scopes;
}

/** Deps for {@linkcode bearerChallenge}. */
export interface BearerChallengeDeps {
  /** The RFC 9728 metadata URL, when `resourceServer` is configured. */
  readonly resourceMetadata?: string;
  /** The header the bearer strategies read (`jwt.header`); default `authorization`. */
  readonly header?: string;
  /** The scheme the bearer strategies read (`jwt.scheme`); default `bearer`. */
  readonly scheme?: string;
}

/**
 * The internal `bearer-challenge` middleware.
 *
 * It runs the rest of the chain, then adds a challenge only when the response
 * carries none yet: on `401` with `invalid_token` for a Bearer-carrying request
 * (bare otherwise), on a `403` whose refusal recorded required scopes, and on a
 * thrown error whose status hint is `401` (before rethrowing). Every other
 * status, including a sign-in redirect, is left untouched.
 *
 * @param deps - The configured metadata URL and the bearer header and scheme
 * @returns The middleware function
 */
export function bearerChallenge(deps: BearerChallengeDeps = {}): MiddlewareFunction {
  const resourceMetadata = deps.resourceMetadata;
  const header = deps.header ?? 'authorization';
  const scheme = (deps.scheme ?? 'bearer').toLowerCase();
  const withMetadata = (options: BearerChallengeOptions): BearerChallengeOptions =>
    resourceMetadata === undefined ? options : { ...options, resourceMetadata };
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    try {
      await next();
    } catch (error) {
      const snapshot = ctx.response.snapshot();
      if (httpStatusHintOf(error)?.status === 401 && !snapshot.headers.has('www-authenticate')) {
        ctx.response.header(
          'WWW-Authenticate',
          formatBearerChallenge(
            withMetadata(carriesBearer(ctx, header, scheme) ? { error: 'invalid_token' } : {}),
          ),
        );
      }
      throw error;
    }

    const snapshot = ctx.response.snapshot();
    if (snapshot.headers.has('www-authenticate')) {
      return;
    }
    if (snapshot.status === 401) {
      const options: BearerChallengeOptions = carriesBearer(ctx, header, scheme)
        ? { error: 'invalid_token' }
        : {};
      ctx.response.header('WWW-Authenticate', formatBearerChallenge(withMetadata(options)));
      return;
    }
    if (snapshot.status === 403) {
      const scopes = requiredScopesOf(ctx);
      if (scopes === undefined) {
        return;
      }
      ctx.response.header(
        'WWW-Authenticate',
        formatBearerChallenge(withMetadata({ error: 'insufficient_scope', scopes })),
      );
    }
  };
}
