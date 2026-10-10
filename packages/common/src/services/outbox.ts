/**
 * Transactional outbox contract — the store port the messaging plugin's
 * outbox writes through and relays from.
 *
 * The outbox writes an integration-event envelope as a row in the SAME
 * database transaction as the business change, and a relay publishes
 * persisted rows to the broker afterwards. The relay lives in
 * `@setu-ts/messaging-plugin`; the store that persists rows is implemented
 * by `@setu-ts/database-plugin`'s `createDatabaseOutboxStore()` (or by an
 * application). The port lives here because the implementing package must
 * name it without importing the plugin that consumes it (AI_GUIDELINES
 * §2.2).
 *
 * @module
 * @since 0.9.0
 */

/**
 * The discriminator every outbox row carries in its `kind` column.
 *
 * A store writes it on every row and requires it in the `where` of every
 * read, so a business document that shares the outbox's entity (a Cosmos
 * container, for one, is queried as a whole) is never read, counted,
 * transitioned or deleted as an outbox row.
 *
 * @since 0.9.0
 */
export const OUTBOX_RECORD_KIND = 'setu-outbox';

/**
 * Lifecycle of an outbox row.
 *
 * - `pending` — written, not yet published (or awaiting a retry).
 * - `sent` — published; kept until retention purges it.
 * - `failed` — exhausted its attempts or could not be decoded; blocks its
 *   ordering key until an operator releases it.
 * - `discarded` — released by an operator without publishing.
 *
 * @since 0.9.0
 */
export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'discarded';

/**
 * One outbox row. Every field is a JSON scalar, so the row is portable to
 * every backend the store supports (times are epoch milliseconds, never a
 * `Date`).
 *
 * Optional fields are ABSENT when they carry no value, never `undefined`.
 *
 * @since 0.9.0
 */
export interface OutboxRecord {
  /** The envelope id — the primary key. */
  readonly id: string;
  /** The discriminator, always {@linkcode OUTBOX_RECORD_KIND}. */
  readonly kind: typeof OUTBOX_RECORD_KIND;
  /** The integration-event definition's topic. */
  readonly topic: string;
  /** `JSON.stringify` of the envelope, built at write time. */
  readonly envelope: string;
  /**
   * `JSON.stringify` of the EFFECTIVE publish options
   * (`{ orderingKey?, deduplicationId, headers? }`).
   */
  readonly options: string;
  /**
   * The effective ordering key, duplicated out of `options` because the
   * relay blocks on it. Absent when the event has none.
   */
  readonly orderingKey?: string;
  /** The tenant the writer named. Absent when none. */
  readonly tenantId?: string;
  /** The W3C `traceparent` active at write time. Absent when none. */
  readonly traceparent?: string;
  /**
   * The one ordering column: 15 decimal digits of clamped milliseconds
   * followed by the envelope id's 32 lowercase hex characters, with no
   * separators.
   */
  readonly position: string;
  /** Epoch milliseconds at write — the real time, used for age. */
  readonly createdAt: number;
  /** The row's lifecycle status. */
  readonly status: OutboxStatus;
  /** Publish attempts recorded. */
  readonly attempts: number;
  /** Epoch milliseconds before which the relay must not retry the row. */
  readonly availableAt: number;
  /** Monotonic claim counter; claimable in [0, Number.MAX_SAFE_INTEGER - 1]. @since 0.9.0 */
  readonly claimVersion: number;
  /** Claim expiry in epoch milliseconds; zero when unclaimed. @since 0.9.0 */
  readonly leaseUntil: number;
  /** The last publish failure, one bounded line. Absent when none. */
  readonly lastError?: string;
  /**
   * Epoch milliseconds the row became `sent` or `discarded`; the retention
   * clock. Absent until then.
   */
  readonly settledAt?: number;
  /**
   * `<relay instance id>/<scheduled | dispatch>` of the sweep that sent the
   * row. Absent until sent.
   */
  readonly sentBy?: string;
}

