/**
 * Errors the database plugin throws, exported so consumers can branch on them
 * with `instanceof` rather than matching message text.
 *
 * Five of them additionally carry an `HttpStatusHint` from `@setu-ts/common`,
 * so `errorHandler` answers a safe, permanent refusal `501 Not Implemented`
 * with a caller-safe sentence instead of a masked `500` (M89b, X19-1):
 * {@linkcode UnsupportedIsolationLevelError}, {@linkcode UnsupportedFilterOperatorError} and
 * {@linkcode UnsupportedRawQueryError} always, and
 * {@linkcode UnsupportedMigrationError}, and
 * {@linkcode UnsupportedQueryFeatureError} for the `feature` values in
 * `QUERY_SHAPE_FEATURES` — that class is shared by caller-caused query
 * refusals AND by configuration refusals, so branding it unconditionally
 * turned a misconfigured deployment into a caller-facing `501`.
 *
 * Two more — {@linkcode SerializationConflictError} and
 * {@linkcode DatabaseUnavailableError} (M90f, X38-1/X35-2) — carry `409` and
 * `503` hints: TRANSIENT conditions the caller can act on by retrying, where
 * the `501` refusals above are permanent. Both wrap the original driver error
 * as `cause`, produced by `classifyDriverError` (`errors/classify.ts`) at
 * `DatabaseService`'s interception sites.
 *
 * The pre-existing transaction/concurrency scope errors are deliberately NOT
 * branded: they may legitimately quote backend state, and they keep the
 * masked `500` that stops a driver diagnostic reaching a caller (X12-3).
 *
 * The served `detail` is composed from this package's own fields or a fixed
 * framework sentence, never from the `message`, which is the operator-facing
 * diagnostic. That is what makes the masking exemption safe rather than a
 * widening.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * The status every caller-safe refusal in this module is answered with.
 *
 * One constant rather than repeated literals keeps every permanent
 * not-implemented response consistent.
 */
const NOT_IMPLEMENTED = { status: 501, title: 'Not Implemented' } as const;

/**
 * Thrown when a database adapter cannot honour a requested transaction
 * isolation level.
 *
 * @since 0.5.0
 */
export class UnsupportedIsolationLevelError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnsupportedIsolationLevelError';

  /** Creates a named, caller-safe isolation refusal. */
  constructor(readonly adapter: string, readonly level: string) {
    super(`The '${adapter}' database adapter does not support '${level}' transaction isolation.`);
    withHttpStatusHint(this, {
      ...NOT_IMPLEMENTED,
      detail:
        `Transaction isolation '${level}' is not supported by the '${adapter}' database adapter.`,
    });
  }
}

/**
 * The {@linkcode UnsupportedQueryFeatureError} `feature` values that name a
 * condition the **caller** caused, and are therefore answered `501` rather
 * than a masked `500`.
 *
 * This class is shared by two kinds of refusal, which is why the brand is not
 * unconditional (M89b code review, Qodo finding 3). A caller-caused refusal
 * describes the query or payload the application just sent — its sort, its
 * cursor, its key, a value the backend cannot represent — and `501` is honest:
 * the backend does not implement what was asked for, permanently.
 *
 * The values deliberately absent describe the **deployment**, not the request:
 *
 * - `'mapping'` — the application's own `tables`/`entities` configuration
 *   (a blank column family, an unusable qualifier). Measured: before this
 *   allowlist a blank `columnFamily` answered every request
 *   `501 "Query feature 'mapping' is not supported by the 'bigtable' database
 *   adapter."` — which is a lie twice over, since the deployment is
 *   misconfigured and no query feature is missing.
 * - `'endpoint'` — a malformed endpoint URL, and the refusal of a plaintext
 *   HTTP endpoint to a remote host. Both are raised from the client loader at
 *   `connect()`, so they fail `app.start()` and cannot reach a response at
 *   all; they are listed here so the split reads completely.
 * - `'date-encoding'` — an attribute missing from the `dateAttributes`
 *   declaration: configuration, surfaced by a query.
 * - `'transaction'` — a duplicate key or an over-limit batch in the caller's
 *   own buffer. Kept unbranded so that NO transaction-scope condition is
 *   branded, matching the three dedicated scope-error classes below.
 *
 * **An unlisted value is NOT branded**, and that default is the point: a
 * feature name added later keeps the masked `500` it has today until someone
 * decides otherwise, so a mistake here can never invent a caller-facing status
 * for an internal fault. Un-branding is never a regression; branding is.
 */
