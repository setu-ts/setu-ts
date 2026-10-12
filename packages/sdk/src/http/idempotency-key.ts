/**
 * The SDK's idempotency key: validation of a caller's key and generation of a
 * client-level one (M109b §3.8, §3.13).
 *
 * A keyed request keeps ONE key across every retry attempt — the header is set
 * before the retry loop and the same `Headers` object is reused by every
 * attempt — which is what makes a `POST` or `PATCH` safe to repeat.
 *
 * @module
 */
import { drawHexBytes } from './random-hex.ts';

/**
 * The default header name a key is sent under.
 *
 * @since 0.9.0
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * The methods a generated key is set on by default.
 *
 * @since 0.9.0
 */
export const DEFAULT_IDEMPOTENCY_METHODS: readonly string[] = ['POST', 'PATCH'];

/** Bytes behind one generated key. */
const GENERATED_KEY_BYTES = 16;

/** Largest accepted key length. */
const MAX_KEY_CHARS = 255;

/** The RFC 9110 `token` grammar, which a header name must match. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The message a missing `crypto.getRandomValues` raises. */
const CRYPTO_UNAVAILABLE =
  'idempotency: crypto.getRandomValues is unavailable, so a key cannot be generated';

/**
 * Client-level idempotency configuration (M109b §3.8).
 *
 * @since 0.9.0
 */
export interface ClientIdempotencyOptions {
  /**
   * Methods a generated key is set on. 1–16 HTTP tokens, upper-cased. Default
   * `['POST', 'PATCH']`.
   */
  readonly methods?: readonly string[];
  /** The header a key is sent under. An HTTP token. Default `'Idempotency-Key'`. */
  readonly header?: string;
  /**
   * Mints a key. Default: 32 hex characters from 16 `crypto.getRandomValues`
   * bytes. Its OUTPUT is validated on every call like a caller's key.
   */
  readonly generateKey?: () => string;
}

/** The resolved client-level idempotency configuration. */
export interface ResolvedClientIdempotencyOptions {
  /** The upper-cased method set. */
  readonly methods: ReadonlySet<string>;
  /** The header the key is sent under. */
  readonly header: string;
  /** The key minter. */
  readonly generateKey: () => string;
}

/**
 * Validates a key from either source, naming the field and never the value.
 *
 * @param value - The value to validate
 * @param field - The field name named in a refusal, never the value
 * @returns The key, unchanged
 * @throws {RangeError} When it is not 1–255 characters of `0x21`–`0x7E` without `"`
 */
export function validateIdempotencyKey(value: unknown, field: string): string {
  const usable = typeof value === 'string' && value.length >= 1 && value.length <= MAX_KEY_CHARS &&
    !value.includes('"') && hasOnlyPrintableChars(value);
  if (!usable) {
    throw new RangeError(`${field} must be 1 to 255 printable characters`);
  }
  return value as string;
}

/** True when every character is in `0x21`–`0x7E`. */
function hasOnlyPrintableChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Mints a key: 32 lower-case hex characters from 16 random bytes.
 *
 * @returns The generated key
 * @throws {TypeError} When `crypto.getRandomValues` is unavailable
 */
export function generateIdempotencyKey(): string {
  return drawHexBytes(GENERATED_KEY_BYTES, CRYPTO_UNAVAILABLE);
}

/** Refuses construction when the default key minter's `crypto` is unavailable. */
function assertKeyGenerationAvailable(): void {
  const crypto = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new TypeError(CRYPTO_UNAVAILABLE);
  }
}

/**
 * Validates and resolves `ClientOptions.idempotency` at construction.
 *
 * @param options - The configured idempotency options
 * @returns The resolved options
 * @throws {RangeError} When `methods` or `header` is not an HTTP token, or `methods` is empty or over 16
 * @throws {TypeError} When `generateKey` is not a function, or the default minter has no `crypto`
 */
export function resolveClientIdempotencyOptions(
  options: ClientIdempotencyOptions,
): ResolvedClientIdempotencyOptions {
  const methods = options.methods ?? DEFAULT_IDEMPOTENCY_METHODS;
  if (!Array.isArray(methods) || methods.length < 1 || methods.length > 16) {
    throw new RangeError('idempotency.methods must be 1 to 16 HTTP tokens');
  }
  const upper = new Set<string>();
  for (const method of methods) {
    if (typeof method !== 'string' || !HTTP_TOKEN.test(method)) {
      throw new RangeError('idempotency.methods entries must be HTTP tokens');
    }
    upper.add(method.toUpperCase());
  }
  const header = options.header ?? IDEMPOTENCY_KEY_HEADER;
  if (typeof header !== 'string' || !HTTP_TOKEN.test(header)) {
    throw new RangeError('idempotency.header must be an HTTP token');
  }
  const generateKey = options.generateKey ?? generateIdempotencyKey;
  if (typeof generateKey !== 'function') {
    throw new TypeError('idempotency.generateKey must be a function');
  }
  if (options.generateKey === undefined) assertKeyGenerationAvailable();
  return { methods: upper, header, generateKey };
}
