/**
 * The outbox's error classes (M107 §4), for consumer `instanceof` handling.
 *
 * No message quotes a tenant id, an ordering key, a row's contents or a
 * stored header value (§10 obligation 3).
 *
 * @module
 */

/**
 * Rejected by `IOutbox.write` when the serialized envelope exceeds
 * `outbox.maxEnvelopeBytes` — inside the caller's transaction, so the business
 * write rolls back with it and no unsendable row is committed.
 *
 * @since 0.9.0
 */
export class OutboxEnvelopeTooLargeError extends Error {
  /** The serialized envelope's UTF-8 byte length. */
  readonly bytes: number;
  /** The configured limit. */
  readonly limit: number;

  /**
   * @param bytes - The serialized envelope's UTF-8 byte length
   * @param limit - The configured `maxEnvelopeBytes`
   */
  constructor(bytes: number, limit: number) {
    super(
      `outbox: the serialized envelope is ${bytes} UTF-8 bytes, over maxEnvelopeBytes (${limit})`,
    );
    this.name = 'OutboxEnvelopeTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * Rejects startup when the outbox relay is to be scheduled
 * (`outbox.relay.schedule`, the default) but no scheduler capability is
 * registered.
 *
 * @since 0.9.0
 */
export class OutboxRelayUnscheduledError extends Error {
  constructor() {
    super(
      'outbox: the relay is scheduled by default but no scheduler is registered — register ' +
        'SchedulerPlugin, or set relay: { schedule: false } and call outbox.sweep() from a ' +
        'Cron Trigger',
    );
    this.name = 'OutboxRelayUnscheduledError';
  }
}

/**
 * Rejected by `IOutbox.write` and `IOutbox.release` when the outbox is
 * configured with per-tenant `stores` and the call names no tenant, or a
 * tenant with no store. The tenant id is never quoted.
 *
 * @since 0.9.0
 */
export class OutboxUnknownTenantError extends Error {
  constructor() {
    super('outbox: no store is configured for the tenant this call named (or it named none)');
    this.name = 'OutboxUnknownTenantError';
  }
}

/**
 * Rejected by `IOutbox.release` when the row is missing or not `failed`.
 * Names the outcome, never the row's contents.
 *
 * @since 0.9.0
 */
export class OutboxRowStateError extends Error {
  /** Why nothing was written. */
  readonly outcome: 'missing' | 'not-failed';
  /**
   * The row's actual status, for `not-failed`; absent for `missing`.
   * Declared, not initialized, so `missing` carries no `status` key at all.
   */
  declare readonly status?: 'pending' | 'sent' | 'discarded';

  /**
   * @param outcome - `missing` or `not-failed`
   * @param status - The row's actual status, for `not-failed`
   */
  constructor(outcome: 'missing' | 'not-failed', status?: 'pending' | 'sent' | 'discarded') {
    super(
      outcome === 'missing'
        ? 'outbox: no outbox row has that id'
        : `outbox: the row is ${status ?? 'not failed'}, so it cannot be released`,
    );
    this.name = 'OutboxRowStateError';
    this.outcome = outcome;
    if (status !== undefined) {
      Object.defineProperty(this, 'status', { value: status, enumerable: true });
    }
  }
}

/**
 * Rejected by `IOutbox.write` (and `release`, `sweep`, `purge`) before the
 * plugin's `onInit` has resolved and verified the store.
 *
 * @since 0.9.0
 */
export class OutboxNotReadyError extends Error {
  constructor() {
    super('outbox: not ready — the store is resolved and verified during application start()');
    this.name = 'OutboxNotReadyError';
  }
}
