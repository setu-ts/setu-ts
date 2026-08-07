/**
 * The replica side of the Durable Object distributed lock.
 *
 * @module
 * @since 0.2.0
 */

import type { IRuntimeServices } from '@setu-ts/common';

import type { IDurableObjectNamespace } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';

/** The synthetic origin the stub is fetched with. Only the path is meaningful. */
const LOCK_ORIGIN = 'https://distributed-lock.internal';

/**
 * Options for {@linkcode DurableObjectLock}.
 *
 * @since 0.2.0
 */
export interface DurableObjectLockOptions {
  /**
   * Runtime services, for minting the lock token.
   *
   * Required rather than defaulted: a token must come from `runtime.uuid()`
   * per AI_GUIDELINES §4.2, and unlike the Durable Object side, this side does
   * have a plugin context to take one from.
   */
  readonly runtime: IRuntimeServices;
  /**
   * Prefix applied to every lock key before deriving the object name.
   *
   * Namespaces this application's locks so a shared Durable Object namespace
   * does not collide with another application's key of the same name.
   *
   * @default ''
   */
  readonly keyPrefix?: string;
  /**
   * The Durable Object binding name, used only in error messages.
   *
   * @default 'the durable object'
   */
  readonly binding?: string;
}

/**
 * A distributed lock backed by one Durable Object per key.
 *
 * Structurally satisfies `scheduler-plugin`'s `IDistributedLock` without
 * importing it — that interface is internal to its own package, and
 * AI_GUIDELINES §2.2/§3.3 forbid a plugin importing another plugin. The
 * application hands an instance to `SchedulerPlugin`, the same wiring
 * `KvSessionStore` uses for `SessionPlugin`, because that option is read at
 * plugin construction before any application exists.
 *
 * Correctness comes from the platform rather than from an algorithm: a Durable
 * Object executes one request at a time, so the read-compare-write inside
 * {@linkcode DistributedLockObjectCore} is atomic with no transaction and no
 * Redlock-style quorum.
 *
 * @example
 * ```typescript
 * import { env } from 'cloudflare:workers';
 * import { DurableObjectLock } from '@setu-ts/cloudflare-plugin';
 * import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
 *
 * const lock = new DurableObjectLock(env.LOCKS as IDurableObjectNamespace, {
 *   runtime,
 *   keyPrefix: 'reports:',
 * });
 *
 * // `enabled: true` is NOT needed: resolveLock consults `lock` before it
 * // consults `enabled`, so an injected lock always wins.
 * app.register(SchedulerPlugin({ distributedLock: { lock } }));
 * ```
 * @since 0.2.0
 */
export class DurableObjectLock {
  readonly #namespace: IDurableObjectNamespace;
  readonly #runtime: IRuntimeServices;
  readonly #keyPrefix: string;
  readonly #binding: string;

  /**
   * @param namespace - The Durable Object namespace binding
   * @param options - The runtime services, and optional key namespacing
   */
  constructor(namespace: IDurableObjectNamespace, options: DurableObjectLockOptions) {
    this.#namespace = namespace;
    this.#runtime = options.runtime;
    this.#keyPrefix = options.keyPrefix ?? '';
    this.#binding = options.binding ?? 'the durable object';
  }

  /**
   * Attempts to acquire the lock.
   *
   * @param key - The lock key
   * @param ttlMs - How long the claim lasts, in milliseconds
   * @returns The token when acquired, or `null` when another holder is live
   * @throws {CloudflareUnsupportedError} When the Durable Object answers with a
   * non-2xx status — a misconfigured binding or a class that is not the lock
   * object, neither of which may be reported as "someone else holds it"
   */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = this.#runtime.uuid();
    const body = await this.#call<{ token: string | null }>(key, '/acquire', { token, ttlMs });
    return body.token;
  }

  /**
   * Releases a previously acquired lock.
   *
   * A token that does not match the current holder is ignored by the object,
   * so a caller whose claim already expired cannot release its successor's.
   *
   * @param key - The lock key
   * @param token - The token `acquire` returned
   * @throws {CloudflareUnsupportedError} When the Durable Object answers with a
   * non-2xx status
   */
  async release(key: string, token: string): Promise<void> {
    await this.#call<{ released: boolean }>(key, '/release', { token });
  }

  /**
   * Sends one operation to the object that owns `key`.
   *
   * @param key - The lock key, which selects the object
   * @param path - The operation path
   * @param payload - The JSON body
   * @returns The parsed response body
   * @throws {CloudflareUnsupportedError} On a non-2xx response
   */
  async #call<T>(key: string, path: string, payload: unknown): Promise<T> {
    const stub = this.#namespace.get(this.#namespace.idFromName(this.#keyPrefix + key));
    const response = await stub.fetch(`${LOCK_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Deliberately not folded into "not acquired": a 404 means the binding
      // points at a class that is not the lock object, and reporting that as a
      // contended lock would silently disable every scheduled job instead of
      // failing loudly.
      throw new CloudflareUnsupportedError(
        `Durable Object binding '${this.#binding}' answered ${response.status} for the lock ` +
          `operation '${path}'. Check that the binding's class_name is the exported ` +
          `DistributedLockObject.`,
      );
    }
    return (await response.json()) as T;
  }
}
