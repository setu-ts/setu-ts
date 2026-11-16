/**
 * Configuration and backend errors raised by the authentication plugin.
 *
 * @module
 */

import { describeError, withHttpStatusHint } from '@setu-ts/common';

/** The fixed public detail of {@linkcode AuthenticationUnavailableError}. */
const UNAVAILABLE_DETAIL = 'Authentication is temporarily unavailable.';

/** The marker that ends a description `describeError` had to cut. */
const TRUNCATION_MARKER = '… [truncated]';

/** Characters `describeError` renders as one space; a credential is matched as rendered. */
const NON_PRINTING_RUN = /[\s\p{Cc}\p{Cf}]+/gu;

/**
 * Replaces every occurrence of a presented credential in a one-line description with `***`.
 *
 * The credential is matched both as sent and as `describeError` renders it (whitespace
 * and control runs collapsed to one space). When the description was cut, a tail that
 * is the start of the credential is replaced too, so a cut cannot leave part of it.
 *
 * @param text - The `describeError` output
 * @param credential - The credential the client presented; empty leaves the text unchanged
 * @returns The text with the credential replaced
 */
function withoutCredential(text: string, credential: string): string {
  if (credential === '') return text;
  let out = text;
  for (const form of new Set([credential, credential.replace(NON_PRINTING_RUN, ' ')])) {
    if (form !== '') out = out.split(form).join('***');
  }
  if (!out.endsWith(TRUNCATION_MARKER)) return out;
  const body = out.slice(0, -TRUNCATION_MARKER.length);
  for (let length = credential.length - 1; length > 0; length--) {
    if (body.endsWith(credential.slice(0, length))) {
      return `${body.slice(0, -length)}***${TRUNCATION_MARKER}`;
    }
  }
  return out;
}

/**
 * An authentication validator failure carrying a fixed HTTP 503 hint.
 *
 * The public detail is fixed. The error's own message, which the error handler logs, adds a
 * one-line description of the underlying fault with the presented credential replaced by
 * `***`: a database error that echoes a malformed key (`invalid input syntax for type uuid`)
 * must not write the client's key to the log. The cause is kept on the error for application
 * code, and carries the serializer's redact-cause brand, so a log built with `serializeError`
 * shows only its class and this message.
 * @since 0.13.0
 */
export class AuthenticationUnavailableError extends Error {
  /** Stable discriminant across realms. */
  override readonly name = 'AuthenticationUnavailableError';

  /**
   * @param cause - Original validator failure, kept unchanged on `cause`
   * @param credential - The credential the client presented, removed from the message
   */
  constructor(cause: unknown, credential = '') {
    super(`${UNAVAILABLE_DETAIL} ${withoutCredential(describeError(cause), credential)}`, {
      cause,
    });
    // Same brand, same registration as the runtime's RequestBodyReadError (common's
    // serialize-error.ts): the serialized cause keeps only its class and this message.
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
