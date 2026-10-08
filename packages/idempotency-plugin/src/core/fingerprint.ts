/**
 * Fingerprinting: an HTTP request fingerprint over raw bytes, an ingress
 * fingerprint over canonical JSON, and the hand-written canonical-JSON walker
 * (plan §3.6, §3.7, §3.20).
 *
 * @module
 */
import type {
  IdempotencyFingerprintSource,
  IngressContext,
  IngressIdempotencyFingerprintSource,
  IRequestContext,
} from '@setu-ts/common';
import { MAX_CANONICAL_DEPTH } from '../constants.ts';
import { deriveHash, lengthPrefixed, sha256Hex } from './hash.ts';

/**
 * Thrown by {@linkcode canonicalJson} when a value cannot be serialised
 * deterministically. Mapped by the ingress behaviour to a
 * `fingerprint-unavailable` refusal (§3.7).
 *
 * @since 0.9.0
 */
export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';

  /**
   * @param message - A message naming the type and the path, never the value
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Serialises `value` to a deterministic JSON string.
 *
 * Object keys are sorted by code unit; `undefined` object entries are skipped
 * and `undefined` array elements become `null`; non-finite numbers become
 * `null`; `Date`s become their ISO string. Anything else at any depth — a
 * `Map`, `Set`, function, symbol, bigint, typed array or class instance — is
 * refused with {@linkcode CanonicalJsonError}, as is a cycle or a value deeper
 * than 64 levels.
 *
 * @param value - The value to serialise
 * @returns The canonical JSON string
 * @throws {CanonicalJsonError} If the value cannot be canonicalised
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '';
  return walk(value, '$', new Set<object>(), 0);
}

/** Recursive walker. `ancestors` detects cycles; `depth` bounds nesting. */
function walk(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalJsonError(`${path}: deeper than ${MAX_CANONICAL_DEPTH}`);
  }
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'number') {
    return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  }
  if (type !== 'object') {
    throw new CanonicalJsonError(`${path}: ${type} is not canonicalisable`);
  }

  const object = value as object;
  if (ancestors.has(object)) throw new CanonicalJsonError(`${path}: cycle`);
  ancestors.add(object);
  try {
    if (object instanceof Date) {
      if (Number.isNaN(object.getTime())) {
        throw new CanonicalJsonError(`${path}: invalid Date`);
      }
      return JSON.stringify(object.toISOString());
    }
    if (Array.isArray(object)) {
      const parts = object.map((element, index) =>
        element === undefined ? 'null' : walk(element, `${path}[${index}]`, ancestors, depth + 1)
      );
      return `[${parts.join(',')}]`;
    }
    if (isPlainObject(object)) {
      const record = object as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const entry = record[key];
        if (entry === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${walk(entry, `${path}.${key}`, ancestors, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    throw new CanonicalJsonError(`${path}: ${typeNameOf(object)} is not canonicalisable`);
  } finally {
    ancestors.delete(object);
  }
}

/** True for `{}`-literal objects and `Object.create(null)` objects. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** The found type's name, for the refusal message. */
function typeNameOf(value: object): string {
  const ctor = (value as { readonly constructor?: { readonly name?: string } }).constructor;
  const name = ctor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'object';
}

/**
 * Fingerprints an HTTP request.
 *
 * For `'request'`, hashes the length-prefixed `method`, `path`, raw query and
 * lower-cased `content-type`, then the raw body bytes. For a function source,
 * re-hashes its result.
 *
 * @param subtle - The runtime's `SubtleCrypto`
 * @param ctx - The request context
 * @param source - The resolved fingerprint source
 * @returns 64 lower-case hex characters
 */
export async function requestFingerprint(
  subtle: SubtleCrypto,
  ctx: IRequestContext,
  source: IdempotencyFingerprintSource,
): Promise<string> {
  if (typeof source === 'function') {
    return deriveHash(subtle, [await source(ctx)]);
  }
  const body = await ctx.request.bytes();
  const contentType = (ctx.request.headers.get('content-type') ?? '').toLowerCase();
  return sha256Hex(
    subtle,
    lengthPrefixed([ctx.request.method, ctx.request.path, queryOf(ctx.request.url), contentType]),
    body,
  );
}

/**
 * Fingerprints an ingress work item.
 *
 * For `'payload'`, serialises the queue `{ name, data }` (never `attempts`) or
 * the message payload with {@linkcode canonicalJson} and hashes it. For a
 * function source, re-hashes its result.
 *
 * @param subtle - The runtime's `SubtleCrypto`
 * @param ctx - The work envelope
 * @param source - The resolved fingerprint source
 * @returns 64 lower-case hex characters
 * @throws {CanonicalJsonError} When `'payload'` cannot be canonicalised
 */
export async function payloadFingerprint(
  subtle: SubtleCrypto,
  ctx: IngressContext,
  source: IngressIdempotencyFingerprintSource,
): Promise<string> {
  if (typeof source === 'function') {
    return deriveHash(subtle, [await source(ctx)]);
  }
  const value = ctx.kind === 'queue' ? queueFields(ctx.payload) : ctx.payload;
  return deriveHash(subtle, [canonicalJson(value)]);
}

/**
 * The raw query substring of `url`: from the first `?` (inclusive) to the end,
 * or `''` when there is none. Never parsed, never re-ordered.
 *
 * @param url - The request URL
 * @returns The raw query fragment, including the `?`
 */
export function queryOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? '' : url.slice(index);
}

/** `{ name, data }` of a queue job payload, or the payload unchanged. */
function queueFields(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    return { name: record.name, data: record.data };
  }
  return payload;
}
