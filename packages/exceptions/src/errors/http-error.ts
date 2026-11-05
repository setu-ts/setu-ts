/**
 * `HttpError` — the framework's single concrete HTTP error type.
 *
 * Rather than a deep class hierarchy (`BadRequestError extends HttpError`,
 * `NotFoundError extends HttpError`, …), the framework uses **composition via
 * factory functions** (AI_GUIDELINES §1.4, ARCHITECTURE.md §13). Every HTTP
 * error is an instance of this one class with a `statusCode` set at
 * construction time by a factory. This keeps the hierarchy flat, makes errors
 * trivially serializable, and allows runtime composition of properties.
 *
 * `cause` is forwarded to the ES2022 `Error` cause chain — pass the original
 * error so callers can inspect the root cause without losing the stack.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

import { statusTitle } from './exceptions.ts';

/**
 * A single validation failure carried by a `422` error.
 *
 * Mirrors the shape used by `@setu-ts/validation-plugin` so error
 * payloads are consistent across the validation and exceptions packages.
 *
 * @since 0.1.0
 */
export interface ValidationError {
  /** Dot-path of the offending field (e.g. `"address.zip"`). */
  readonly field: string;
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Optional machine-readable failure code. */
  readonly code?: string;
}

/**
 * Options accepted by the {@linkcode HttpError} constructor.
 *
 * Extracted as a type so factory functions can accept a consistent object.
 *
 * @since 0.1.0
 */
export interface HttpErrorInit {
  /** HTTP status code (e.g. `404`). */
  readonly statusCode: number;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional structured details attached to the error body. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Optional underlying cause (forwarded to the ES2022 `Error` cause chain). */
  readonly cause?: Error;
}

/**
 * The framework's HTTP error type.
 *
 * Throw an instance directly, or — preferably — construct one via a factory
 * function from {@linkcode ./exceptions.ts} so the status code is correct by
 * construction:
 *
 * @example
 * ```typescript
 * import { notFound } from '@setu-ts/exceptions';
 *
 * throw notFound(`User ${id} not found`);
 * ```
 *
 * The error handler middleware inspects the `statusCode` to set the response
 * status, and serializes `message` and `details` into the error body.
 *
 * A `4xx` error is also branded with the `@setu-ts/common` status hint
 * (`{ status, title, detail: message }`), so code that may not import this
 * package — the GraphQL masker, the kernel's fallback when no `errorHandler`
 * is registered — recognises it as a caller error by its own constructor's
 * brand rather than by a `statusCode` shape an HTTP client's error also has.
 * A `5xx` (or out-of-range) status is not branded: a hint promises a
 * caller-safe `detail`, and a server fault's message makes no such promise.
 * The hint is taken when the error is constructed, so assigning to `message`
 * afterwards changes what `errorHandler` serves but not what those readers do —
 * build a new error instead of rewriting one.
 *
 * @since 0.1.0
 */
export class HttpError extends Error {
  /** The HTTP status code this error maps to. */
  readonly statusCode: number;
  /**
   * Structured details appended to the error body. Omitted entirely when not
   * supplied (never `undefined`) so serialization stays clean.
   *
   * `declare` suppresses the ES2022 class-field initialization that would
   * otherwise set this to `undefined` on every instance — it only exists on
   * the object when actually assigned by the constructor.
   */
  declare readonly details?: Readonly<Record<string, unknown>>;

  /**
   * Creates a new `HttpError`.
   *
   * Prefer the factory functions in `exceptions.ts` over calling this
   * constructor directly — they guarantee a correct status code.
   *
   * @param statusCode - HTTP status code (e.g. `404`)
   * @param message - Human-readable error message
   * @param details - Optional structured details; omitted when absent
   * @param cause - Optional underlying error; forwarded to the ES2022 cause chain
   *
   * @example
   * ```typescript
   * const err = new HttpError(404, 'User not found');
   * console.log(err.statusCode); // 404
   * ```
   * @since 0.1.0
   */
  constructor(
    statusCode: number,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    cause?: Error,
  ) {
    // Forward `cause` to the ES2022 Error cause chain when present. Under
    // `exactOptionalPropertyTypes`, passing `{ cause: undefined }` would
    // violate the option, so the options object is built conditionally.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 499) {
      withHttpStatusHint(this, {
        status: statusCode,
        title: statusTitle(statusCode),
        detail: message,
      });
    }
  }

  /**
   * Creates an `HttpError` from an {@linkcode HttpErrorInit} object.
   *
   * Convenience overload used by factory functions so they can branch on
   * optional `details`/`cause` once.
   *
   * @param init - The error options
   * @returns A new `HttpError`
   * @since 0.1.0
   */
  static from(init: HttpErrorInit): HttpError {
    return new HttpError(init.statusCode, init.message, init.details, init.cause);
  }
}
