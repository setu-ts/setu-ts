/**
 * Internal publish-options validation — the ONE validator every public publish
 * entry runs before a transport is touched (M106 §3.4).
 *
 * Two properties are load-bearing:
 *
 * - **Every refusal is a `RangeError` delivered as a REJECTED promise.** A
 *   publish method that returns a `Promise` must never throw synchronously
 *   (the M52b class), so a caller using `.catch()` cannot miss it.
 * - **The caller's `options` is read exactly once into a frozen copy**, and only
 *   that copy is read afterwards, so a getter or `Proxy` cannot answer the
 *   validator one value and the transport another (the M98e copy-once class).
 *
 * Nothing here is exported from the package barrel: this validator is internal,
 * shared by the seven brokers and the two decorators. The RULES it enforces —
 * the id rule, the header name/value rules and the reserved-name tables — live
 * in `@setu-ts/common`, so the Cloudflare Workers envelope reader can enforce
 * the same ones without importing this package (§2.2).
 *
 * @module
 */

import {
  DEDUPLICATION_ID_HEADER,
  MAX_PUBLISH_HEADER_NAME_BYTES,
  MAX_PUBLISH_HEADER_VALUE_BYTES,
  MAX_PUBLISH_HEADERS,
  MAX_PUBLISH_ID_BYTES,
  ORDERING_KEY_HEADER,
  publishHeaderNameProblem,
  publishHeaderValueProblem,
  publishIdProblem,
} from '@setu-ts/common';

