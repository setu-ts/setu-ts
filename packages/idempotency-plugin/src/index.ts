/**
 * @module
 * @setu-ts/idempotency-plugin — a repeated HTTP request, queue job or broker
 * message does its work once per key.
 *
 * One core state machine — `claim(key, fingerprint, lease)` → `claimed` with a
 * token, then `complete(token, record)` or `release(token)` — behind one store
 * port in `@setu-ts/common`, with an in-process store and two cross-replica
 * stores (Redis and a Cloudflare Durable Object). Two entry points reach it: a
 * route-level `idempotent(options)` middleware plus an `@Idempotent()`
 * decorator for HTTP, and an ingress behaviour `idempotentIngress(options)` for
 * queue jobs and broker messages.
 *
 * The guarantee is **no duplicate processing within the limits of the store** —
 * it is not a single-execution guarantee.
 *
 * @since 0.9.0
 */

export { IdempotencyPlugin } from './plugin/idempotency-plugin.ts';
export type {
  IdempotencyPluginOptions,
  IdempotencyStoreConfig,
  IRedisIdempotencyClient,
  TransactionalIdempotencyOptions,
  TransactionalIdempotencyPurgeOptions,
} from './interfaces/index.ts';
export { derivedIdempotencyKey, idempotent } from './middleware/idempotent.ts';
export { idempotentIngress } from './ingress/idempotent-ingress.ts';
export {
  IdempotencyConfigurationError,
  IdempotencyRefusedError,
  IdempotencyVerifyTimeoutError,
  IdempotencyWithinError,
} from './errors.ts';
export type { IdempotencyRefusalReason, IdempotencyWithinErrorReason } from './errors.ts';
export { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER } from './constants.ts';
