/**
 * Configuration and backend errors raised by the authentication plugin.
 *
 * @module
 */

import { withHttpStatusHint } from '@setu-ts/common';

/** The fixed public detail of {@linkcode AuthenticationUnavailableError}. */
const UNAVAILABLE_DETAIL = 'Authentication is temporarily unavailable.';

/** A class name safe to log: an identifier, bounded, never request-derived text. */
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * The class of a validator failure, as the only part of it that reaches a log.
 *
 * Read from the class the error was constructed from (the prototype's constructor, whose own
 * `prototype` must point back), not `name` or a `constructor` field, which the thrower can set
 * to any text. A name that is not a plain identifier is logged as `Error`; a
 * thrown non-`Error` is logged by its `typeof`.
 * Every read is guarded: a failure whose prototype, constructor or name throws (a Proxy, an
 * accessor) is logged as `Error`, so building this error can never throw and turn an outage
 * back into an anonymous request.
 *
 * @param cause - The validator failure
 * @returns The class name to log
 */
function causeClass(cause: unknown): string {
  try {
    if (!(cause instanceof Error)) return typeof cause;
    // The class whose prototype the error was built from, never an own or planted `constructor`
    // field: a class's `prototype` points back at the object it constructs.
    const prototype: unknown = Object.getPrototypeOf(cause);
    // An Error's prototype is an object; a Proxy that answers null throws here and is caught.
    const ctor: unknown = (prototype as { constructor?: unknown }).constructor;
    if (typeof ctor !== 'function' || ctor.prototype !== prototype) return 'Error';
    const name: unknown = ctor.name;
    return typeof name === 'string' && CLASS_NAME.test(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}

/**
 * An authentication validator failure carrying a fixed HTTP 503 hint.
 *
 * The public detail is fixed. The error's own message, which the error handler logs, adds only
 * the underlying failure's class, for example `(DatabaseError)`: no text from the failure is
 * logged, because a database error can echo the malformed key the client sent (`invalid input
 * syntax for type uuid`). The cause is kept on the error for application code. This error carries
 * the serializer's redact-cause brand, so a log built with `serializeError` replaces the cause with
 * a generic class name and this message. A validator that needs the fault's text logs it itself, where it knows what is
 * safe to log.
 * @since 0.13.0
 */
export class AuthenticationUnavailableError extends Error {
  /** Stable discriminant across realms. */
  override readonly name = 'AuthenticationUnavailableError';

  /** @param cause - Original validator failure, kept unchanged on `cause` */
  constructor(cause: unknown) {
    super(`${UNAVAILABLE_DETAIL} (${causeClass(cause)})`, { cause });
    // Same brand, same registration as the runtime's RequestBodyReadError (common's
    // serialize-error.ts): the serialized cause becomes a generic class name and this message.
    Object.defineProperty(this, Symbol.for('setu.serialize.redact-cause'), { value: true });
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: UNAVAILABLE_DETAIL,
    });
  }
}

/**
 * Thrown when AuthPlugin is configured without a usable passive
 * authentication strategy or with an invalid middleware priority.
 *
 * The error is exported so startup code can distinguish an authentication
 * configuration failure from an unrelated application boot failure.
 *
 * @since 0.8.0
 */
export class AuthPluginConfigurationError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'AuthPluginConfigurationError';

  /**
   * Creates an authentication plugin configuration error.
   *
   * @param message - The invalid configuration and how to correct it
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown from `register()` when a `saml` sign-in provider is configured and
 * the SAML library cannot be loaded — at startup, never at the first login.
 *
 * The message names the specifier and, because neither SAML library bundles
 * without it, the Cloudflare Workers `nodejs_compat` compatibility flag. The
 * underlying failure is attached as `cause`.
 *
 * @since 0.8.0
 */
export class SamlRuntimeLoadError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'SamlRuntimeLoadError';

  /**
   * Creates a SAML library load error.
   *
   * @param specifier - The module specifier that failed to load
   * @param cause - The underlying failure
   */
  constructor(specifier: string, cause?: unknown) {
    super(
      `auth-plugin: a saml sign-in provider needs '${specifier}', which could not be loaded. ` +
        "Install it, or inject it through the provider's module option. On Cloudflare Workers " +
        'enable the nodejs_compat compatibility flag, without which it cannot bundle.',
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * A rate-limit Redis connection fault carrying a value-free HTTP 503 hint.
 * The driver failure is retained as cause; this error never admits traffic.
 * @since 0.10.0
 */
export class RateLimitStoreUnavailableError extends Error {
  /** Stable discriminant across realms. */
  override readonly name = 'RateLimitStoreUnavailableError';

  /** @param cause - Original connection fault, preserved unchanged */
  constructor(cause: unknown) {
    super('Rate limiting is temporarily unavailable.', { cause });
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'Rate limiting is temporarily unavailable.',
    });
  }
}

/**
 * A quota backend failure carrying a value-free HTTP 503 hint; reservations fail closed.
 * The driver failure is retained as cause.
 * @since 0.12.0
 */
export class QuotaStoreUnavailableError extends Error {
  /** Stable discriminant across realms. */
  override readonly name = 'QuotaStoreUnavailableError';

  /** @param cause - Original Redis failure */
  constructor(cause: unknown) {
    super('Quota storage is temporarily unavailable.', { cause });
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'Quota storage is temporarily unavailable.',
    });
  }
}
