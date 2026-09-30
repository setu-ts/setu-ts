/**
 * Auth plugin configuration types.
 *
 * @module
 */

import type {
  IAuthStrategy,
  IPrincipal,
  PathPattern,
  RbacConfig,
  SessionView,
} from '@setu-ts/common';
import type { IAccessTokenRevocationStore } from '../stores/access-token-revocation-store.ts';

/**
 * JWT configuration options.
 *
 * @since 0.1.0
 */
export interface JwtOptions {
  /** Secret key for HS256 algorithm. Required if RS256 keys not provided. */
  readonly secret?: string | Uint8Array;
  /** Private key for RS256 signing (PEM format). Required if HS256 secret not provided. */
  readonly privateKey?: string;
  /** Public key for RS256 verification (PEM format). Required for RS256 verification. */
  readonly publicKey?: string;
  /** Algorithm to use. Inferred from key material if omitted. */
  readonly algorithm?: 'HS256' | 'RS256';
  /** Expected audience for verification. */
  readonly audience?: string;
  /** Expected issuer for verification. */
  readonly issuer?: string;
  /** Header name for token extraction (default: 'authorization'). */
  readonly header?: string;
  /** Token scheme prefix (default: 'bearer'). */
  readonly scheme?: string;
  /**
   * Optional shared store that rejects revoked typed access credentials.
   * Supply the same instance to `RefreshTokenService` for logout invalidation.
   */
  readonly accessTokenRevocationStore?: IAccessTokenRevocationStore;
}

/**
 * API key configuration options.
 *
 * @since 0.1.0
 */
export interface ApiKeyOptions {
  /** Header name for API key (default: 'X-API-Key'). */
  readonly header?: string;
  /**
   * Callback to validate the API key and return a principal.
   * Return `null` if the key is invalid.
   */
  readonly validate: (key: string) => Promise<IPrincipal | null>;
}

/**
 * Local (credentials) configuration options.
 *
 * @since 0.1.0
 */
export interface LocalOptions {
  /**
   * Callback to verify credentials (e.g., username/password).
   * Return `null` if credentials are invalid.
   */
  readonly verify: (identifier: string, secret: string) => Promise<IPrincipal | null>;
}

/**
 * Session authentication configuration options.
 *
 * The session payload is application data, so the framework picks no
 * conventional key: `toPrincipal` is the one place that knows where an
 * identity lives inside the payload, and it is required.
 *
 * @since 0.1.0
 */
export interface SessionAuthOptions {
  /**
   * Maps an opened session to the principal it carries. Return `null` when
   * the session holds no identity — the strategy chain then continues.
   */
  readonly toPrincipal: (view: SessionView) => IPrincipal | null;
}

/**
 * Authorization decision-explanation options (M98h).
 *
 * Opt-in observation of the first-party RBAC evaluation. `enabled` must be
 * `true`; the option is validated at construction, so a malformed option —
 * including `enabled: false` from a caller the literal type cannot reach —
 * refuses before any application exists, with a fixed, value-free message.
 *
 * `roles` and `permissions` are exact-name → display-alias maps for the rules
 * the explanations may name. Every alias and the optional `policyRevision`
 * carry M98d's shape rule verbatim: non-empty UTF-8, 1–64 bytes, no control
 * character, unique within its map. Up to 128 entries per map. A decision
 * whose requested rules are not ALL approved is dropped before buffering and
 * counted in the batch's `droppedUnapproved` — partial rule lists are never
 * emitted, because a position in a partial list still identifies the rule.
 * A granting principal role is reported only when it has an approved role
 * alias.
 *
 * @since 0.8.0
 */
export interface AuthorizationDiagnosticsOptions {
  /** Observation is explicit; must be `true`. */
  readonly enabled: boolean;
  /** Exact role name → approved display alias. At most 128 entries. */
  readonly roles: Readonly<Record<string, string>>;
  /** Exact permission name → approved display alias. At most 128 entries. */
  readonly permissions: Readonly<Record<string, string>>;
  /** Approved alias for the policy revision, present only when configured. */
  readonly policyRevision?: string;
}

