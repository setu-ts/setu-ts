/**
 * Portable equality predicates for conditional database writes.
 *
 * @module
 */

/**
 * A non-empty equality map, conjoined with the row's primary key.
 *
 * Values compare against the stored representation. All fields must match;
 * null, booleans, objects and operator/path field names are unsupported.
 *
 * @since 0.9.0
 */
export type WritePrecondition = Readonly<Record<string, string | number>>;

/** Whether a boundary value is a plain record, including a null-prototype record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Explains why a conditional predicate or supplied update payload is refused.
 * Reasons contain no caller-supplied field names or values.
 *
 * @param where - A non-empty plain equality map of string/number values
 * @param data - When supplied, a plain update payload with at least one own field
 * @returns A refusal reason, or `undefined` when the inputs are acceptable
 * @example
 * ```typescript
 * writePreconditionProblem({ status: 'pending' }, { status: 'sent' }); // undefined
 * writePreconditionProblem({}); // a refusal reason
 * ```
 * @since 0.9.0
 */
export function writePreconditionProblem(where: unknown, data?: unknown): string | undefined {
  if (!isPlainRecord(where)) return 'The write precondition must be a plain equality map.';
  const fields = Object.entries(where);
  if (fields.length === 0) return 'The write precondition must contain at least one field.';
  for (const [field, value] of fields) {
    if (field.length === 0 || field.startsWith('$') || field.includes('.')) {
      return 'Write precondition field names must be non-empty, without operators or dotted paths.';
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      return 'Write precondition values must be strings or numbers.';
    }
  }
  if (arguments.length > 1 && (!isPlainRecord(data) || Object.keys(data).length === 0)) {
    return 'The conditional update payload must be a plain record with at least one own field.';
  }
  return undefined;
}
