/**
 * Serializes log metadata without ever throwing out of a log call.
 *
 * `LogMetadata` is `Readonly<Record<string, unknown>>` — it carries no JSON
 * constraint — so every value `JSON.stringify` refuses is legal metadata by the
 * contract. `common`'s `JsonValue` documents that limit for SSE precisely
 * because it chose a narrow type; the logger did not, and then died on the
 * difference. Measured, four inputs took the caller down: a circular structure,
 * a `bigint`, a throwing `toJSON`, and a throwing getter. Pino survives all
 * four, so the default logger was also the only one that could not.
 *
 * A logger is the worst place for this. Logging is what a `catch` block does,
 * so a throw here replaces the error being reported with a `TypeError` about
 * serialization — the original fault is lost and the handler that would have
 * recovered never runs.
 *
 * This helper is internal — it is not re-exported from `index.ts`
 * (AI_GUIDELINES §10.1), matching {@linkcode normalizeMetadata} beside it.
 *
 * @module
 */

/**
 * Replaces a value that closes a cycle. Deliberately the same token pino emits,
 * so the two transports describe one shape identically.
 */
const CIRCULAR = '[Circular]';

/**
 * Builds a `JSON.stringify` replacer that neutralizes the values which would
 * otherwise throw.
 *
 * Cycles are detected by tracking the **ancestor chain**, never a set of every
 * object already seen. That distinction is the whole correctness of this
 * function rather than a refinement: a `WeakSet` of seen objects reports the
 * second appearance of a legitimately shared object as circular, so
 * `{ x: user, y: user }` serializes as `{"x":{…},"y":"[Circular]"}` and loses a
 * field the caller supplied. Measured against pino, which renders both — an
 * object is only circular when it is its own ancestor.
 *
 * The walk is depth-first and the replacer's `this` is the holder of `key`, so
 * popping until the stack's top is the holder unwinds exactly the branches that
 * have been left.
 *
 * @returns A replacer function with its own private ancestor stack
 */
function createReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function (this: unknown, _key: string, value: unknown): unknown {
    // A bigint is legal metadata and `JSON.stringify` refuses it outright.
    // Rendered as its decimal STRING rather than pino's unquoted digits: pino's
    // form is exact in the emitted bytes but silently loses precision the
    // moment a consumer calls `JSON.parse`, because the digits land in a JS
    // number. The quoted form survives that round trip, and the divergence is
    // one a reader can see rather than one that corrupts a value.
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return CIRCULAR;
    }
    ancestors.push(value);
    return value;
  };
}

/**
 * Serializes `value` to a JSON line, or reports that it cannot be serialized at
 * all.
 *
 * Cycles and `bigint`s are neutralized in the replacer, so the only remaining
 * failure is caller code that throws while being read — a `toJSON` or a getter.
 * That cannot be handled per value, because the throw happens inside
 * `JSON.stringify`'s own property read rather than in the replacer, so it is
 * caught here and reported to the caller to decide.
 *
 * @param value - The value to serialize
 * @returns The JSON text, or `undefined` when `value` could not be serialized
 */
export function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, createReplacer());
  } catch {
    return undefined;
  }
}
