/**
 * The two error classes the idempotency plugin throws (plan §3.17).
 *
 * Messages never contain a key, a payload, or an option VALUE.
 *
 * @module
 */
import type { IngressKind } from '@setu-ts/common';

/**
 * Why an ingress work item was refused.
 *
 * @since 0.9.0
 */
export type IdempotencyRefusalReason =
  | 'in-progress'
  | 'fingerprint-mismatch'
  | 'key-missing'
  | 'key-invalid'
  | 'fingerprint-unavailable'
  | 'consumer-missing'
  | 'unsupported-key-source'
  | 'capacity-exceeded';

/**
 * Thrown by the ingress behaviour when it refuses a work item.
 *
 * @since 0.9.0
 */
export class IdempotencyRefusedError extends Error {
  /** The error name, `'IdempotencyRefusedError'`. */
  override readonly name = 'IdempotencyRefusedError';

  /** Why the work item was refused. */
  readonly reason: IdempotencyRefusalReason;

  /** The ingress path that produced the refusal. */
  readonly ingress: IngressKind;

  /** The topic or job name. */
  readonly target: string;

  /**
   * Creates a refusal for one work item.
   *
   * @param reason - Why the work item was refused
   * @param ingress - The ingress path
   * @param target - The topic or job name
   * @param message - A message that carries no key, payload or option value
   * @param options - An optional `cause`
   */
  constructor(
    reason: IdempotencyRefusalReason,
    ingress: IngressKind,
    target: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.reason = reason;
    this.ingress = ingress;
    this.target = target;
  }
}

/**
 * Thrown by option shape validation, resolution, and the plugin factory when a
 * configuration value is refused. `option` names the failing option path.
 *
 * @since 0.9.0
 */
export class IdempotencyConfigurationError extends Error {
  /** The error name, `'IdempotencyConfigurationError'`. */
  override readonly name = 'IdempotencyConfigurationError';

  /** The option path that failed, e.g. `'ttlMs'`, `'key.header'`, `'store.namespace'`. */
  readonly option: string;

  /**
   * Creates a configuration refusal naming the failing option.
   *
   * @param option - The option path that failed
   * @param message - A message that names the field, never its value
   */
  constructor(option: string, message: string) {
    super(message);
    this.option = option;
  }
}