/** The validated, frozen form of caller-supplied publish options. @internal */
export interface ValidatedPublishOptions {
  readonly orderingKey?: string;
  readonly deduplicationId?: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A plain object: prototype is `Object.prototype` or `null`, and it is not an array. @internal */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Maps a shared id-rule problem to the refusal text for one field. */
const ID_PROBLEM_TEXT: Readonly<Record<string, string>> = {
  'not-a-string': 'must be a non-empty string',
  'empty': 'must be a non-empty string',
  'not-well-formed': 'must be a well-formed string',
  'whitespace': 'must not have leading or trailing whitespace',
  'forbidden-characters': 'must not contain control or format characters',
  'too-long': `must be at most ${MAX_PUBLISH_ID_BYTES} UTF-8 bytes`,
};

/**
 * Validates one id field (`orderingKey` / `deduplicationId`); returns it
 * unchanged. The RULE is `common`'s `publishIdProblem` — ONE implementation,
 * shared with the Cloudflare envelope reader, which cannot import this package.
 */
function validateId(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const problem = publishIdProblem(value);
  if (problem !== null) {
    throw new RangeError(`publish options ${field} ${ID_PROBLEM_TEXT[problem]}`);
  }
  return value as string;
}

/**
 * Validates one header name. The RULE is `common`'s `publishHeaderNameProblem`
 * (ONE implementation, shared with the Cloudflare envelope reader).
 *
 * A name refused for its CHARACTERS is identified by its POSITION — it is never
 * quoted, because it may carry anything at all. A RESERVED name has already
 * passed the character check, so it is safe to quote.
 */
function validateHeaderName(name: string, index: number): void {
  const problem = publishHeaderNameProblem(name);
  if (problem === null) return;
  if (problem === 'reserved') {
    throw new RangeError(`publish options header ${JSON.stringify(name)} is reserved`);
  }
  throw new RangeError(
    `publish options header at index ${index} has an invalid name: ` +
      `1-${MAX_PUBLISH_HEADER_NAME_BYTES} bytes, each in 0x21-0x7E excluding ":"`,
  );
}

/** Maps a shared header-value problem to the refusal text for one header. */
const HEADER_VALUE_PROBLEM_TEXT: Readonly<Record<string, string>> = {
  'not-a-string': 'must be a string',
  'not-well-formed': 'must be a well-formed string',
  'whitespace': 'must not have leading or trailing whitespace',
  'forbidden-characters': 'must not contain control or format characters',
  'too-long': `must be at most ${MAX_PUBLISH_HEADER_VALUE_BYTES} UTF-8 bytes`,
};

/**
 * Validates one header value against `common`'s `publishHeaderValueProblem`.
 * The NAME (already checked to be visible ASCII) may be quoted; the VALUE is
 * never quoted.
 */
function validateHeaderValue(name: string, value: unknown): string {
  const problem = publishHeaderValueProblem(value);
  if (problem !== null) {
    throw new RangeError(
      `publish options header ${JSON.stringify(name)} value ${HEADER_VALUE_PROBLEM_TEXT[problem]}`,
    );
  }
  return value as string;
}

/**
 * Reads and validates caller publish options into a frozen copy.
 *
 * Every refusal is a rejected promise (never a synchronous throw). Only the
 * returned copy is safe to read later: the caller's object is read once.
 *
 * @param options - The caller's options, or `undefined`
 * @returns The frozen validated copy
 * @throws {RangeError} As a rejected promise, naming the field and the rule
 * @internal
 */
// `async` here is load-bearing, not a forgotten await: it is what turns every
// `throw` below into a REJECTED promise, which §3.4 requires of a
// Promise-returning publish entry (the M52b class).
// deno-lint-ignore require-await
export async function validatePublishOptions(
  options: unknown,
): Promise<ValidatedPublishOptions> {
  if (options === undefined) {
    return Object.freeze({ headers: Object.freeze({}) });
  }
  if (!isPlainObject(options)) {
    throw new RangeError('publish options must be a plain object or undefined');
  }

  // Copy once: each member is read exactly ONE time.
  let rawOrderingKey: unknown;
  let rawDeduplicationId: unknown;
  let rawHeaders: unknown;
  try {
    rawOrderingKey = options.orderingKey;
    rawDeduplicationId = options.deduplicationId;
    rawHeaders = options.headers;
  } catch (error) {
    throw new RangeError('publish options could not be read', { cause: error });
  }

  const orderingKey = validateId('orderingKey', rawOrderingKey);
  const deduplicationId = validateId('deduplicationId', rawDeduplicationId);

  let headers: Readonly<Record<string, string>> = Object.freeze({});
  if (rawHeaders !== undefined) {
    if (!isPlainObject(rawHeaders)) {
      throw new RangeError('publish options headers must be a plain object');
    }
    if (Object.getOwnPropertySymbols(rawHeaders).length > 0) {
      throw new RangeError('publish options headers must not contain symbol keys');
    }

    let keys: string[];
    let values: unknown[];
    try {
      keys = Object.keys(rawHeaders); // own enumerable string keys, in one pass
      values = keys.map((key) => rawHeaders[key]); // each value read exactly once
    } catch (error) {
      throw new RangeError('publish options headers could not be read', { cause: error });
    }
    if (keys.length > MAX_PUBLISH_HEADERS) {
      throw new RangeError(
        `publish options headers must contain at most ${MAX_PUBLISH_HEADERS} entries`,
      );
    }

    const entries: [string, string][] = [];
    for (let index = 0; index < keys.length; index++) {
      const name = keys[index]!;
      validateHeaderName(name, index);
      entries.push([name, validateHeaderValue(name, values[index])]);
    }
    // `Object.fromEntries` defines own data properties, so a `__proto__` key
    // becomes an own key and never a prototype change.
    headers = Object.freeze(Object.fromEntries(entries));
  }

  return Object.freeze({
    ...(orderingKey !== undefined ? { orderingKey } : {}),
    ...(deduplicationId !== undefined ? { deduplicationId } : {}),
    headers,
  });
}

/**
 * Builds the transport header record from the validated copy, the ordering and
 * de-duplication headers, and the framework's own headers.
 *
 * Framework headers are written LAST, so a caller can never overwrite one (the
 * reserved-name rule already refuses the attempt).
 *
 * @param validated - The frozen copy returned by {@linkcode validatePublishOptions}
 * @param frameworkHeaders - Framework-owned headers (for example `traceparent`)
 * @returns A fresh header record to hand the transport
 * @internal
 */
export function buildTransportHeaders(
  validated: ValidatedPublishOptions,
  frameworkHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = { ...validated.headers };
  if (validated.orderingKey !== undefined) {
    headers[ORDERING_KEY_HEADER] = validated.orderingKey;
  }
  if (validated.deduplicationId !== undefined) {
    headers[DEDUPLICATION_ID_HEADER] = validated.deduplicationId;
  }
  for (const [key, value] of Object.entries(frameworkHeaders)) {
    headers[key] = value;
  }
  return headers;
}
