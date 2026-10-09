/**
 * Tier-C `within` option shape validation and resolution (M109b §3.13).
 *
 * @module
 */
import type { IdempotentWithinOptions } from '@setu-ts/common';
import {
  MAX_TTL_MS,
  MAX_WITHIN_NAMESPACE_CHARS,
  MAX_WITHIN_SCOPE_CHARS,
  MIN_WITHIN_TTL_MS,
} from '../constants.ts';
import { parseKeyValue } from '../core/key.ts';
import { IdempotencyConfigurationError, IdempotencyWithinError } from '../errors.ts';

/** A validated, default-applied `within` option set. */
export interface ResolvedWithinOptions {
  /** The normalized client key. */
  readonly key: string;
  /** What the key is for. */
  readonly namespace: string;
  /** The required isolation segment. */
  readonly scope: string;
  /** The fingerprint input, or `undefined`. */
  readonly fingerprint: unknown;
  /** Milliseconds the record is retained from its commit. */
  readonly ttlMs: number;
}

/** True for a finite integer within `[min, max]`. */
function isIntInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** True for a string of `min`–`max` characters, each in `0x20`–`0x7E`. */
function isPrintable(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Validates a `within` option set's shape, except its `key` (which
 * {@linkcode resolveWithinOptions} normalizes).
 *
 * @param options - The option set
 * @throws {IdempotencyConfigurationError} When `namespace`, `scope` or `ttlMs` is invalid
 */
export function validateWithinOptionShape(options: IdempotentWithinOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw new IdempotencyConfigurationError(
      'within',
      'idempotency: within requires an options object',
    );
  }
  if (!isPrintable(options.namespace, 1, MAX_WITHIN_NAMESPACE_CHARS)) {
    throw new IdempotencyConfigurationError(
      'within.namespace',
      'idempotency: within namespace must be 1 to 256 printable characters',
    );
  }
  if (!isPrintable(options.scope, 0, MAX_WITHIN_SCOPE_CHARS)) {
    throw new IdempotencyConfigurationError(
      'within.scope',
      'idempotency: within scope must be 0 to 512 printable characters',
    );
  }
  if (options.ttlMs !== undefined && !isIntInRange(options.ttlMs, MIN_WITHIN_TTL_MS, MAX_TTL_MS)) {
    throw new IdempotencyConfigurationError(
      'within.ttlMs',
      'idempotency: within ttlMs is out of range',
    );
  }
}

/**
 * Validates and resolves a `within` option set against the plugin's default
 * tier-C TTL.
 *
 * @param options - The option set
 * @param defaults - The plugin-level tier-C defaults
 * @returns The normalized, default-applied options
 * @throws {IdempotencyWithinError} When `key` is not usable
 * @throws {IdempotencyConfigurationError} When another field is invalid
 */
export function resolveWithinOptions(
  options: IdempotentWithinOptions,
  defaults: { readonly ttlMs: number },
): ResolvedWithinOptions {
  validateWithinOptionShape(options);
  const key = typeof options.key === 'string' ? parseKeyValue(options.key) : undefined;
  if (key === undefined) {
    throw new IdempotencyWithinError('key-invalid', 'idempotency: within key is not usable');
  }
  return {
    key,
    namespace: options.namespace,
    scope: options.scope,
    fingerprint: options.fingerprint,
    ttlMs: options.ttlMs ?? defaults.ttlMs,
  };
}