/**
 * Global authentication middleware configuration.
 *
 * Authentication runs for every path by default. Supply exclusions only for
 * routes that never need a principal, or disable registration to attach
 * {@linkcode authMiddleware} at route level yourself.
 *
 * @since 0.8.0
 */
export interface AuthMiddlewareOption {
  /** Execution priority. Defaults to the authentication band at 300. */
  readonly priority?: number;
  /** Paths that skip passive authentication. Defaults to no exclusions. */
  readonly exclude?: readonly PathPattern[];
}

/**
 * A signature algorithm accepted from an outside issuer. `'EdDSA'` also admits a
 * token whose header carries the fully-specified `alg: 'Ed25519'` (RFC 9864);
 * both require an `OKP`/`Ed25519` key. HMAC algorithms and `none` are never
 * accepted from an issuer, whatever the allowlist says.
 *
 * @since 0.8.0
 */
export type IssuerAlgorithm = 'RS256' | 'PS256' | 'ES256' | 'ES384' | 'EdDSA';

/**
 * Where an outside issuer's signing keys are read from: an explicit JWKS URL,
 * or OpenID Connect discovery (`<issuer>/.well-known/openid-configuration`,
 * whose `jwks_uri` is used). Both URLs must be `https`, or `http` on a
 * loopback host.
 *
 * @since 0.8.0
 */
export type IssuerKeySource = { readonly jwksUri: string } | { readonly discovery: true };

/**
 * An identity provider whose access tokens this application accepts.
 *
 * A token is routed to the entry whose `issuer` equals its `iss` claim exactly,
 * then verified against that issuer's published key set. `audience` is
 * required: without it a token the same provider minted for a different API
 * would be accepted.
 *
 * @since 0.8.0
 */
export interface TrustedIssuer {
  /** Unique name, used in health output and logs. */
  readonly name: string;
  /** Exact `iss` value this entry accepts. */
  readonly issuer: string;
  /** Audience that must appear in the token's `aud` claim. */
  readonly audience: string;
  /** Key-set source. */
  readonly keys: IssuerKeySource;
  /** Algorithm allowlist. Defaults to all five supported algorithms. */
  readonly algorithms?: readonly IssuerAlgorithm[];
  /** Clock tolerance for `exp`/`nbf`/`iat`, in seconds, `0`–`300`. Default `30`. */
  readonly clockToleranceSec?: number;
  /**
   * Key-set cache timings, in milliseconds, each a finite positive number:
   * `ttlMs` (default 10 minutes) before a refetch, `minRefreshIntervalMs`
   * (default 60 s) between fetch attempts, `fetchTimeoutMs` (default 5 s, at most 2147483647) per
   * fetch, and `maxStaleMs` (default 24 hours) that the last good set stays
   * usable after it was last confirmed while fetches fail.
   */
  readonly keySet?: {
    readonly ttlMs?: number;
    readonly minRefreshIntervalMs?: number;
    readonly fetchTimeoutMs?: number;
    readonly maxStaleMs?: number;
  };
  /**
   * Maps the verified claims to a principal. Return `null` to leave the request
   * anonymous. The plugin never guesses where a provider puts roles.
   *
   * `sub` is unique only within its issuer. Whenever this issuer is not the
   * application's only identity source — another issuer, a self-issued `jwt`
   * (whose strategy also maps `sub` to the id), an API key, a session, or a
   * custom strategy — namespace the id (for example
   * `` `${claims.iss}|${claims.sub}` ``). Namespacing this side alone is not
   * enough when another source can produce an id of the same form (a
   * self-issued `sub` or a username a user chooses, say): namespace every
   * source (for example `` `local|${id}` ``), or keep the other sources' ids
   * free of the separator.
   */
  toPrincipal(
    claims: Readonly<Record<string, unknown>>,
  ): IPrincipal | null | Promise<IPrincipal | null>;
}

