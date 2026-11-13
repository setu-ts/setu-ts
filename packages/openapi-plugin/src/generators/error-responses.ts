/**
 * Derives the error statuses and headers a route's own middleware answers
 * with, from the brands that middleware carries (M137b §3.2–§3.5). Internal:
 * not exported from the package barrel.
 *
 * @module
 */
import type { RouteInfo } from '@setu-ts/common';
import {
  idempotencyMetadataOf,
  rateLimitMetadataOf,
  securityMetadataOf,
  validationMetadataOf,
} from '@setu-ts/common';

/** A response header as emitted in the document (schema already resolved). */
export interface DerivedHeader {
  /** What the header carries. */
  readonly description: string;
  /** The header value's schema. */
  readonly schema: Readonly<Record<string, unknown>>;
}

/** What a route's middleware can answer, read from its brands. */
export interface ErrorFacts {
  /** A guard requires a principal, or can refuse one (`401`). */
  readonly unauthorized: boolean;
  /** A guard can refuse an authenticated caller (`403`). */
  readonly forbidden: boolean;
  /** A `403`-capable guard records required OAuth scopes (`insufficient_scope`). */
  readonly forbiddenWithScopes: boolean;
  /** A body validator refuses an unsupported media type (`415`). */
  readonly unsupportedMedia: boolean;
  /** A route-level limiter, and whether it writes the standard fields. */
  readonly rateLimit: { readonly standardHeaders: boolean } | undefined;
  /** Idempotency middleware on a method it governs, and its principal rule. */
  readonly idempotency: { readonly principalRequired: boolean } | undefined;
}

/** Methods the idempotency middleware passes through untouched. */
const IDEMPOTENCY_EXEMPT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads every brand on a route's own `middleware` array. App-wide middleware
 * is not visible here (M137b §2 C2).
 *
 * @param route - The route being documented
 * @returns What its middleware can answer
 */
export function collectErrorFacts(route: RouteInfo): ErrorFacts {
  let unauthorized = false;
  let forbidden = false;
  let forbiddenWithScopes = false;
  let unsupportedMedia = false;
  let rateLimit: { standardHeaders: boolean } | undefined;
  let idempotency: { principalRequired: boolean } | undefined;
  const governsIdempotency = !IDEMPOTENCY_EXEMPT_METHODS.has(route.method.toUpperCase());

  for (const middleware of route.definition.middleware ?? []) {
    const security = securityMetadataOf(middleware);
    if (security !== undefined) {
      if (security.authenticated || security.forbids === true) unauthorized = true;
      if (security.forbids === true) {
        forbidden = true;
        if (security.scopes !== undefined && security.scopes.length > 0) {
          forbiddenWithScopes = true;
        }
      }
    }
    if (validationMetadataOf(middleware)?.target === 'body') unsupportedMedia = true;
    const limiter = rateLimitMetadataOf(middleware);
    if (limiter !== undefined) {
      rateLimit = {
        standardHeaders: (rateLimit?.standardHeaders ?? false) || limiter.standardHeaders,
      };
    }
    const idempotent = idempotencyMetadataOf(middleware);
    if (idempotent !== undefined && governsIdempotency) {
      idempotency = {
        principalRequired:
          (idempotency?.principalRequired ?? false) || idempotent.principalRequired !== false,
      };
    }
  }

  return { unauthorized, forbidden, forbiddenWithScopes, unsupportedMedia, rateLimit, idempotency };
}

/**
 * Whether the scheme `deriveSecurity` names is one the `bearer-challenge`
 * middleware answers for: HTTP bearer, OAuth 2.0 or OpenID Connect. Only then
 * does a `401` carry `WWW-Authenticate` (M137b §3.2).
 *
 * @param scheme - The scheme name from `deriveSecurity`, when configured
 * @param securitySchemes - The document's declared schemes
 * @returns `true` when the challenge header is documented
 */
export function documentsBearerChallenge(
  scheme: string | undefined,
  securitySchemes: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (scheme === undefined) return false;
  const declared: unknown = securitySchemes?.[scheme];
  if (typeof declared !== 'object' || declared === null) return false;
  const { type, scheme: httpScheme } = declared as { type?: unknown; scheme?: unknown };
  if (type === 'oauth2' || type === 'openIdConnect') return true;
  return type === 'http' && typeof httpScheme === 'string' && httpScheme.toLowerCase() === 'bearer';
}

