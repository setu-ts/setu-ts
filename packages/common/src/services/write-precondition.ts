/**
 * Portable equality predicates for conditional database writes.
 *
 * @module
 */

/**
 * A non-empty equality map, conjoined with the row's primary key.
 *
 * Values compare against the stored representation. All fields must match;
 * null, booleans, non-finite numbers, objects and operator/path field names
 * are unsupported.
 *
 * @since 0.9.0
 */
export type WritePrecondition = Readonly<Record<string, string | number>>;

/**
 * The outcome of {@linkcode checkWritePrecondition}: a refusal reason, or
 * private copies of the inputs that a conditional write must use in place of
 * the caller's objects.
 *
 * @typeParam Data - `undefined` when no update payload was supplied
 * @since 0.9.0
 */
export type WritePreconditionCheck<Data> =
  | { readonly ok: false; readonly problem: string }
  | { readonly ok: true; readonly where: WritePrecondition; readonly data: Data };

/** Whether a boundary value is a plain record, including a null-prototype record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copies a plain record's own enumerable string keys, reading each value once.
 * Keys are defined rather than assigned, so an own `__proto__` key lands as a
 * field the validator can see and refuse, instead of replacing the copy's
 * prototype before it is looked at.
 */
function copyRecord(source: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: source[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Validates a conditional predicate (and, for an update, its payload) and
 * returns private copies of both.
 *
 * Validation runs on the copies, and a conditional write sends the copies, so
 * the predicate the backend receives is exactly the one that was validated —
 * even when the caller's object changes its keys or values between reads. An
 * own `__proto__` key is refused in the predicate and in the payload.
 * Refusal reasons contain no caller-supplied field names or values.
 *
 * @param where - A non-empty plain equality map of string or finite-number values
 * @returns A refusal reason, or a copy of `where`
 * @example
 * ```typescript
 * const checked = checkWritePrecondition({ status: 'pending' });
 * if (checked.ok) checked.where; // { status: 'pending' }
 * ```
 * @since 0.9.0
 */
export function checkWritePrecondition(where: unknown): WritePreconditionCheck<undefined>;
/**
 * Validates a conditional predicate and its update payload, returning private
 * copies of both.
 *
 * @param where - A non-empty plain equality map of string or finite-number values
 * @param data - A plain update payload with at least one own field
 * @returns A refusal reason, or copies of `where` and `data`
 * @example
 * ```typescript
 * checkWritePrecondition({ status: 'pending' }, { status: 'sent' }).ok; // true
 * checkWritePrecondition({ status: 'pending' }, {}).ok; // false
 * ```
 * @since 0.9.0
 */
export function checkWritePrecondition(
  where: unknown,
  data: unknown,
): WritePreconditionCheck<Record<string, unknown>>;
export function checkWritePrecondition(
  where: unknown,
  data?: unknown,
): WritePreconditionCheck<Record<string, unknown> | undefined> {
  if (!isPlainRecord(where)) {
    return { ok: false, problem: 'The write precondition must be a plain equality map.' };
  }
  const predicate = copyRecord(where);
  const fields = Object.entries(predicate);
  if (fields.length === 0) {
    return { ok: false, problem: 'The write precondition must contain at least one field.' };
  }
  for (const [field, value] of fields) {
    // `__proto__` is refused rather than carried: Node and Bun drop it from any
    // object a backend rebuilds by assignment (the MongoDB filter, Prisma's
    // serialized query), so the predicate would silently lose a condition.
    if (
      field.length === 0 || field.startsWith('$') || field.includes('.') || field === '__proto__'
    ) {
      return {
        ok: false,
        problem: 'Write precondition field names must be non-empty, without operators, dotted ' +
          'paths or __proto__.',
      };
    }
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      return {
        ok: false,
        problem: 'Write precondition values must be strings or finite numbers.',
      };
    }
  }
  if (arguments.length === 1) {
    return { ok: true, where: predicate as WritePrecondition, data: undefined };
  }
  const payload = isPlainRecord(data) ? copyRecord(data) : undefined;
  if (payload !== undefined && Object.prototype.hasOwnProperty.call(payload, '__proto__')) {
    return {
      ok: false,
      problem: 'The conditional update payload may not carry a __proto__ field.',
    };
  }
  if (payload === undefined || Object.keys(payload).length === 0) {
    return {
      ok: false,
      problem: 'The conditional update payload must be a plain record with at least one own field.',
    };
  }
  return { ok: true, where: predicate as WritePrecondition, data: payload };
}