/**
 * Outbound HTTP seam used to fetch key sets, read discovery documents, and
 * exchange an authorization code at a provider's token endpoint. Defaults to one
 * over `fetch`. An implementation must reject once the response body exceeds
 * `maxBytes` while reading it, and must honour `signal`.
 *
 * @since 0.8.0
 */
export interface IAuthHttp {
  /**
   * Performs a GET request.
   *
   * @param url - Absolute URL
   * @param options - Abort signal and response-body byte limit
   * @returns The status code and the body as text
   */
  get(
    url: string,
    options: { readonly signal: AbortSignal; readonly maxBytes: number },
  ): Promise<{ readonly status: number; readonly body: string }>;
  /**
   * Performs a `POST` whose body is `form` encoded as
   * `application/x-www-form-urlencoded`, for the OAuth 2.0 token endpoint.
   *
   * `form` is passed as a map rather than a pre-encoded string so the seam, not
   * each caller, owns the encoding: a secret containing `&` or `+` must not be
   * able to inject a second parameter into the request.
   *
   * @param url - Absolute URL
   * @param options - Abort signal, response-body byte limit, the form fields, and
   *   any extra request headers (for example the `client_secret_basic` credential)
   * @returns The status code and the body as text
   * @since 0.8.0
   */
  post(
    url: string,
    options: {
      readonly signal: AbortSignal;
      readonly maxBytes: number;
      readonly form: Readonly<Record<string, string>>;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<{ readonly status: number; readonly body: string }>;
}

/**
 * Auth plugin configuration options.
 *
 * @since 0.1.0
 */
export interface AuthPluginOptions {
  /** JWT configuration. Omit when the application uses another strategy. */
  readonly jwt?: JwtOptions;
  /**
   * Global authentication middleware configuration. Omit to register it at
   * priority 300, or pass `false` when attaching it per route yourself.
   */
  readonly middleware?: false | AuthMiddlewareOption;
  /** API key configuration. Optional. */
  readonly apiKey?: ApiKeyOptions;
  /** Local credentials configuration. Optional. */
  readonly local?: LocalOptions;
  /**
   * RBAC configuration. When absent, AuthPlugin registers JWT authentication
   * only and does not provide the authorization capability.
   */
  readonly rbac?: RbacConfig;
  /**
   * Authorization decision-explanation observation (M98h). When present, the
   * plugin attaches a collector to its own `RbacService` and registers an
   * `IAuthorizationDiagnosticsSource` under
   * `CAPABILITIES.AUTHORIZATION_DIAGNOSTICS`. When absent, the same token is
   * still registered with a `disabled`-answering source. The boolean
   * `IAuthorizationService` remains authoritative and unchanged; a diagnostic
   * failure can never alter an allow/deny or a guard's short-circuit order.
   */
  readonly authorizationDiagnostics?: AuthorizationDiagnosticsOptions;
  /**
   * Session authentication configuration. When present, the plugin appends an
   * internal session strategy after the API-key strategy and requires the
   * `session` capability (SessionPlugin) to be registered.
   */
  readonly session?: SessionAuthOptions;
  /**
   * Caller-supplied strategies, appended after every built-in in declaration
   * order. A strategy whose `name` collides with any other strategy in the
   * assembled chain makes `register()` throw.
   */
  readonly strategies?: readonly IAuthStrategy[];
  /**
   * Outside identity providers whose access tokens are accepted (M100b). Builds
   * an internal `issuers` strategy placed immediately after the JWT strategy,
   * reading the same header and scheme as `jwt`, and registers an `auth`
   * health indicator reporting each issuer's cached key-set state.
   */
  readonly issuers?: readonly TrustedIssuer[];
  /** Outbound HTTP seam for `issuers`. Defaults to one over `fetch`. */
  readonly http?: IAuthHttp;
}
