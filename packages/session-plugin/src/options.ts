/**
 * Plugin options and their resolution to a fully-defaulted internal config.
 *
 * Resolution lives here, apart from the plugin factory, so that defaults are
 * unit-testable on their own and so both the plugin and the service read one
 * resolved shape rather than each re-deriving defaults.
 *
 * @module
 */
import type { ISessionStore } from '@hono-enterprise/common';

import type { SessionMode } from './codec/crypto.ts';

/** Default session cookie name. */
const DEFAULT_COOKIE_NAME = 'hono_session';
/** Default absolute session lifetime, matching the 2 hours of the reference implementation. */
const DEFAULT_MAX_AGE_SECONDS = 7200;
/**
 * Default cookie byte budget. Browsers drop cookies above roughly 4096 bytes,
 * so this is the point past which a session would silently fail to persist.
 */
const DEFAULT_MAX_COOKIE_BYTES = 4096;
/** Default form field carrying the CSRF token. */
const DEFAULT_CSRF_FIELD = '_csrf';
/** Methods that never require a CSRF token. */
const DEFAULT_IGNORE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Cookie attributes for the session cookie.
 *
 * Defaults are the secure ones (AI_GUIDELINES §13.4): `HttpOnly`, `Secure`, and
 * `SameSite=Lax`. `secure: false` is the documented escape hatch for
 * plain-HTTP local development.
 *
 * @since 0.2.0
 */
export interface SessionCookieOptions {
  /** Cookie name. Default `'hono_session'`. */
  readonly name?: string;
  /** `Path` scope. Default `'/'`. */
  readonly path?: string;
  /** `Domain` scope. Omitted by default, producing a host-only cookie. */
  readonly domain?: string;
  /** `SameSite` policy. Default `'lax'`. */
  readonly sameSite?: 'strict' | 'lax' | 'none';
  /** `Secure` attribute. Default `true`. */
  readonly secure?: boolean;
  /** `HttpOnly` attribute. Default `true`. */
  readonly httpOnly?: boolean;
}

/**
 * Form-CSRF options.
 *
 * @since 0.2.0
 */
export interface CsrfFormOptions {
  /** Form field carrying the token. Default `'_csrf'`. */
  readonly fieldName?: string;
  /**
   * Header that may carry the token instead of a form field, for `fetch`-based
   * posts and for `multipart/form-data` bodies this package does not parse.
   * Omitted by default, meaning the form field is the only source.
   */
  readonly headerName?: string;
  /** Methods that skip verification. Default `['GET', 'HEAD', 'OPTIONS']`. */
  readonly ignoreMethods?: readonly string[];
}

/**
 * Options for {@linkcode SessionPlugin}.
 *
 * @since 0.2.0
 */
export interface SessionPluginOptions {
  /**
   * The session secret, or an ordered list of secrets for rotation: index 0
   * signs/encrypts new cookies while every entry can still open existing ones,
   * so rotating a secret does not log everybody out.
   *
   * When omitted, the secret is resolved from `CAPABILITIES.SECRETS` and then
   * from the environment. Each secret must be at least 32 characters.
   */
  readonly secret?: string | readonly string[];
  /**
   * Name looked up in the secret manager and the environment.
   * Default `'SESSION_SECRET'`.
   */
  readonly secretName?: string;
  /**
   * How the cookie is protected. `'encrypt'` (default) hides the payload with
   * AES-256-GCM; `'sign'` leaves it readable base64url JSON under an
   * HMAC-SHA256 signature, which suits the store strategy where the cookie
   * holds only an opaque id.
   */
  readonly mode?: SessionMode;
  /**
   * Where the payload lives. Omitted (default) keeps it in the cookie itself,
   * which needs no infrastructure. Set to `'memory'`, `'cache'`, or a custom
   * {@linkcode ISessionStore} to keep only an opaque id in the cookie and the
   * payload server-side, which makes immediate revocation possible.
   */
  readonly store?: 'memory' | 'cache' | ISessionStore;
  /** Absolute session lifetime in seconds. Default `7200` (2 hours). */
  readonly maxAge?: number;
  /**
   * Re-issue the cookie on every response, extending the expiry so an active
   * user is not logged out mid-session. Default `false`, which commits only
   * when the session actually changed.
   */
  readonly rolling?: boolean;
  /**
   * Expire a session that has received no requests for this long, independently
   * of `maxAge`. Omitted by default (no idle check).
   *
   * Idleness is refreshed by any request, including a read-only one, which means
   * a configured idle timeout re-issues the cookie on every response (and, on the
   * store strategy, rewrites the stored entry) so the activity stamp can advance.
   * That is the cost of tracking activity; it does not extend absolute expiry,
   * which stays governed by `maxAge` unless `rolling` is also set.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Byte budget for the serialized cookie. Default `4096`. Exceeding it throws
   * rather than emitting a cookie the browser would silently drop.
   */
  readonly maxCookieBytes?: number;
  /** Cookie attributes. */
  readonly cookie?: SessionCookieOptions;
  /**
   * Enable session-backed form CSRF. Omitted means no CSRF middleware is
   * registered; an empty object enables it with defaults.
   */
  readonly csrf?: CsrfFormOptions;
}

