/**
 * `Result<T, E>` — a discriminated union for operations that can fail
 * without throwing (AI_GUIDELINES §11.7).
 *
 * @module
 */

/**
 * A successful result carrying a value.
 *
 * @typeParam T - The success value type
 * @since 0.1.0
 */
export interface Ok<T> {
  /** Discriminant: `true` for success. */
  readonly success: true;
  /** The success value. */
  readonly value: T;
}

/**
 * A failed result carrying an error.
 *
 * @typeParam E - The error type
 * @since 0.1.0
 */
export interface Err<E> {
  /** Discriminant: `false` for failure. */
  readonly success: false;
  /** The error value. */
  readonly error: E;
}

/**
 * The result of an operation that can fail: either {@linkcode Ok} or
 * {@linkcode Err}. Narrow with the `success` discriminant or the
 * {@linkcode isOk}/{@linkcode isErr} guards.
 *
 * @typeParam T - The success value type
 * @typeParam E - The error type (defaults to `Error`)
 * @example
 * ```typescript
 * function parsePort(raw: string): Result<number, RangeError> {
 *   const port = Number(raw);
 *   return Number.isInteger(port) && port > 0 && port < 65536
 *     ? ok(port)
 *     : err(new RangeError(`Invalid port: ${raw}`));
 * }
 *
 * const result = parsePort('3000');
 * if (result.success) {
 *   listen(result.value);
 * }
 * ```
 * @since 0.1.0
 */
export type Result<T, E = Error> = Ok<T> | Err<E>;

/**
 * Creates a successful {@linkcode Result}.
 *
 * @typeParam T - The success value type
 * @param value - The success value
 * @returns An `Ok` result wrapping the value
 * @since 0.1.0
 */
export function ok<T>(value: T): Ok<T> {
  return { success: true, value };
}

/**
 * Creates a failed {@linkcode Result}.
 *
 * @typeParam E - The error type
 * @param error - The error value
 * @returns An `Err` result wrapping the error
 * @since 0.1.0
 */
export function err<E>(error: E): Err<E> {
  return { success: false, error };
}

/**
 * Type guard: narrows a {@linkcode Result} to {@linkcode Ok}.
 *
 * @typeParam T - The success value type
 * @typeParam E - The error type
 * @param result - The result to inspect
 * @returns `true` if the result is `Ok`
 * @since 0.1.0
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.success;
}

/**
 * Type guard: narrows a {@linkcode Result} to {@linkcode Err}.
 *
 * @typeParam T - The success value type
 * @typeParam E - The error type
 * @param result - The result to inspect
 * @returns `true` if the result is `Err`
 * @since 0.1.0
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.success;
}

/**
 * Unwraps a {@linkcode Result}, returning the value or throwing the error.
 *
 * Prefer narrowing with the `success` discriminant; reserve `unwrap` for
 * contexts where failure is a programming error.
 *
 * @typeParam T - The success value type
 * @typeParam E - The error type
 * @param result - The result to unwrap
 * @returns The success value
 * @throws The `Err` error value when the result is a failure
 * @since 0.1.0
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.success) {
    return result.value;
  }
  throw result.error;
}
