/**
 * The tier-C idempotency store's startup refusal (M109b).
 *
 * @module
 */

/** The diagnostic each reason states, after the entity name. */
const REASON_TEXT: Readonly<Record<TransactionalStoreUnavailableError['reason'], string>> = {
  'cosmos-unsupported':
    'Cosmos DB cannot serve tier C (a transaction is one partition, and the idempotency record ' +
    'cannot share the business partition)',
  'bigtable-unsupported': 'Bigtable cannot serve tier C (one row per transaction)',
  'mongodb-standalone': 'MongoDB transactions need a replica set',
  'entity-unavailable': 'the idempotency entity is missing or unreadable',
};

/**
 * Rejected by `verify()` of the store {@linkcode createDatabaseIdempotencyStore}
 * builds when the configured backend cannot serve tier C.
 *
 * The store runs `verify()` at startup, before the first `within`, so an
 * unusable backend is a named startup failure rather than a request that fails
 * every time. The adapter's own error, when there is one, is kept as `cause`
 * for the log; the message names the entity and the reason, never a record's
 * contents.
 *
 * @example
 * ```typescript
 * import { TransactionalStoreUnavailableError } from '@setu-ts/database-plugin';
 *
 * try {
 *   await app.start({ port: 3000 });
 * } catch (error) {
 *   if (
 *     error instanceof TransactionalStoreUnavailableError &&
 *     error.reason === 'mongodb-standalone'
 *   ) {
 *     // run MongoDB as a replica set
 *   }
 *   throw error;
 * }
 * ```
 * @since 0.9.0
 */
export class TransactionalStoreUnavailableError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'TransactionalStoreUnavailableError';

  /** The idempotency entity the store was configured with. */
  readonly entity: string;

  /**
   * Why the backend cannot serve tier C — a fixed vocabulary, so an
   * application can branch on it without matching message text:
   *
   * - `'cosmos-unsupported'` — a Cosmos DB transaction is one partition, and
   *   the idempotency record cannot be made to share the business partition.
   * - `'bigtable-unsupported'` — Bigtable allows one row per transaction.
   * - `'mongodb-standalone'` — the server refused a transaction (code `20`,
   *   `IllegalOperation`): MongoDB transactions need a replica set.
   * - `'entity-unavailable'` — anything else: the idempotency entity is
   *   missing or unreadable.
   */
  readonly reason:
    | 'cosmos-unsupported'
    | 'bigtable-unsupported'
    | 'mongodb-standalone'
    | 'entity-unavailable';

  /**
   * Creates the error.
   *
   * @param entity - The idempotency entity the store was configured with
   * @param reason - Why the backend cannot serve tier C
   * @param options - Native error options; `cause` is the adapter's refusal
   */
  constructor(
    entity: string,
    reason: TransactionalStoreUnavailableError['reason'],
    options?: ErrorOptions,
  ) {
    super(
      `The idempotency store for entity '${entity}' cannot serve tier C: ${REASON_TEXT[reason]}.`,
      options,
    );
    this.entity = entity;
    this.reason = reason;
  }
}
