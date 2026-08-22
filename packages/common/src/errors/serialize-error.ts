/**
 * Pure error serialization for structured logging.
 *
 * An `Error` placed directly in log metadata renders as `{}` under
 * `JSON.stringify`, because `message` and `stack` are non-enumerable. This
 * module turns any thrown value into a plain, serializable
 * {@linkcode SerializedError} so the class of mistake cannot recur through any
 * call site. `@setu-ts/logger-plugin` normalizes any `Error` found in merged
 * metadata before redaction with this, and the known raw-`Error` call sites
 * call it explicitly so they stay correct under a third-party `ILogger` that
 * does not normalize.
 *
 * The `cause` chain is serialized recursively to a bounded depth so a
 * self-referential cause cannot recurse forever.
 *
 * @module
 */

/**
 * A plain, serializable representation of a thrown value.
 *
 * @since 0.1.0
 */
export interface SerializedError {
  /** The error's `name` (e.g. `'Error'`, `'HttpError'`), or `'Error'` for a non-`Error` value. */
  readonly name: string;
  /** The error's `message`, or the stringified value for a non-`Error` value. */
  readonly message: string;
  /** The error's `stack`, when present. */
  readonly stack?: string;
  /** The serialized `cause`, when the error carries one. */
  readonly cause?: SerializedError;
}

/**
 * The depth at which the `cause` chain stops being followed. A cause at this
 * depth is reported as a message-only {@linkcode SerializedError} with no
 * further `cause`, which bounds a self-referential chain.
 */
const MAX_CAUSE_DEPTH = 10;

/**
 * Stringifies any value without throwing.
 *
 * `String(value)` throws a `TypeError` for a value with no path to a primitive
 * — a null-prototype object (`Object.create(null)`) has neither `toString` nor
 * `valueOf`, and an object may define a `toString` that throws. Both can reach
 * here, because `serializeError` accepts any thrown value and any `cause`.
 * A serializer that runs on logging paths must never replace the error it was
 * asked to describe with a failure of its own: `ConsoleLogger` normalizes raw
 * `Error` metadata through this, so a throw here escapes `logger.error(...)`
 * and crashes the caller that was merely reporting a problem.
 *
 * (A `symbol` is NOT such a value — `String(Symbol('x'))` is specified to
 * return `'Symbol(x)'` rather than throw, unlike `'' + sym`.)
 *
 * @param value - Any value
 * @returns Its string form, or a structural description when it has none
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Serializes any thrown value to a plain, serializable object.
 *
 * An `Error` yields `{ name, message, stack?, cause? }` with the `cause` chain
 * followed to a bounded depth. A non-`Error` value (a string, a number, a
 * plain object) yields `{ name: 'Error', message: <stringified> }` — the same
 * shape, so a caller can always read `name` and `message` without narrowing.
 *
 * @param value - The thrown value
 * @returns A plain, serializable representation
 * @since 0.1.0
 */
export function serializeError(value: unknown): SerializedError {
  if (value instanceof Error) {
    return serializeErrorInstance(value, MAX_CAUSE_DEPTH);
  }
  return { name: 'Error', message: safeString(value) };
}

/**
 * Serializes an `Error`, following its `cause` chain while `depth` allows.
 *
 * @param error - The error to serialize
 * @param depth - Remaining cause-chain depth
 * @returns A plain, serializable representation
 */
function serializeErrorInstance(error: Error, depth: number): SerializedError {
  const out: {
    name: string;
    message: string;
    stack?: string;
    cause?: SerializedError;
  } = {
    name: error.name,
    message: error.message,
  };
  if (error.stack !== undefined) {
    out.stack = error.stack;
  }
  if (depth > 0 && error.cause !== undefined) {
    out.cause = error.cause instanceof Error
      ? serializeErrorInstance(error.cause, depth - 1)
      : { name: 'Error', message: safeString(error.cause) };
  }
  return out;
}