/**
 * The ordering key a `failed` row blocks, as read by
 * {@linkcode IOutboxStore.failedKeys}. Each member is absent when the row
 * carries none.
 *
 * @since 0.9.0
 */
export interface OutboxKey {
  /** The row's tenant, absent when none. */
  readonly tenantId?: string;
  /** The row's ordering key, absent when the row is unkeyed. */
  readonly orderingKey?: string;
}

/**
 * The answer to a conditional status transition
 * ({@linkcode IOutboxStore.markSent}, {@linkcode IOutboxStore.markFailure},
 * {@linkcode IOutboxStore.release}).
 *
 * Only `applied` wrote anything. Every other outcome reports why nothing was
 * written, so a late failure can never regress a `sent` row.
 *
 * @since 0.9.0
 */
export type OutboxTransition =
  | {
    /** The row had the expected status and was written. */
    readonly outcome: 'applied';
  }
  | {
    /** No outbox row with that id exists (a row of another `kind` counts as missing). */
    readonly outcome: 'missing';
  }
  | {
    /** `markSent` / `markFailure`: the row was not `pending`; nothing written. */
    readonly outcome: 'not-pending';
    /** The row's actual status. */
    readonly status: Exclude<OutboxStatus, 'pending'>;
  }
  | {
    /** The pending row has another claim version; nothing written. @since 0.9.0 */
    readonly outcome: 'claim-lost';
  }
  | {
    /** `release`: the row was not `failed`; nothing written. */
    readonly outcome: 'not-failed';
    /** The row's actual status. */
    readonly status: Exclude<OutboxStatus, 'failed'>;
  };

/**
 * Counts read by {@linkcode IOutboxStore.stats} for the outbox health
 * indicator and metrics.
 *
 * @since 0.9.0
 */
export interface OutboxStoreStats {
  /** Rows with status `pending`. */
  readonly pending: number;
  /** Rows with status `failed`. */
  readonly failed: number;
  /**
   * `createdAt` of the first pending row in `position` order. Absent when no
   * row is pending.
   */
  readonly oldestPendingCreatedAt?: number;
}

/**
 * The slice of a unit of work the outbox write needs: a repository whose
 * `create` runs inside the caller's transaction.
 *
 * `@setu-ts/database-plugin`'s `IUnitOfWork` satisfies it structurally, so a
 * caller passes the unit of work its own `transaction(...)` handed it.
 *
 * @since 0.9.0
 */
export interface IOutboxWriteScope {
  /**
   * Returns the transaction-scoped repository for an entity.
   *
   * @param entity - The entity name
   * @returns A repository whose `create` writes inside the caller's transaction
   */
  getRepository(entity: string): {
    /**
     * Creates a row.
     *
     * @param data - The row to write
     * @returns A promise that settles when the row is written (or buffered for commit)
     */
    create(data: Readonly<Record<string, unknown>>): Promise<unknown>;
  };
}

/**
 * The outbox store port.
 *
 * Every method returns a promise that REJECTS on failure and never throws
 * synchronously. Every transition reads the row and writes only from the
 * expected status, and every read requires `kind` to equal
 * {@linkcode OUTBOX_RECORD_KIND}; a custom store must honour both rules.
 *
 * @since 0.9.0
 */
export interface IOutboxStore {
  /**
   * Writes a row inside the caller's transaction.
   *
   * @param scope - The caller's unit of work
   * @param record - The row to write
   * @returns A promise that rejects with the adapter's `DuplicateKeyError`
   * for a duplicate id
   */
  append(scope: IOutboxWriteScope, record: OutboxRecord): Promise<void>;

  /**
   * Reads `pending` rows in ascending `position` order.
   *
   * Applies NO `availableAt` filter: the relay decides what a row's backoff
   * means for its key.
   *
   * @param after - Exclusive lower bound on `position`; `undefined` reads from the start
   * @param limit - Maximum rows returned
   * @returns The rows, in `position` order
   */
  scanPending(after: string | undefined, limit: number): Promise<readonly OutboxRecord[]>;

