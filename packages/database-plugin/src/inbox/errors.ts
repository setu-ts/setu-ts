/**
 * The inbox bridge's startup refusal (M108).
 *
 * @module
 */

/** The diagnostic each reason states, after the entity name. */
const REASON_TEXT: Readonly<Record<InboxStoreUnavailableError['reason'], string>> = {
  'cosmos-unsupported':
    'Cosmos DB cannot serve an inbox (a transaction is one partition, and the inbox row cannot ' +
    'share the business partition)',
  'bigtable-unsupported': 'Bigtable cannot serve an inbox (one row per transaction)',
  'mongodb-standalone': 'MongoDB transactions need a replica set',
  'transaction-scope':
    'the database refused a second row in one transaction, so the inbox row cannot be written ' +
    "beside the handler's own rows",
  'entity-unavailable': 'the inbox entity is missing or unreadable',
};

/**
 * Rejected by `verify()` of the store {@linkcode createDatabaseInboxStore}
 * builds when the configured backend cannot serve the inbox.
 *
 * The inbox runs `verify()` at startup, before any inbox subscription is
 * established, so an unusable backend is a named startup failure rather than
 * a subscription that fails every delivery. The adapter's own error, when
 * there is one, is kept as `cause` for the log; the message names the entity
 * and the reason, never a row's contents.
 *
 * @example
 * ```typescript
 * import { InboxStoreUnavailableError } from '@setu-ts/database-plugin';
 *
 * try {
 *   await app.start({ port: 3000 });
 * } catch (error) {
 *   if (error instanceof InboxStoreUnavailableError && error.reason === 'mongodb-standalone') {
 *     // run MongoDB as a replica set
 *   }
 *   throw error;
 * }
 * ```
 * @since 0.9.0
 */
export class InboxStoreUnavailableError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'InboxStoreUnavailableError';

  /** The inbox entity the store was configured with. */
  readonly entity: string;

  /**
   * Why the backend cannot serve the inbox — a fixed vocabulary, so an
   * application can branch on it without matching message text:
   *
   * - `'cosmos-unsupported'` — a Cosmos DB transaction is one partition, and
   *   the inbox row cannot be made to share the business partition.
   * - `'bigtable-unsupported'` — Bigtable allows one row per transaction.
   * - `'mongodb-standalone'` — the server refused a transaction (code `20`,
   *   `IllegalOperation`): MongoDB transactions need a replica set.
   * - `'transaction-scope'` — the startup probe's second row in one
   *   transaction was refused (a custom adapter with a one-row bound).
   * - `'entity-unavailable'` — anything else: the inbox entity is missing or
   *   unreadable.
   */
  readonly reason:
    | 'cosmos-unsupported'
    | 'bigtable-unsupported'
    | 'mongodb-standalone'
    | 'transaction-scope'
    | 'entity-unavailable';

  /**
   * Creates the error.
   *
   * @param entity - The inbox entity the store was configured with
   * @param reason - Why the backend cannot serve the inbox
   * @param options - Native error options; `cause` is the adapter's refusal
   */
  constructor(
    entity: string,
    reason: InboxStoreUnavailableError['reason'],
    options?: ErrorOptions,
  ) {
    super(
      `The inbox store for entity '${entity}' cannot serve the inbox: ${REASON_TEXT[reason]}.`,
      options,
    );
    this.entity = entity;
    this.reason = reason;
  }
}
