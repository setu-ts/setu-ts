/**
 * The outbox's error classes (M107 §4), for consumer `instanceof` handling.
 *
 * No message quotes a tenant id, an ordering key, a row's contents or a
 * stored header value (§10 obligation 3).
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

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
   * Builds the refusal from the measured size and the configured limit.
   *
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

/** The statuses a not-failed row may legitimately report. */
const KNOWN_STATUSES = ['pending', 'sent', 'discarded'] as const;

/**
 * How a `release` refusal is answered, by outcome. The caller caused the
 * condition and it is permanent for that request, so the refusal answers with
 * its own status instead of a masked 500; the details are fixed and quote
 * nothing from a row.
 */
const HINT_BY_OUTCOME = {
  'invalid-id': { status: 400, title: 'Bad Request', detail: 'The outbox row id is malformed.' },
  missing: { status: 404, title: 'Not Found', detail: 'No outbox row has that id.' },
  'not-failed': {
    status: 409,
    title: 'Conflict',
    detail: 'The outbox row is not failed, so it cannot be released.',
  },
} as const;

/**
 * Rejected by `IOutbox.release` when the row id is missing, or the row is
 * missing or not `failed`. Names the outcome and, for `not-failed`, the
 * row's status only when it is one of the three known values — a row edited
 * to carry anything else is reported as not failed with no `status`, so no
 * stored text reaches the message.
 *
 * Branded with the HTTP status hint in the constructor: 400, 404 and 409 by
 * outcome, with a fixed value-free detail.
 *
 * @since 0.9.0
 */
export class OutboxRowStateError extends Error {
  /** Why nothing was written. */
  readonly outcome: 'invalid-id' | 'missing' | 'not-failed';
  /**
   * The row's actual status, for `not-failed` when it is a known status;
   * absent otherwise.
   * Declared, not initialized, so the other outcomes carry no `status` key.
   */
  declare readonly status?: 'pending' | 'sent' | 'discarded';

  /**
   * Builds the refusal from the store's transition outcome.
   *
   * @param outcome - `invalid-id`, `missing` or `not-failed`
   * @param stored - The row's status as read, for `not-failed`; kept only
   *   when it is a known status
   */
  constructor(
    outcome: 'invalid-id' | 'missing' | 'not-failed',
    stored?: 'pending' | 'sent' | 'discarded',
  ) {
    // The status comes from a stored row, so it is checked, not trusted.
    const status = (KNOWN_STATUSES as readonly unknown[]).includes(stored) ? stored : undefined;
    super(
      outcome === 'invalid-id'
        ? 'outbox: release needs the row id'
        : outcome === 'missing'
          ? 'outbox: no outbox row has that id'
          : `outbox: the row is ${status ?? 'not failed'}, so it cannot be released`,
    );
    this.name = 'OutboxRowStateError';
    this.outcome = outcome;
    if (status !== undefined) {
      Object.defineProperty(this, 'status', { value: status, enumerable: true });
    }
    withHttpStatusHint(this, HINT_BY_OUTCOME[outcome]);
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

/**
 * Rejects application `start()` when a store's startup `verify()` did not
 * settle within `relay.storeTimeoutMs` — a database that accepts the
 * connection and never answers. Without the bound, `start()` would wait for
 * as long as the driver does, which for some drivers is forever.
 *
 * The message names neither the tenant nor the store: a tenant id may carry
 * anything.
 *
 * @since 0.9.0
 */
export class OutboxStoreVerifyTimeoutError extends Error {
  /** The bound that expired, in milliseconds. */
  readonly timeoutMs: number;

  /**
   * Builds the refusal naming the bound that expired.
   *
   * @param timeoutMs - The `relay.storeTimeoutMs` bound that expired
   */
  constructor(timeoutMs: number) {
    super(
      `outbox: the store's startup verify() did not settle within ${timeoutMs} ms ` +
        '(relay.storeTimeoutMs)',
    );
    this.name = 'OutboxStoreVerifyTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
