/**
 * The class-only log field for a store failure (M109b §3.4, M108 audit F1).
 *
 * A store error's MESSAGE is the one thing that can never be logged: a driver
 * quotes every bound parameter, including a stored result. This returns the
 * error's class name instead, and never the message.
 *
 * @module
 */

/**
 * Describes a thrown value for a log line by CLASS only, never its message.
 *
 * Prefers `error.name`; falls back to the constructor's name; a value with
 * neither (a hostile `name` getter, `Object.create(null)`) is reported as
 * `'Error'`, so the field is always a short class-like token.
 *
 * @internal
 * @param error - Whatever was thrown or rejected
 * @returns The error's class name, never its message
 */
export function errorKind(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  try {
    const name = (error as { readonly name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  } catch {
    // A hostile `name` getter: fall through to the constructor's name.
  }
  try {
    const name = (error as { readonly constructor?: { readonly name?: unknown } }).constructor
      ?.name;
    if (typeof name === 'string' && name.length > 0) return name;
  } catch {
    // A hostile `constructor` getter.
  }
  return 'Error';
}