const QUERY_SHAPE_FEATURES: ReadonlySet<string> = new Set([
  'attribute-value',
  'composite-key',
  'cursor-pagination',
  'key',
  'nested-path',
  'offset',
  // BOTH spellings, deliberately: the DynamoDB adapter throws `'orderBy'`
  // (`dynamo-access-path.ts`) while the Bigtable one throws `'order-by'`
  // (`bigtable-scan.ts`). That inconsistency predates this milestone and is
  // NOT normalised here — `feature` is a released field a consumer may branch
  // on — but listing only one spelling silently drops the other back to a
  // masked 500. An enumeration that missed `'orderBy'` is exactly how the
  // first draft of this list shipped, caught by the Dynamo integration test.
  'order-by',
  'orderBy',
  'row-key',
  'update',
]);

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
    withHttpStatusHint(this, {
      ...NOT_IMPLEMENTED,
      detail: connector === undefined
        ? `Filter operator '${operator}' is not supported by the active database connector.`
        : `Filter operator '${operator}' is not supported on the '${connector}' connector.`,
    });
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

  /** The adapter name that refused the raw query (e.g. `'mongodb'`). */
  readonly adapter: string;

  /**
   * Creates the error. The `message` is the full diagnostic — safe to log,
   * never to serve — and names the adapter plus the native alternative.
   *
   * @param adapter - The adapter name that refused the query
   * @param message - The full diagnostic, safe to log
   */
  constructor(adapter: string, message: string) {
    super(message);
    this.adapter = adapter;
    withHttpStatusHint(this, {
      ...NOT_IMPLEMENTED,
      detail: `Raw queries are not supported by the '${adapter}' database adapter.`,
    });
  }
}

/**
 * Thrown by {@linkcode IDatabaseService.migrate} because programmatic
 * migrations are not implemented by the current adapters.
 *
 * Each adapter owns schema migration through its own CLI. The refusal is a
 * permanent framework capability boundary, so it rejects with a `501` hint
 * rather than reading as an internal server fault.
 *
 * @example
 * ```typescript
 * import { UnsupportedMigrationError } from '@setu-ts/database-plugin';
 *
 * try {
 *   await db.migrate();
 * } catch (error) {
 *   if (error instanceof UnsupportedMigrationError) {
 *     console.error(error.message);
 *   }
 * }
 * ```
 * @since 0.4.0
 */
