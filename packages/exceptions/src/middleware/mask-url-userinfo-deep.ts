/**
 * Masks URL userinfo in what the error handler serves and logs.
 *
 * Driver messages can carry connection URLs with credentials. The response
 * body is masked by {@linkcode stringifyMasked}, a `JSON.stringify` replacer:
 * it sees every value that is served, after each `toJSON` has run, so a `URL`,
 * a class instance, a `String` object, an object key or a custom formatter's
 * output in `details` is masked too. The log masks a `serializeError` result,
 * which is plain data, with {@linkcode maskUrlUserinfoDeep}, whose keys are
 * preserved. This module is internal and is not exported from src/index.ts.
 *
 * @module
 */
import { maskUrlUserinfo } from '@setu-ts/common';

/**
 * Serializes a response body with URL userinfo masked in every served string:
 * string values, `String` objects and object keys.
 *
 * @param body - The finished error body, which may be frozen or shared
 * @returns The JSON text that is served
 */
export function stringifyMasked(body: unknown): string {
  return JSON.stringify(body, maskServed);
}

/**
 * The replacer: the key it is called with was already written by its holder, so
 * an object whose own keys would change is replaced by a copy with masked keys,
 * whose values the replacer then visits in turn.
 */
function maskServed(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return maskUrlUserinfo(value);
  if (value instanceof String) return maskUrlUserinfo(value.valueOf());
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.every((key) => maskUrlUserinfo(key) === key)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]: [string, unknown]) => [maskUrlUserinfo(key), entry]),
  );
}

/**
 * Returns a fresh value with URL userinfo masked in string values at any depth.
 *
 * @param value - A serialized error, which may be frozen or shared
 * @returns A masked copy of the same shape, without mutating the input
 */
export function maskUrlUserinfoDeep<T>(value: T): T {
  return maskValue(value) as T;
}

/** Walk only JSON-like containers, leaving application instances untouched. */
function maskValue(value: unknown): unknown {
  if (typeof value === 'string') return maskUrlUserinfo(value);
  if (Array.isArray(value)) return value.map((item: unknown) => maskValue(item));
  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]: [string, unknown]) => [key, maskValue(entry)]),
      );
    }
  }
  return value;
}