/** Fully-defaulted configuration the service and middleware read. */
export interface ResolvedSessionConfig {
  readonly mode: SessionMode;
  readonly cookieName: string;
  readonly cookiePath: string;
  readonly cookieDomain?: string;
  readonly cookieSameSite: 'strict' | 'lax' | 'none';
  readonly cookieSecure: boolean;
  readonly cookieHttpOnly: boolean;
  readonly maxAgeSeconds: number;
  readonly maxAgeMs: number;
  readonly rolling: boolean;
  readonly idleTimeoutMs?: number;
  readonly maxCookieBytes: number;
}

/**
 * Resolves plugin options into a fully-defaulted config.
 *
 * @param options - The caller's options
 * @returns The resolved configuration
 * @throws {TypeError} If `maxAge`, `idleTimeoutMs`, or `maxCookieBytes` is not a positive number
 * @since 0.2.0
 */
export function resolveSessionConfig(options: SessionPluginOptions = {}): ResolvedSessionConfig {
  const maxAgeSeconds = options.maxAge ?? DEFAULT_MAX_AGE_SECONDS;
  requirePositive(maxAgeSeconds, 'maxAge');

  const maxCookieBytes = options.maxCookieBytes ?? DEFAULT_MAX_COOKIE_BYTES;
  requirePositive(maxCookieBytes, 'maxCookieBytes');

  if (options.idleTimeoutMs !== undefined) {
    requirePositive(options.idleTimeoutMs, 'idleTimeoutMs');
  }

  const cookie = options.cookie ?? {};

  // Built in two steps because exactOptionalPropertyTypes forbids assigning
  // `undefined` to an optional property — the optional keys are spread in only
  // when they have a value.
  const base = {
    mode: options.mode ?? 'encrypt',
    cookieName: cookie.name ?? DEFAULT_COOKIE_NAME,
    cookiePath: cookie.path ?? '/',
    cookieSameSite: cookie.sameSite ?? 'lax',
    cookieSecure: cookie.secure ?? true,
    cookieHttpOnly: cookie.httpOnly ?? true,
    maxAgeSeconds,
    maxAgeMs: maxAgeSeconds * 1000,
    rolling: options.rolling ?? false,
    maxCookieBytes,
  } as const;

  return {
    ...base,
    ...(cookie.domain === undefined ? {} : { cookieDomain: cookie.domain }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
  };
}

/** Fully-defaulted form-CSRF configuration. */
export interface ResolvedCsrfConfig {
  readonly fieldName: string;
  readonly headerName?: string;
  readonly ignoreMethods: ReadonlySet<string>;
}

/**
 * Resolves form-CSRF options into a fully-defaulted config.
 *
 * @param options - The caller's CSRF options
 * @returns The resolved configuration, with methods upper-cased for comparison
 * @since 0.2.0
 */
export function resolveCsrfConfig(options: CsrfFormOptions = {}): ResolvedCsrfConfig {
  const methods = options.ignoreMethods ?? DEFAULT_IGNORE_METHODS;
  return {
    fieldName: options.fieldName ?? DEFAULT_CSRF_FIELD,
    ...(options.headerName === undefined ? {} : { headerName: options.headerName }),
    ignoreMethods: new Set(methods.map((m) => m.toUpperCase())),
  };
}

/** Rejects a non-positive or non-finite numeric option at configuration time. */
function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`SessionPlugin option '${name}' must be a positive number, got ${value}.`);
  }
}
