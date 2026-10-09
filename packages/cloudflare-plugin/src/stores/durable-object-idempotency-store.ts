/**
 * The Worker side of the idempotency store: one Durable Object per key
 * (M109a §3.15).
 *
 * @module
 * @since 0.9.0
 */

import type {
  IdempotencyClaimRequest,
  IdempotencyClaimResult,
  IdempotencySettleResult,
  IIdempotencyStore,
  IRuntimeServices,
} from '@setu-ts/common';
import { resolveProbeTiming, withDeadline } from '@setu-ts/common';

import type { IDurableObjectNamespace } from '../bindings/facades.ts';
import { isDurableObjectNamespace } from '../bindings/facades.ts';
import { CloudflareBindingMissingError, CloudflareUnsupportedError } from '../errors.ts';

/** The synthetic origin the stub is fetched with. Only the path is meaningful. */
const OBJECT_ORIGIN = 'https://idempotency.internal';

/** The largest `maxRecordBytes` this store advertises. */
const MAX_RECORD_BYTES = 120_000;

/** The namespace grammar, matching the Redis store's. */
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Options for {@linkcode DurableObjectIdempotencyStore}.
 *
 * @since 0.9.0
 */
export interface DurableObjectIdempotencyStoreOptions {
  /** Required. Isolates this application's records from another sharing the binding. */
  readonly namespace: string;
  /** Default `'idempotency:'`. */
  readonly keyPrefix?: string;
  /** Name used in error messages. Default `'the durable object'`. */
  readonly binding?: string;
  /** Per-call bound in ms. Default 5,000; `0` disables. */
  readonly timeoutMs?: number;
}

/** Validates the options, naming the failing field. */
function validateOptions(options: DurableObjectIdempotencyStoreOptions): void {
  if (typeof options.namespace !== 'string' || !NAMESPACE_PATTERN.test(options.namespace)) {
    throw new TypeError('namespace must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  }
  if (options.keyPrefix !== undefined) {
    if (
      typeof options.keyPrefix !== 'string' || options.keyPrefix.length < 1 ||
      options.keyPrefix.length > 64
    ) {
      throw new RangeError('keyPrefix must be 1 to 64 characters');
    }
  }
  if (options.binding !== undefined && typeof options.binding !== 'string') {
    throw new TypeError('binding must be a string');
  }
  if (options.timeoutMs !== undefined) {
    if (
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 0 ||
      options.timeoutMs > 2_147_483_647
    ) {
      throw new RangeError('timeoutMs must be an integer between 0 and 2147483647');
    }
  }
}

/**
 * A Durable Object-backed idempotency store.
 *
 * @since 0.9.0
 */
export class DurableObjectIdempotencyStore implements IIdempotencyStore {
  /** The store's name, `'durable-object'`. */
  readonly name = 'durable-object';

  /** The largest encoded record the store accepts, in bytes. */
  readonly maxRecordBytes: number = MAX_RECORD_BYTES;

  readonly #namespace: IDurableObjectNamespace;
  readonly #namespaceName: string;
  readonly #keyPrefix: string;
  readonly #binding: string;
  readonly #timeoutMs: number;
  #runtime: IRuntimeServices | undefined;

  /**
   * Creates a store over a Durable Object namespace binding.
   *
   * @param namespaceBinding - The Durable Object namespace binding
   * @param options - The store options
   * @throws {CloudflareBindingMissingError} When the binding is not a namespace
   * @throws {TypeError | RangeError} When an option is invalid
   */
  constructor(namespaceBinding: unknown, options: DurableObjectIdempotencyStoreOptions) {
    if (!isDurableObjectNamespace(namespaceBinding)) {
      throw new CloudflareBindingMissingError(
        `Durable Object binding '${
          options.binding ?? 'the durable object'
        }' is not a Durable Object ` +
          'namespace binding. Add a durable_objects binding to wrangler.toml and redeploy.',
      );
    }
    validateOptions(options);
    this.#namespace = namespaceBinding;
    this.#namespaceName = options.namespace;
    this.#keyPrefix = options.keyPrefix ?? 'idempotency:';
    this.#binding = options.binding ?? 'the durable object';
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  /** Captures the runtime; the binding needs no connection. */
  connect(runtime: IRuntimeServices): Promise<void> {
    this.#runtime = runtime;
    return Promise.resolve();
  }

  /** Claims a key through its Durable Object. */
  async claim(request: IdempotencyClaimRequest): Promise<IdempotencyClaimResult> {
    const answer = await this.#call<{ outcome: string; takeover?: boolean; record?: string }>(
      request.key,
      '/claim',
      {
        token: request.token,
        fingerprint: request.fingerprint,
        leaseMs: request.leaseMs,
        ttlMs: request.ttlMs,
      },
    );
    switch (answer.outcome) {
      case 'claimed':
        return { outcome: 'claimed', takeover: answer.takeover === true };
      case 'completed':
        return { outcome: 'completed', record: answer.record ?? '' };
      case 'in-progress':
        return { outcome: 'in-progress' };
      case 'fingerprint-mismatch':
        return { outcome: 'fingerprint-mismatch' };
      default:
        throw new Error('durable object idempotency store: unexpected answer from /claim');
    }
  }

  /** Completes a claim held by `token`, storing the response record. */
  async complete(
    key: string,
    token: string,
    record: string,
    ttlMs: number,
  ): Promise<IdempotencySettleResult> {
    return await this.#settle(key, '/complete', { token, record, ttlMs });
  }

  /** Releases a claim held by `token` so the key can be claimed again. */
  async release(key: string, token: string): Promise<IdempotencySettleResult> {
    return await this.#settle(key, '/release', { token });
  }

  /** Sends a settle operation and validates the answer's shape. */
  async #settle(key: string, path: string, payload: unknown): Promise<IdempotencySettleResult> {
    const answer = await this.#call<{ result?: unknown }>(key, path, payload);
    if (answer.result === 'settled' || answer.result === 'lost') return answer.result;
    throw new Error(`durable object idempotency store: unexpected answer from ${path}`);
  }

  /**
   * Sends one operation to the object that owns `key`, bounded by `timeoutMs`.
   */
  async #call<T>(key: string, path: string, payload: unknown): Promise<T> {
    if (this.#runtime === undefined) {
      return await Promise.reject(new Error('durable object idempotency store: not connected'));
    }
    const stub = this.#namespace.get(
      this.#namespace.idFromName(`${this.#keyPrefix}${this.#namespaceName}:${key}`),
    );
    const response = await withDeadline(
      (signal) =>
        stub.fetch(`${OBJECT_ORIGIN}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        }),
      {
        timeoutMs: this.#timeoutMs,
        onTimeout: () =>
          new Error(`durable object idempotency store: no answer within ${this.#timeoutMs} ms`),
        timing: resolveProbeTiming(this.#runtime),
      },
    );
    if (!response.ok) {
      throw new CloudflareUnsupportedError(
        `Durable Object binding '${this.#binding}' answered ${response.status} for the idempotency ` +
          `operation '${path}'. Check that the binding's class_name is the exported IdempotencyObject.`,
      );
    }
    return (await response.json()) as T;
  }
}