  /**
   * Reads the keys of `failed` rows, never their envelopes.
   *
   * @param limit - Maximum keys returned
   * @returns The failed rows' tenant and ordering keys
   */
  failedKeys(limit: number): Promise<readonly OutboxKey[]>;

  /**
   * Claims a pending row at the read version, incrementing that version by one.
   *
   * @param id - The row id
   * @param update - The read version and the new lease expiry
   * @returns `applied`, `missing`, `not-pending`, or `claim-lost`
   * @since 0.9.0
   */
  claim(
    id: string,
    update: {
      /** Version read by the caller, in [0, Number.MAX_SAFE_INTEGER - 1]. @since 0.9.0 */
      readonly claimVersion: number;
      /** New claim expiry in epoch milliseconds. @since 0.9.0 */
      readonly leaseUntil: number;
    },
  ): Promise<OutboxTransition>;

  /**
   * Poisons an invalid pending row without a claim, preserving its attempts.
   * Writes `failed`, `invalid-row`, `availableAt: now`, and `leaseUntil: 0`.
   *
   * @param id - The row id
   * @param now - Epoch milliseconds
   * @returns `applied`, `missing`, or `not-pending`
   * @since 0.9.0
   */
  markInvalid(id: string, now: number): Promise<OutboxTransition>;

  /**
   * Marks a `pending` row as sent (or deletes it when `deleteNow` is set).
   *
   * @param id - The row id
   * @param update - The settlement time, the sending sweep, and whether to delete instead
   * @returns `applied`, or why nothing was written
   */
  markSent(
    id: string,
    update: {
      /** Version held by the sending relay. @since 0.9.0 */
      readonly claimVersion: number;
      /** Settlement time in epoch milliseconds. @since 0.9.0 */
      readonly settledAt: number;
      /** Sending instance and sweep origin, for operator diagnostics. @since 0.9.0 */
      readonly sentBy: string;
      /** Delete immediately instead of retaining the sent row. @since 0.9.0 */
      readonly deleteNow: boolean;
    },
  ): Promise<OutboxTransition>;

  /**
   * Records a publish failure on a `pending` row.
   *
   * @param id - The row id
   * @param update - The attempt count, error line, next retry time, and new status
   * @returns `applied`, or why nothing was written
   */
  markFailure(
    id: string,
    update: {
      /** Version held by the publishing relay. @since 0.9.0 */
      readonly claimVersion: number;
      readonly attempts: number;
      readonly lastError: string;
      readonly availableAt: number;
      readonly status: 'pending' | 'failed';
    },
  ): Promise<OutboxTransition>;

  /**
   * Releases a `failed` row: `retry` returns it to `pending` with
   * `attempts: 0` and `availableAt: now`; `discard` makes it `discarded` with
   * `settledAt: now`.
   *
   * @param id - The row id
   * @param action - `retry` or `discard`
   * @param now - Epoch milliseconds
   * @returns `applied`, `missing`, or `not-failed`
   */
  release(id: string, action: 'retry' | 'discard', now: number): Promise<OutboxTransition>;

  /**
   * Counts pending and failed rows and reads the oldest pending row's age.
   *
   * @returns The counts
   */
  stats(): Promise<OutboxStoreStats>;

  /**
   * Deletes `sent`, then `discarded`, rows settled before `before`.
   *
   * @param before - Epoch milliseconds; rows with `settledAt < before` are deleted
   * @param limit - Maximum rows deleted per status
   * @returns The number of rows deleted (a row already gone counts zero)
   */
  purge(before: number, limit: number): Promise<number>;

  /**
   * Refuses, at startup, a backend that cannot serve the outbox.
   *
   * @returns A promise that rejects naming why the store cannot serve
   */
  verify(): Promise<void>;
}
