/**
 * The outbox bridge's startup refusal (M107).
 *
 * @module
 */

/** The diagnostic each reason states, after the entity name. */
const REASON_TEXT: Readonly<Record<OutboxStoreUnavailableError['reason'], string>> = {
  'bigtable':
    'Bigtable cannot serve an outbox (no secondary index); use a change-data-capture relay',
  'dynamodb-index':
    "DynamoDB needs a GSI { partitionKey: 'status', sortKey: 'position' } (projection ALL) " +
    'configured for the outbox entity',
  'mongodb-replica-set': 'MongoDB transactions need a replica set',
  'entity-unavailable': 'the outbox entity is missing or unreadable',
};

/**
 * Rejected by `verify()` of the store {@linkcode createDatabaseOutboxStore}
 * builds when the configured backend cannot serve the outbox.
 *
 * The outbox runs `verify()` at startup, before it schedules the relay or
 * accepts a write, so an unusable backend is a named startup failure rather
 * than a relay that fails every tick. The adapter's own error is kept as
 * `cause` for the log; the message names the entity and the reason, never a
 * row's contents.
 *
 * @example
 * ```typescript
 * import { OutboxStoreUnavailableError } from '@setu-ts/database-plugin';
 *
 * try {
 *   await app.start({ port: 3000 });
 * } catch (error) {
 *   if (error instanceof OutboxStoreUnavailableError && error.reason === 'mongodb-replica-set') {
 *     // run MongoDB as a replica set
 *   }
 *   throw error;
 * }
 * ```
 * @since 0.9.0
 */
export class OutboxStoreUnavailableError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'OutboxStoreUnavailableError';

  /** The outbox entity the store was configured with. */
  readonly entity: string;

  /**
   * Why the backend cannot serve the outbox — a fixed vocabulary, so an
   * application can branch on it without matching message text:
   *
   * - `'bigtable'` — Bigtable has no secondary index, so the relay query
   *   (pending rows in `position` order) cannot run; a change-data-capture
   *   relay is the remedy.
   * - `'dynamodb-index'` — DynamoDB orders only by an access path's sort key,
   *   and no GSI `{ partitionKey: 'status', sortKey: 'position' }` is
   *   configured for the outbox entity.
   * - `'mongodb-replica-set'` — the server refused a transaction (code `20`,
   *   `IllegalOperation`): MongoDB transactions need a replica set.
   * - `'entity-unavailable'` — anything else: the outbox entity is missing or
   *   unreadable.
   */
  readonly reason: 'bigtable' | 'dynamodb-index' | 'mongodb-replica-set' | 'entity-unavailable';

  /**
   * Creates the error.
   *
   * @param entity - The outbox entity the store was configured with
   * @param reason - Why the backend cannot serve the outbox
   * @param options - Native error options; `cause` is the adapter's refusal
   */
  constructor(
    entity: string,
    reason: OutboxStoreUnavailableError['reason'],
    options?: ErrorOptions,
  ) {
    super(
      `The outbox store for entity '${entity}' cannot serve the outbox: ${REASON_TEXT[reason]}.`,
      options,
    );
    this.entity = entity;
    this.reason = reason;
  }
}
