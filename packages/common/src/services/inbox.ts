/**
 * Consumer inbox contract — the store port the messaging plugin's inbox
 * records handled deliveries through.
 *
 * The inbox inserts a marker keyed by `(consumer, topic, envelope id)` in the SAME
 * database transaction as a subscription handler's own writes, so a duplicate
 * delivery is acknowledged without running the handler and a failed handler
 * leaves no marker behind. The delivery path lives in
 * `@setu-ts/messaging-plugin`; the store that persists rows is implemented by
 * `@setu-ts/database-plugin`'s `createDatabaseInboxStore()` (or by an
 * application). The port lives here because the implementing package must
 * name it without importing the plugin that consumes it (AI_GUIDELINES
 * §2.2).
 *
 * @module
 * @since 0.9.0
 */

/**
 * The discriminator every inbox row carries in its `kind` column.
 *
 * A store writes it on every row and requires it in the `where` of every
 * read, so a business document that shares the inbox's entity is never read,
 * listed, counted, released or purged as an inbox row.
 *
 * @since 0.9.0
 */
export const INBOX_RECORD_KIND = 'setu-inbox';

/**
 * Status of an inbox row.
 *
 * - `processed` — a marker: the delivery's handler committed.
 * - `parked` — a marker: the delivery failed `maxAttempts` times and was
 *   acknowledged without being applied; an operator releases it.
 * - `discarded` — a marker: an operator discarded a parked delivery.
 * - `attempting` — the separate failure-count row of a delivery.
 *
 * @since 0.9.0
 */
export type InboxStatus = 'processed' | 'parked' | 'discarded' | 'attempting';

/**
 * One inbox row. Every field is a JSON scalar, so the row is portable to
 * every backend the store supports (times are epoch milliseconds).
 *
 * Optional fields are ABSENT when they carry no value, never `undefined`.
 *
 * @since 0.9.0
 */
export interface InboxRecord {
  /**
   * The primary key: the marker id (64 lowercase hex characters), or for the
   * failure-count row the marker id followed by `.attempts`.
   */
  readonly id: string;
  /** The discriminator, always {@linkcode INBOX_RECORD_KIND}. */
  readonly kind: typeof INBOX_RECORD_KIND;
  /** The consumer name the delivery was handled under. */
  readonly consumer: string;
  /** The subscription topic. */
  readonly topic: string;
  /**
   * The envelope id, stored only when it is a valid publish id (at most 128
   * UTF-8 bytes, no control or format characters). Absent otherwise.
   */
  readonly envelopeId?: string;
  /** The row's status. */
  readonly status: InboxStatus;
  /** Failures recorded for the delivery; `0` on a first-try success. */
  readonly attempts: number;
  /** Epoch milliseconds of the row's last write — the retention clock. */
  readonly updatedAt: number;
  /** The last handler failure, one bounded line. Absent when none. */
  readonly lastError?: string;
  /**
   * The delivered envelope as received, on a `parked` marker within the
   * configured size cap. Absent otherwise.
   */
  readonly envelope?: string;
}

/**
 * The two row ids of one delivery: its marker and its failure-count row.
 *
 * @since 0.9.0
 */
export interface InboxIds {
  /** The marker id. */
  readonly marker: string;
  /** The failure-count row id. */
  readonly attempts: string;
}

/**
 * What {@linkcode IInboxStore.recordFailure} writes on the failure-count row.
 *
 * @since 0.9.0
 */
export interface InboxFailureUpdate {
  /** The consumer name. */
  readonly consumer: string;
  /** The subscription topic. */
  readonly topic: string;
  /** The envelope id, when it is a valid publish id. */
  readonly envelopeId?: string;
  /** The failure, one bounded line. */
  readonly lastError: string;
  /** Epoch milliseconds. */
  readonly now: number;
}

/**
 * The answer to {@linkcode IInboxStore.release}. Only `applied` wrote
 * anything.
 *
 * @since 0.9.0
 */
