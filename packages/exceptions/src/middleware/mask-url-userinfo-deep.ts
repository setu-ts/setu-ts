/**
 * Masks URL userinfo in what the error handler serves and logs.
 *
 * Driver messages can carry connection URLs with credentials. The response
 * body is masked by {@linkcode stringifyMasked}, a `JSON.stringify` replacer:
 * it sees every string that is served, after each `toJSON` has run, so a `URL`,
 * a class instance or a custom formatter's output in `details` is masked too.
 * The log masks a `serializeError` result, which is plain data, with
 * {@linkcode maskUrlUserinfoDeep}. Keys are preserved. This module is internal
 * and is not exported from src/index.ts.
 *
 * @module
 */
import { maskUrlUserinfo } from '@setu-ts/common';

/**
 * Serializes a response body with URL userinfo masked in every string value.
 *
 * @param body - The finished error body, which may be frozen or shared
 * @returns The JSON text that is served
 */
export function stringifyMasked(body: unknown): string {
  return JSON.stringify(body, (_key: string, value: unknown) =>
    typeof value === 'string' ? maskUrlUserinfo(value) : value,
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
