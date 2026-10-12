/**
 * The inbox's error classes (M108 §4), for consumer `instanceof` handling.
 *
 * No message quotes an envelope id, an envelope, a row's contents or an error
 * line read from the store.
 *
 * @module
 */

/**
 * Thrown when an `onIntegrationEvent(..., { inbox })` subscription is
 * resolved and no inbox it can drive is registered: the token is absent
 * (no `MessagingPlugin({ inbox })`), or its provider is not this package's
 * inbox (an `override` replacement).
 *
 * @since 0.9.0
 */
export class InboxNotConfiguredError extends Error {
  /** The capability token the subscription resolved. */
  readonly token: string;
  /** Why: no provider, or a provider this package cannot drive. */
  readonly reason: 'unregistered' | 'foreign-provider';

  /**
   * Builds the refusal.
   *
   * @param token - The capability token the subscription resolved
   * @param reason - Why the inbox cannot be used
   */
  constructor(token: string, reason: 'unregistered' | 'foreign-provider') {
    super(
      reason === 'unregistered'
        ? `inbox: no '${token}' capability is registered — configure ` +
          'MessagingPlugin({ inbox: { store } }) for this messaging instance'
        : `inbox: the '${token}' provider is not the messaging plugin's inbox, so an ` +
          'inbox subscription cannot run against it',
    );
    this.name = 'InboxNotConfiguredError';
    this.token = token;
    this.reason = reason;
  }
}

/**
 * Thrown when a second inbox subscription registers the same consumer name
 * on the same topic in one inbox. The two handlers would share one key per
 * event and each would silently skip the other's work.
 *
 * @since 0.9.0
 */
export class InboxConsumerConflictError extends Error {
  /** The consumer name already registered on the topic. */
  readonly consumer: string;
  /** The topic. */
  readonly topic: string;

  /**
   * Builds the refusal naming the pair.
   *
   * @param consumer - The consumer name
   * @param topic - The topic
   */
  constructor(consumer: string, topic: string) {
    super(
      `inbox: consumer '${consumer}' is already subscribed to '${topic}' — two handlers ` +
        "sharing a consumer name would each skip the other's events",
    );
    this.name = 'InboxConsumerConflictError';
    this.consumer = consumer;
    this.topic = topic;
  }
}

/**
 * Rejected by an inbox delivery, listing, release or purge before the
 * plugin's `onInit` has resolved and verified the store, or after the inbox
 * closed; thrown when an inbox subscription is resolved before then.
 *
 * @since 0.9.0
 */
export class InboxNotReadyError extends Error {
  /** Whether the inbox has not started yet, or has closed. */
  readonly state: 'not-started' | 'closed';

  /**
   * Builds the refusal.
   *
   * @param state - `not-started` or `closed`
   */
  constructor(state: 'not-started' | 'closed') {
    super(
      state === 'not-started'
        ? 'inbox: not ready — the store is resolved and verified during application start(); ' +
          'resolve an inbox subscription at or after onInit'
        : 'inbox: closed — the application is stopping',
    );
    this.name = 'InboxNotReadyError';
    this.state = state;
  }
}

/**
 * Rejects application `start()` when the inbox purge is to be scheduled
 * (`inbox.purge.schedule`, the default) but no scheduler capability is
 * registered.
 *
 * @since 0.9.0
 */
export class InboxPurgeUnscheduledError extends Error {
  constructor() {
    super(
      'inbox: the retention purge needs CAPABILITIES.SCHEDULER — register SchedulerPlugin, ' +
        'or set inbox.purge.schedule: false and call inbox.purge() yourself',
    );
    this.name = 'InboxPurgeUnscheduledError';
  }
}

/**
 * Rejects application `start()` when the store's startup `verify()` did not
 * settle within `inbox.storeTimeoutMs`.
 *
 * @since 0.9.0
 */
export class InboxStoreVerifyTimeoutError extends Error {
  /** The bound that expired, in milliseconds. */
  readonly timeoutMs: number;

  /**
   * Builds the refusal naming the bound that expired.
   *
   * @param timeoutMs - The `inbox.storeTimeoutMs` bound that expired
   */
  constructor(timeoutMs: number) {
    super(
      `inbox: the store's startup verify() did not settle within ${timeoutMs} ms ` +
        '(inbox.storeTimeoutMs)',
    );
    this.name = 'InboxStoreVerifyTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The statuses a not-parked marker may legitimately report. */
const KNOWN_STATUSES = ['processed', 'discarded', 'attempting'] as const;

/**
 * Rejected by `IInbox.release` when the row id is malformed, or the marker is
 * missing or not parked. Names the outcome and, for `not-parked`, the
 * marker's status only when it is one of the three known values — a row
 * edited to carry anything else (line breaks included) is reported as not
 * parked with no `status`, so no stored text reaches the message.
 *
 * @since 0.9.0
 */
export class InboxRowStateError extends Error {
  /** Why nothing was written. */
  readonly outcome: 'invalid-id' | 'missing' | 'not-parked';
  /**
   * The marker's actual status, for `not-parked` when it is a known status;
   * absent otherwise.
   * Declared, not initialized, so the other outcomes carry no `status` key.
   */
  declare readonly status?: 'processed' | 'discarded' | 'attempting';

  /**
   * Builds the refusal from the store's outcome.
   *
   * @param outcome - `invalid-id`, `missing` or `not-parked`
   * @param stored - The marker's status as read, for `not-parked`; kept
   *   only when it is a known status
   */
  constructor(
    outcome: 'invalid-id' | 'missing' | 'not-parked',
    stored?: 'processed' | 'discarded' | 'attempting',
  ) {
    // The status comes from a stored row, so it is checked, not trusted.
    const status = (KNOWN_STATUSES as readonly unknown[]).includes(stored) ? stored : undefined;
    super(
      outcome === 'invalid-id'
        ? 'inbox: a row id is 64 lowercase hexadecimal characters, as IInbox.parked() lists it'
        : outcome === 'missing'
        ? 'inbox: no inbox marker has that id'
        : `inbox: the marker is ${status ?? 'not parked'}, so it cannot be released`,
    );
    this.name = 'InboxRowStateError';
    this.outcome = outcome;
    if (status !== undefined) {
      Object.defineProperty(this, 'status', { value: status, enumerable: true });
    }
  }
}