export type InboxReleaseOutcome =
  | {
    /** The marker was parked and was released. */
    readonly outcome: 'applied';
    /** The marker as it was before the release. */
    readonly record: InboxRecord;
  }
  | {
    /** No inbox marker with that id exists (a row of another `kind` counts as missing). */
    readonly outcome: 'missing';
  }
  | {
    /** The marker was not parked; nothing written. */
    readonly outcome: 'not-parked';
    /** The marker's actual status. */
    readonly status: Exclude<InboxStatus, 'parked'>;
  };

/**
 * Counts read by {@linkcode IInboxStore.stats} for the inbox health
 * indicator.
 *
 * @since 0.9.0
 */
export interface InboxStoreStats {
  /** Markers with status `parked`. */
  readonly parked: number;
}

/**
 * The inbox store port.
 *
 * Every method returns a promise that REJECTS on failure and never throws
 * synchronously. Every read requires `kind` to equal
 * {@linkcode INBOX_RECORD_KIND}, and a row of another `kind` is treated as
 * missing; a custom store must honour both rules.
 *
 * @since 0.9.0
 */
export interface IInboxStore {
  /**
   * Reads a marker by id.
   *
   * @param markerId - The marker id
   * @returns The marker, or `undefined` when none exists
   */
  find(markerId: string): Promise<InboxRecord | undefined>;

  /**
   * Opens ONE transaction, creates the marker in it FIRST, then runs `work`
   * with the transaction's unit of work, and commits. Any rejection rolls the
   * whole transaction back — the marker included — and propagates.
   *
   * @param marker - The `processed` marker to create
   * @param work - The handler, given the unit of work
   * @returns What `work` resolved to
   */
  run<R>(marker: InboxRecord, work: (scope: unknown) => Promise<R>): Promise<R>;

  /**
   * Records one handler failure on the failure-count row, OUTSIDE any
   * transaction: creates it with `attempts: 1`, or increments it.
   *
   * @param ids - The delivery's row ids
   * @param update - What to record
   * @returns The new failure count
   */
  recordFailure(ids: InboxIds, update: InboxFailureUpdate): Promise<number>;

  /**
   * Creates a `parked` marker, outside any transaction.
   *
   * @param marker - The parked marker
   * @returns `'applied'`, or `'exists'` when a marker was already present
   */
  park(marker: InboxRecord): Promise<'applied' | 'exists'>;

  /**
   * Lists parked markers, never reading their envelopes.
   *
   * @param limit - Maximum markers returned
   * @returns The parked markers, without `envelope`
   */
  parked(limit: number): Promise<readonly InboxRecord[]>;

  /**
   * Releases a parked marker: `retry` deletes it and the failure-count row;
   * `discard` marks it `discarded`, clears its envelope and deletes the
   * failure-count row.
   *
   * @param ids - The delivery's row ids
   * @param action - `retry` or `discard`
   * @param now - Epoch milliseconds
   * @returns `applied` with the marker as it was, `missing`, or `not-parked`
   */
  release(ids: InboxIds, action: 'retry' | 'discard', now: number): Promise<InboxReleaseOutcome>;

  /**
   * Counts parked markers.
   *
   * @returns The counts
   */
  stats(): Promise<InboxStoreStats>;

  /**
   * Deletes rows of every status — `processed`, `discarded`, `attempting` and
   * `parked` — last written before `before`, at most `limit` per status. A
   * parked marker is purged like any other, so no row outlives the window
   * while the caller's purge rate keeps up with inflow.
   *
   * @param before - Epoch milliseconds; rows with `updatedAt < before` are deleted
   * @param limit - Maximum rows deleted per status
   * @returns The number of rows deleted (a row already gone counts zero)
   */
  purge(before: number, limit: number): Promise<number>;

  /**
   * Refuses, at startup, a backend that cannot serve the inbox.
   *
   * @returns A promise that rejects naming why the store cannot serve
   */
  verify(): Promise<void>;
}