/** `WWW-Authenticate` as documented on a derived `401` or scope `403`. */
export const WWW_AUTHENTICATE_HEADER: DerivedHeader = Object.freeze({
  description: 'The authentication challenge (RFC 6750).',
  schema: Object.freeze({ type: 'string' }),
});

/** `Retry-After` as documented on a limiter's `429`. */
export const RETRY_AFTER_HEADER: DerivedHeader = Object.freeze({
  description: 'Seconds until the rate-limit window resets.',
  schema: Object.freeze({ type: 'integer', minimum: 0 }),
});

/** The `RateLimit` field of draft-ietf-httpapi-ratelimit-headers. */
export const RATE_LIMIT_HEADER: DerivedHeader = Object.freeze({
  description: 'Remaining quota and reset time (draft-ietf-httpapi-ratelimit-headers).',
  schema: Object.freeze({ type: 'string' }),
});

/** The `RateLimit-Policy` field of draft-ietf-httpapi-ratelimit-headers. */
export const RATE_LIMIT_POLICY_HEADER: DerivedHeader = Object.freeze({
  description: 'The quota policy (draft-ietf-httpapi-ratelimit-headers).',
  schema: Object.freeze({ type: 'string' }),
});

/** `Idempotent-Replayed` as documented on an idempotent route's success responses. */
export const IDEMPOTENT_REPLAYED_HEADER: DerivedHeader = Object.freeze({
  description: 'Present when the response is a replay of a stored one.',
  schema: Object.freeze({ type: 'string', enum: Object.freeze(['true']) }),
});

/**
 * The RFC 9457 Problem Details object (§3.1): every member optional, extension
 * members allowed — so no `required` list and no `additionalProperties: false`.
 */
export const PROBLEM_DETAILS_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    type: Object.freeze({ type: 'string', format: 'uri-reference', default: 'about:blank' }),
    title: Object.freeze({ type: 'string' }),
    status: Object.freeze({ type: 'integer', minimum: 100, maximum: 599 }),
    detail: Object.freeze({ type: 'string' }),
    instance: Object.freeze({ type: 'string', format: 'uri-reference' }),
  }),
});

/** One derived error status and the headers it carries. */
export interface DerivedErrorStatus {
  /** The HTTP status. */
  readonly status: number;
  /** Headers keyed by name. */
  readonly headers: Readonly<Record<string, DerivedHeader>>;
}

/**
 * Turns the brand facts into the error statuses to add and the headers every
 * success response gains. Each status appears once; where two sources produce
 * one status (idempotency and a limiter both answer `429`), the headers merge.
 *
 * @param facts - What the route's middleware can answer
 * @param challenge - Whether `WWW-Authenticate` is documented (see {@linkcode documentsBearerChallenge})
 * @returns The error statuses, ascending, and the success-response headers
 */
export function deriveErrorStatuses(
  facts: ErrorFacts,
  challenge: boolean,
): {
  readonly errors: readonly DerivedErrorStatus[];
  readonly successHeaders: Readonly<Record<string, DerivedHeader>>;
} {
  const byStatus = new Map<number, Record<string, DerivedHeader>>();
  const add = (status: number, headers: Record<string, DerivedHeader> = {}): void => {
    byStatus.set(status, { ...byStatus.get(status), ...headers });
  };
  const successHeaders: Record<string, DerivedHeader> = {};

  if (facts.unauthorized || facts.idempotency?.principalRequired === true) {
    add(401, challenge ? { 'WWW-Authenticate': WWW_AUTHENTICATE_HEADER } : {});
  }
  if (facts.forbidden) {
    add(
      403,
      challenge && facts.forbiddenWithScopes ? { 'WWW-Authenticate': WWW_AUTHENTICATE_HEADER } : {},
    );
  }
  if (facts.unsupportedMedia) add(415);
  if (facts.rateLimit !== undefined) {
    const standard = facts.rateLimit.standardHeaders
      ? { RateLimit: RATE_LIMIT_HEADER, 'RateLimit-Policy': RATE_LIMIT_POLICY_HEADER }
      : {};
    add(429, { 'Retry-After': RETRY_AFTER_HEADER, ...standard });
    Object.assign(successHeaders, standard);
  }
  if (facts.idempotency !== undefined) {
    add(400);
    add(409);
    add(422);
    add(429);
    successHeaders['Idempotent-Replayed'] = IDEMPOTENT_REPLAYED_HEADER;
  }

  const errors = [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, headers]) => ({ status, headers }));
  return { errors, successHeaders };
}