export class UnsupportedMigrationError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnsupportedMigrationError';

  /**
   * Creates the error with an operator-facing diagnostic that is never served.
   *
   * @param message - The full diagnostic, safe to log
   */
  constructor(message: string) {
    super(message);
    withHttpStatusHint(this, {
      ...NOT_IMPLEMENTED,
      detail: 'Programmatic migrations are not supported by the current database adapters.',
    });
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
   * @param options - Native error options, including an underlying `cause`
   */
  constructor(feature: string, adapter: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.feature = feature;
    this.adapter = adapter;
    // Branded only for a caller-caused query shape — see
    // `QUERY_SHAPE_FEATURES`. A configuration or deployment refusal keeps the
    // masked `500` that is correct for an internal fault.
    if (QUERY_SHAPE_FEATURES.has(feature)) {
      withHttpStatusHint(this, {
        ...NOT_IMPLEMENTED,
        detail: `Query feature '${feature}' is not supported by the '${adapter}' database adapter.`,
      });
    }
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
   * @param options - Native error options, including an underlying `cause`
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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

/**
 * Thrown when a Bigtable transaction is asked to write a second row.
 *
 * Bigtable's only atomicity unit is the **single row**: a multi-row batch is
 * atomic per entry and not as a whole. A handle that accepted several row keys
 * would therefore promise an atomicity the platform does not offer, so the
 * refusal happens at the write that crosses the bound rather than at commit,
 * naming both rows — the {@linkcode CosmosTransactionScopeError} precedent.
 *
 * @example
 * ```typescript
 * import { BigtableTransactionScopeError } from '@setu-ts/database-plugin';
 * try {
 *   await uow.getRepository('User').create({ id: 'u1' });
 *   await uow.getRepository('User').create({ id: 'u2' });
 * } catch (err) {
 *   if (err instanceof BigtableTransactionScopeError) {
 *     console.error(err.message);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class BigtableTransactionScopeError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'BigtableTransactionScopeError';

  /**
   * Creates the error.
   *
   * @param message - The full diagnostic, safe to log, naming what was crossed
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * The status every caller-actionable driver condition in this module is
 * answered with, and its two titles.
 *
 * These are distinct from the `501` refusals above on purpose: a conflict or
 * an outage is TRANSIENT and the operation may be retried, where a `501`
 * marks a permanent capability boundary. `Retry-After` is deliberately not
 * carried — see `DatabaseUnavailableError`.
 */
const CONFLICT = { status: 409, title: 'Conflict' } as const;
const UNAVAILABLE = { status: 503, title: 'Service Unavailable' } as const;

/**
 * Thrown when the database rejected a write because a concurrent transaction
 * changed the same data (X38-1, M90f). The operation did **not** happen and
 * **may be retried**.
 *
 * The condition reaches the client as `409 Conflict` — the canonical
 * retryable-signal status — instead of the masked `500` that told a
 * well-behaved client to give up, silently dropping the write and making
 * optimistic concurrency unusable. The original driver error is preserved as
 * `cause`, so the operator's diagnostic still reaches the SQLSTATE (M90j
 * keeps that reachable), while the served `detail` is the fixed sentence
 * here — never the driver message, which on a pg error quotes the failing
 * statement (X12-3 stays closed).
 *
 * The `detail` is also the answer to "what would a caller have been relying
 * on before": a masked `500` carrying `Internal Server Error` and nothing
 * else, which is not a behaviour any caller can depend on.
 *
 * @example
 * ```typescript
 * import { SerializationConflictError } from '@setu-ts/database-plugin';
 * try {
 *   await db.transaction(async (uow) => {
 *     const row = await uow.getRepository('Account').findById(id);
 *     await uow.getRepository('Account').update(id, { balance: row.balance - 10 });
 *   });
 * } catch (err) {
 *   if (err instanceof SerializationConflictError) {
 *     // Retry: the transaction rolled back without applying.
 *   }
 * }
 * ```
 * @since 0.5.0
 */
export class SerializationConflictError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'SerializationConflictError';

  /**
   * Creates the error. The `message` is the full diagnostic — safe to log,
   * never to serve.
   *
   * @param message - The full diagnostic, safe to log
   * @param options - The original driver error, preserved as `cause`
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    withHttpStatusHint(this, {
      ...CONFLICT,
      detail:
        'The write conflicted with a concurrent transaction and was rolled back. It is safe to retry.',
    });
  }
}

/**
 * Thrown when the database, its connection pool, or its network is
 * temporarily unreachable (X35-2, M90f). The operation did **not** happen and
 * **may be retried**.
 *
 * The condition reaches the client as `503 Service Unavailable` — the
 * load-shedding status — instead of a masked `500`. **No `Retry-After` is
 * carried, and the hint channel cannot carry one**: `ErrorResponseInit` has
 * no header channel, and the framework holds no honest value to invent — a
 * pool's saturation has no published horizon. `503` is itself the retryable
 * signal (RFC 9110), and the rate limiter's `Retry-After` (which does know
 * its reset point) is the deliberate asymmetry, recorded in `PUBLIC_API.md`.
 *
 * @example
 * ```typescript
 * import { DatabaseUnavailableError } from '@setu-ts/database-plugin';
 * try {
 *   await repo.findAll(query);
 * } catch (err) {
 *   if (err instanceof DatabaseUnavailableError) {
 *     // Back off and retry: the pool or connection is saturated.
 *   }
 * }
 * ```
 * @since 0.5.0
 */
export class DatabaseUnavailableError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'DatabaseUnavailableError';

  /**
   * Creates the error. The `message` is the full diagnostic — safe to log,
   * never to serve.
   *
   * @param message - The full diagnostic, safe to log
   * @param options - The original driver error, preserved as `cause`
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    withHttpStatusHint(this, {
      ...UNAVAILABLE,
      detail: 'The database is temporarily unavailable. The request was not applied.',
    });
  }
}
