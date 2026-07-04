/**
 * `Option<T>` — an explicit optional type for values that may be absent,
 * used where `T | undefined` would be ambiguous (e.g., when `undefined` is a
 * legitimate stored value).
 *
 * @module
 */

/**
 * An `Option` holding a value.
 *
 * @typeParam T - The contained value type
 * @since 0.1.0
 */
export interface Some<T> {
  /** Discriminant: `true` when a value is present. */
  readonly present: true;
  /** The contained value. */
  readonly value: T;
}

/**
 * An `Option` holding no value.
 *
 * @since 0.1.0
 */
export interface None {
  /** Discriminant: `false` when no value is present. */
  readonly present: false;
}

/**
 * An optional value: either {@linkcode Some} or {@linkcode None}. Narrow
 * with the `present` discriminant or the {@linkcode isSome}/{@linkcode isNone}
 * guards.
 *
 * @typeParam T - The contained value type
 * @example
 * ```typescript
 * function findUser(id: string): Option<User> {
 *   const user = users.get(id);
 *   return user === undefined ? none() : some(user);
 * }
 *
 * const result = findUser('123');
 * if (result.present) {
 *   greet(result.value);
 * }
 * ```
 * @since 0.1.0
 */
export type Option<T> = Some<T> | None;

/**
 * Frozen singleton for {@linkcode None} — `none()` always returns this
 * instance, so `None` values are referentially equal.
 */
const NONE: None = Object.freeze({ present: false });

/**
 * Creates an {@linkcode Option} holding a value.
 *
 * @typeParam T - The contained value type
 * @param value - The value to wrap
 * @returns A `Some` option
 * @since 0.1.0
 */
export function some<T>(value: T): Some<T> {
  return { present: true, value };
}

/**
 * Returns the {@linkcode None} option.
 *
 * @returns The `None` singleton
 * @since 0.1.0
 */
export function none(): None {
  return NONE;
}

/**
 * Type guard: narrows an {@linkcode Option} to {@linkcode Some}.
 *
 * @typeParam T - The contained value type
 * @param option - The option to inspect
 * @returns `true` if a value is present
 * @since 0.1.0
 */
export function isSome<T>(option: Option<T>): option is Some<T> {
  return option.present;
}

/**
 * Type guard: narrows an {@linkcode Option} to {@linkcode None}.
 *
 * @typeParam T - The contained value type
 * @param option - The option to inspect
 * @returns `true` if no value is present
 * @since 0.1.0
 */
export function isNone<T>(option: Option<T>): option is None {
  return !option.present;
}

/**
 * Converts a nullable value to an {@linkcode Option}.
 *
 * @typeParam T - The contained value type
 * @param value - The possibly `null`/`undefined` value
 * @returns `Some` when the value is neither `null` nor `undefined`, else `None`
 * @since 0.1.0
 */
export function fromNullable<T>(value: T | null | undefined): Option<T> {
  return value === null || value === undefined ? NONE : some(value);
}
