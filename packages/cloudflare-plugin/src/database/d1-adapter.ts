/**
 * `D1Adapter` — Cloudflare D1 as a first-class database backend.
 *
 * Implements the {@linkcode IDatabaseAdapter} port that M52c promoted into
 * `@hono-enterprise/common`. Before that promotion the seam a backend has to
 * satisfy lived inside `database-plugin` and was never exported, so a D1
 * backend could not be written anywhere except inside that package —
 * AI_GUIDELINES §2.2 forbids one plugin importing another.
 *
 * @module
 */

import type { IAdapterTransaction, IDatabaseAdapter, IDataSource } from '@hono-enterprise/common';
import type { ID1Database } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import type { D1Target } from './d1-sql.ts';
import {
  createD1DataSource,
  createD1TransactionDataSource,
  D1TransactionBuffer,
  prepareStatement,
} from './d1-data-source.ts';

/** The primary-key column assumed for an entity with no explicit mapping. */
const DEFAULT_PRIMARY_KEY = 'id';

/**
 * How one entity name maps onto a physical D1 table.
 *
 * @since 0.2.0
 */
export interface D1EntityMapping {
  /**
   * The table name. Defaults to the entity name itself, so
   * `getRepository('users')` needs no mapping at all.
   */
  readonly table?: string;
  /**
   * The primary-key column. Defaults to `'id'`.
   */
  readonly primaryKey?: string;
}

/**
 * Options for {@linkcode D1Adapter}.
 *
 * @since 0.2.0
 */
export interface D1AdapterOptions {
  /**
   * Per-entity table and primary-key overrides, keyed by the entity name
   * passed to `getRepository()`.
   *
   * An entity with no entry uses its own name as the table and `'id'` as the
   * key, which is why the zero-config path works for a schema whose table
   * names already match.
   *
   * @example
   * ```typescript
   * new D1Adapter(env.DB as ID1Database, {
   *   tables: { User: { table: 'users', primaryKey: 'user_id' } },
   * });
   * ```
   */
  readonly tables?: Readonly<Record<string, D1EntityMapping>>;
}

/**
 * A database backend over a Cloudflare D1 binding.
 *
 * Constructed by the **application** from its own binding and handed to
 * `DatabasePlugin({ type: 'custom', adapter })` — the same wiring
 * `KvSessionStore` uses, and for the same reason: `DatabasePlugin`'s options
 * are read when the plugin is constructed, which happens before any
 * application exists, so an adapter published in the service registry could
 * never reach it.
 *
 * ## Transactions
 *
 * D1 has **no interactive transaction**. `BEGIN TRANSACTION` is rejected by
 * the platform outright, and `batch()` — which runs a pre-declared list of
 * statements as one SQL transaction, rolling the whole sequence back if any
 * statement fails — is its only unit of atomicity.
 *
 * `beginTransaction()` therefore **buffers** every write and flushes the whole
 * buffer as one `batch()` at `commit()`; `rollback()` discards the buffer and
 * sends nothing. Two consequences, both deliberate and both under test:
 *
 * - **No read-your-own-writes inside a transaction.** Reads run immediately
 *   against committed state, so a row written earlier in the same transaction
 *   is not visible to a later read in it.
 * - **`create()` inside a transaction requires an explicit primary key**, and
 *   throws naming the constraint when one is absent. A deferred `INSERT`
 *   cannot report a generated key to a caller that awaits `create()` before
 *   the flush. Outside a transaction `create()` uses `RETURNING *` and returns
 *   the real persisted row, generated columns included.
 *
 * @example
 * ```typescript
 * import { env } from 'cloudflare:workers';
 * import { DatabasePlugin } from '@hono-enterprise/database-plugin';
 * import { D1Adapter, type ID1Database } from '@hono-enterprise/cloudflare-plugin';
 *
 * app.register(DatabasePlugin({
 *   type: 'custom',
 *   adapter: new D1Adapter(env.DB as ID1Database, {
 *     tables: { User: { table: 'users' } },
 *   }),
 * }));
 * ```
 * @see https://developers.cloudflare.com/d1/worker-api/d1-database/
 * @since 0.2.0
 */
export class D1Adapter implements IDatabaseAdapter {
  readonly #db: ID1Database;
  readonly #tables: Readonly<Record<string, D1EntityMapping>>;
  #ready = false;

  /**
   * @param db - The D1 binding, from the Worker's `env`
   * @param options - Entity mapping overrides
   */
  constructor(db: ID1Database, options?: D1AdapterOptions) {
    this.#db = db;
    this.#tables = options?.tables ?? {};
  }

  /**
   * @inheritdoc
   *
   * A D1 binding is already live, so there is no pool to open. The flag still
   * matters: the plugin's health indicator reads `isReady()`, and without it a
   * closed application would keep reporting `up` and keep serving queries.
   */
  connect(): Promise<void> {
    this.#ready = true;
    return Promise.resolve();
  }

  /** @inheritdoc */
  disconnect(): Promise<void> {
    this.#ready = false;
    return Promise.resolve();
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this.#ready;
  }

  /** @inheritdoc */
  createDataSource(entity: string): IDataSource {
    this.assertReady();
    return createD1DataSource(this.#db, this.resolveTarget(entity));
  }

  /**
   * @inheritdoc
   *
   * Returns a handle that buffers writes and flushes them as one `batch()`.
   * See the transaction discussion on {@linkcode D1Adapter}.
   */
  // deno-lint-ignore require-await -- must reject, not throw synchronously
  async beginTransaction(): Promise<IAdapterTransaction> {
    this.assertReady();
    const db = this.#db;
    const buffer = new D1TransactionBuffer();

    return {
      createDataSource: (entity: string): IDataSource =>
        createD1TransactionDataSource(db, this.resolveTarget(entity), buffer),

      commit: async (): Promise<void> => {
        buffer.assertOpen();
        const statements = buffer.drain();
        buffer.finalize();
        // An empty transaction is a no-op rather than an empty batch() —
        // there is nothing to make atomic, and no round trip worth paying for.
        if (statements.length === 0) return;
        await db.batch(statements.map((s) => prepareStatement(db, s)));
      },

      rollback: (): Promise<void> => {
        // Nothing was ever sent, so discarding the buffer IS the rollback.
        // Unlike commit(), this is idempotent: DatabaseService rolls back in a
        // catch block, which can run after a failed commit already finalized.
        buffer.finalize();
        return Promise.resolve();
      },
    };
  }

  /** @inheritdoc */
  async rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.assertReady();
    const result = await this.#db.prepare(sql).bind(...(params ?? [])).all<T>();
    return [...result.results];
  }

  /**
   * Resolve an entity name to its table and primary key.
   *
   * @param entity - The entity name passed to `getRepository()`
   * @returns The resolved target
   */
  private resolveTarget(entity: string): D1Target {
    const mapping = this.#tables[entity];
    return {
      table: mapping?.table ?? entity,
      primaryKey: mapping?.primaryKey ?? DEFAULT_PRIMARY_KEY,
    };
  }

  /**
   * Refuse data access before `connect()` and after `disconnect()`.
   *
   * @throws {CloudflareUnsupportedError} When the adapter is not ready
   */
  private assertReady(): void {
    if (!this.#ready) {
      throw new CloudflareUnsupportedError(
        'D1Adapter is not connected — call connect() first. ' +
          'DatabasePlugin does this during register(), and disconnects on shutdown.',
      );
    }
  }
}
