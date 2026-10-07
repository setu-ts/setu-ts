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
 * Nothing here is exported from the package barrel: the reserved-name tables
 * and this validator are internal, shared by the seven brokers and the two
 * decorators.
 *
 * @module
 */

import {
  DEDUPLICATION_ID_HEADER,
  hasForbiddenAliasCharacter,
  MAX_PUBLISH_ID_BYTES,
  ORDERING_KEY_HEADER,
  publishIdProblem,
} from '@setu-ts/common';

/** The validated, frozen form of caller-supplied publish options. @internal */
export interface ValidatedPublishOptions {
  readonly orderingKey?: string;
  readonly deduplicationId?: string;
  readonly headers: Readonly<Record<string, string>>;
}

const ENCODER = new TextEncoder();

const MAX_HEADERS = 32;
const MAX_HEADER_NAME_BYTES = 256;
const MAX_HEADER_VALUE_BYTES = 1024;

/**
 * Header names a broker or its server ACTS on, compared ASCII-case-insensitively.
 * One internal table the conformance test iterates, never prose. `x-acquired-count`
 * is measured (2026-10-07): a RabbitMQ 4 quorum-queue redelivery writes it, not
 * `x-delivery-count`.
 *
 * @internal
 */
export const RESERVED_HEADER_NAMES: readonly string[] = Object.freeze([
  'traceparent',
  'tracestate',
  'cc',
  'bcc',
  'payload',
  'x-death',
  'x-delivery-count',
  'x-acquired-count',
  'x-delay',
]);

/** Reserved name PREFIXES, compared ASCII-case-insensitively. @internal */
export const RESERVED_HEADER_PREFIXES: readonly string[] = Object.freeze([
  'x-first-death-',
  'x-last-death-',
  'x-setu-',
  'nats-',
  'goog',
]);

/** A plain object: prototype is `Object.prototype` or `null`, and it is not an array. @internal */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** UTF-8 byte length. Called only after `isWellFormed()`, so no U+FFFD substitution. */
function utf8ByteLength(value: string): number {
  return ENCODER.encode(value).length;
}

/** 0x21-0x7E excluding `:` — exactly what nats.js accepts, the strictest transport. */
function isVisibleAsciiName(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x3a) return false;
  }
  return true;
}

/** ASCII-case-insensitive reserved-name test. */
function isReservedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (RESERVED_HEADER_NAMES.includes(lower)) return true;
  return RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
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
 * Validates a header name. A name refused for its characters is identified by
 * its POSITION — it is never quoted, because it may carry anything at all.
 */
function validateHeaderName(name: string, index: number): void {
  const bytes = utf8ByteLength(name);
  if (bytes < 1 || bytes > MAX_HEADER_NAME_BYTES || !isVisibleAsciiName(name)) {
    throw new RangeError(
      `publish options header at index ${index} has an invalid name: ` +
        `1-${MAX_HEADER_NAME_BYTES} bytes, each in 0x21-0x7E excluding ":"`,
    );
  }
}

/**
 * Validates a header value. The NAME (already checked to be visible ASCII) may
 * be quoted; the VALUE is never quoted.
 */
function validateHeaderValue(name: string, value: unknown): string {
  const label = `publish options header ${JSON.stringify(name)} value`;
  if (typeof value !== 'string') {
    throw new RangeError(`${label} must be a string`);
  }
  if (!value.isWellFormed()) {
    throw new RangeError(`${label} must be a well-formed string`);
  }
  if (value !== value.trim()) {
    throw new RangeError(`${label} must not have leading or trailing whitespace`);
  }
  if (hasForbiddenAliasCharacter(value)) {
    throw new RangeError(`${label} must not contain control or format characters`);
  }
  if (utf8ByteLength(value) > MAX_HEADER_VALUE_BYTES) {
    throw new RangeError(`${label} must be at most ${MAX_HEADER_VALUE_BYTES} UTF-8 bytes`);
  }
  return value;
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
    if (keys.length > MAX_HEADERS) {
      throw new RangeError(`publish options headers must contain at most ${MAX_HEADERS} entries`);
    }

    const entries: [string, string][] = [];
    for (let index = 0; index < keys.length; index++) {
      const name = keys[index]!;
      validateHeaderName(name, index);
      if (isReservedName(name)) {
        // Safe to quote: the name passed the character check above.
        throw new RangeError(`publish options header ${JSON.stringify(name)} is reserved`);
      }
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
