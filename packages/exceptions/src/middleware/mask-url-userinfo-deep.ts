/**
 * Masks URL userinfo in every string of a plain-data value: the finished error
 * response body, and the serialized error `errorHandler` logs.
 *
 * Driver messages can carry connection URLs with credentials. For the response,
 * masking runs immediately before JSON.stringify, the only transformation after
 * it, so this is the last point that sees every served string: message,
 * details, Problem Details detail, stack, and custom-formatter output. For the
 * log, it masks a `serializeError` result's message, stack and causes before
 * either sink sees them. Only arrays and plain
 * objects are copied and walked; other values retain their identity. Keys are
 * preserved. This module is internal and is not exported from src/index.ts.
 *
 * @module
 */
import { maskUrlUserinfo } from '@setu-ts/common';

/**
 * Returns a fresh value with URL userinfo masked in string values at any depth.
 *
 * @param value - A formatter body or serialized error, which may be frozen or shared
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
