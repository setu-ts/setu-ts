/**
 * Errors the database plugin throws, exported so consumers can branch on them
 * with `instanceof` rather than matching message text.
 *
 * @module
 */

/**
 * Thrown at translation time when a filter operator cannot be honoured by the
 * active backend **with the connector in use**.
 *
 * The current case is the Prisma adapter's `contains` on SQLite: Prisma emits
 * no `ESCAPE` clause and SQLite defines no default escape character, so a
 * literal substring match is not expressible through Prisma's filter API there.
 * Returning wrong rows quietly is the defect; returning a named error is the
 * repair. The error names the operator, the connector, and the adapters that
 * do support the operator, so the caller can choose a path (switch adapters,
 * use a raw query, or pass `provider` to disambiguate).
 *
 * @example
 * ```typescript
 * import { UnsupportedFilterOperatorError } from '@setu-ts/database-plugin';
 *
 * try {
 *   await repo.findAll({ filter: { type: 'comparison', field: 'name', operator: 'contains', value: '50%' } });
 * } catch (err) {
 *   if (err instanceof UnsupportedFilterOperatorError) {
 *     console.error(`'${err.operator}' is unsupported on ${err.connector ?? 'an unknown connector'}`);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class UnsupportedFilterOperatorError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnsupportedFilterOperatorError';

  /** The filter operator that could not be translated (e.g. `'contains'`). */
  readonly operator: string;

  /**
   * The connector the operator failed on, or `undefined` when the connector
   * could not be determined. `'sqlite'` names the concrete refusal; `undefined`
   * means the adapter could not identify its connector and the `provider`
   * option is the fix.
   */
  readonly connector: string | undefined;

  /**
   * Creates the error. The `message` is the full diagnostic — safe to log, never
   * to serve — and names the operator and, when known, the connector.
   *
   * @param operator - The filter operator that could not be translated
   * @param connector - The connector, or `undefined` when undetermined
   * @param message - The full diagnostic, safe to log
   */
  constructor(operator: string, connector: string | undefined, message: string) {
    super(message);
    this.operator = operator;
    this.connector = connector;
  }
}

/**
 * Thrown by {@linkcode MongoAdapter.rawQuery} — MongoDB has no SQL, so a raw
 * query is refused by name rather than emulated (the silent-divergence defect
 * M70j closed). The error names the adapter and points at the injected client
 * for native commands.
 *
 * It rejects, never throws synchronously — a synchronous throw from a
 * `Promise`-typed method is the M52b/M52c/M70j defect class.
 *
 * @example
 * ```typescript
 * import { UnsupportedRawQueryError } from '@setu-ts/database-plugin';
 * try {
 *   await adapter.rawQuery('SELECT 1');
 * } catch (err) {
 *   if (err instanceof UnsupportedRawQueryError) {
 *     console.error(err.message);
 *   }
 * }
 * ```
 * @since 0.1.0
 */
export class UnsupportedRawQueryError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnsupportedRawQueryError';

  /**
   * Creates the error.
   *
   * @param message - The full diagnostic, safe to log
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when an adapter refuses a query feature that is expressible in the
 * portable {@linkcode IDataSource} contract but not supported by the active
 * backend.
 *
 * Carries the feature, the adapter, and a `name` discriminant so consumers
 * can branch with `instanceof` rather than matching message text. Every
 * refusal reachable from a `Promise`-returning method rejects rather than
 * throwing synchronously.
 *
 * @example
 * ```typescript
 * import { UnsupportedQueryFeatureError } from '@setu-ts/database-plugin';
 * try {
 *   await repo.findById({ tenantId: 't1', userId: 7 });
 * } catch (err) {
 *   if (err instanceof UnsupportedQueryFeatureError) {
 *     console.error(`Feature '${err.feature}' unsupported on ${err.adapter}`);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class UnsupportedQueryFeatureError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnsupportedQueryFeatureError';

  /** The query feature that could not be honoured (e.g. `'composite-key'`). */
  readonly feature: string;

  /** The adapter name (e.g. `'prisma'`, `'drizzle'`, `'memory'`). */
  readonly adapter: string;

  /**
   * Creates the error. The `message` is the full diagnostic — safe to log, never
   * to serve — and names the feature and the adapter.
   *
   * @param feature - The query feature that is not supported
   * @param adapter - The adapter name
   * @param message - The full diagnostic, safe to log
   */
  constructor(feature: string, adapter: string, message: string) {
    super(message);
    this.feature = feature;
    this.adapter = adapter;
  }
}

/**
 * Thrown by {@linkcode MongoAdapter.beginTransaction} on a deployment without
 * a replica set.
 *
 * A standalone `mongod` is a legitimate deployment for an application that
 * never opens a transaction, so the refusal is named and late — it happens at
 * `beginTransaction()`, never at `connect()`, where probing would cost a round
 * trip on every boot and refuse a working configuration.
 *
 * @example
 * ```typescript
 * import { MongoTransactionUnavailableError } from '@setu-ts/database-plugin';
 * try {
 *   await adapter.beginTransaction();
 * } catch (err) {
 *   if (err instanceof MongoTransactionUnavailableError) {
 *     console.error(err.message);
 *   }
 * }
 * ```
 * @since 0.1.0
 */
export class MongoTransactionUnavailableError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'MongoTransactionUnavailableError';

  /**
   * Creates the error.
   *
   * @param message - The full diagnostic, safe to log
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when a Cosmos transaction is asked to do something a transactional
 * batch cannot express.
 *
 * Cosmos offers atomicity only as a batch that is scoped to ONE container and
 * ONE partition-key value, and capped at 100 operations (measured: a second
 * partition-key value answers 400, and the 101st operation is refused by the
 * SDK). A Unit of Work that crosses one of those bounds is refused at the
 * write that crosses it, rather than at commit, so the caller learns which
 * write broke the scope instead of merely that the batch did.
 *
 * @example
 * ```typescript
 * try {
 *   await db.transaction(async (uow) => {
 *     await uow.getRepository('Order').create({ id: 'o1', tenantId: 't1' });
 *     await uow.getRepository('Order').create({ id: 'o2', tenantId: 't2' });
 *   });
 * } catch (err) {
 *   if (err instanceof CosmosTransactionScopeError) {
 *     console.error(err.message);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class CosmosTransactionScopeError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'CosmosTransactionScopeError';

  /**
   * Creates the error.
   *
   * @param message - The full diagnostic, safe to log
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when a Cosmos update loses an optimistic-concurrency race.
 *
 * An update whose payload exceeds the per-request patch limit is served by a
 * read-merge-replace, and that replace is conditional on the `_etag` the read
 * returned. A concurrent writer between the two answers **412**, which is
 * surfaced here rather than silently overwriting the other writer's row.
 *
 * @since 0.2.0
 */
export class CosmosConcurrentModificationError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'CosmosConcurrentModificationError';

  /**
   * Creates the error.
   *
   * @param message - The full diagnostic, safe to log
   */
  constructor(message: string) {
    super(message);
  }
}
