/**
 * The error classes the idempotency plugin throws (plan §3.17, §3.4).
 *
 * Messages never contain a key, a payload, a result, or an option VALUE.
 *
 * @module
 */
import type { HttpStatusHint, IngressKind } from '@setu-ts/common';
import { withHttpStatusHint } from '@setu-ts/common';

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

/**
 * Why a tier-C `within` call was refused or failed.
 *
 * @since 0.9.0
 */
export type IdempotencyWithinErrorReason =
  | 'key-invalid'
  | 'fingerprint-invalid'
  | 'fingerprint-mismatch'
  | 'conflict'
  | 'result-too-large'
  | 'result-unserializable'
  | 'record-invalid'
  | 'store-failed';

/**
 * The status hint for each reason, or `undefined` for a masked `500`.
 *
 * `detail` is caller-facing and carries no key, scope, namespace, fingerprint
 * input or stored value.
 */
const WITHIN_STATUS_HINT: Readonly<
  Record<IdempotencyWithinErrorReason, HttpStatusHint | undefined>
> = {
  'key-invalid': {
    status: 400,
    title: 'Bad Request',
    detail: 'The idempotency key is not usable.',
  },
  'fingerprint-invalid': {
    status: 400,
    title: 'Bad Request',
    detail: 'The idempotency fingerprint cannot be serialised.',
  },
  'fingerprint-mismatch': {
    status: 422,
    title: 'Unprocessable Entity',
    detail: 'The idempotency key was already used with a different fingerprint.',
  },
  conflict: {
    status: 409,
    title: 'Conflict',
    detail: 'Another call holds this idempotency key; retry.',
  },
  'store-failed': {
    status: 503,
    title: 'Service Unavailable',
    detail: 'The idempotency store failed.',
  },
  'result-too-large': undefined,
  'result-unserializable': undefined,
  'record-invalid': undefined,
};

/**
 * Thrown by the tier-C `within` path when it refuses the caller's options or
 * cannot complete the work.
 *
 * The message names the reason, never a key, a scope, a namespace, a
 * fingerprint input or a stored result, and carries no `cause` — a store
 * driver's message can quote every bound parameter, including the result
 * (M108 audit F1).
 *
 * @since 0.9.0
 */
export class IdempotencyWithinError extends Error {
  /** The error name, `'IdempotencyWithinError'`. */
  override readonly name = 'IdempotencyWithinError';

  /** Why the call was refused or failed. */
  readonly reason: IdempotencyWithinErrorReason;

  /**
   * Creates the error and brands it with the reason's status hint.
   *
   * @param reason - Why the call was refused or failed
   * @param message - A message carrying no key, fingerprint input or result
   */
  constructor(reason: IdempotencyWithinErrorReason, message: string) {
    super(message);
    this.reason = reason;
    const hint = WITHIN_STATUS_HINT[reason];
    if (hint !== undefined) withHttpStatusHint(this, hint);
  }
}

/**
 * Rejected by `start()` when the transactional store's `verify()` does not
 * answer within `storeTimeoutMs`.
 *
 * @since 0.9.0
 */
export class IdempotencyVerifyTimeoutError extends Error {
  /** The error name, `'IdempotencyVerifyTimeoutError'`. */
  override readonly name = 'IdempotencyVerifyTimeoutError';

  /** The bound that expired, in milliseconds. */
  readonly timeoutMs: number;

  /**
   * Creates the error naming the bound that expired.
   *
   * @param timeoutMs - The bound that expired
   */
  constructor(timeoutMs: number) {
    super(`idempotency: the transactional store did not verify within ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}
