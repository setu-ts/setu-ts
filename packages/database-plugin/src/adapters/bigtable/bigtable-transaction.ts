/**
 * The Bigtable transaction: one row, one atomic mutation list.
 *
 * **Bigtable's only atomicity unit is the single row.** A multi-row batch
 * (`MutateRows`) is atomic per entry and not as a whole, so a handle that
 * accepted several row keys would promise something the platform does not
 * offer. Refusing transactions outright would instead strand the committed
 * `IDatabaseService.transaction()`, so this takes the third option, which is
 * the one the platform actually supports: a transaction targets exactly ONE
 * row key, and a write that leaves that bound is refused **at the write**, with
 * {@linkcode BigtableTransactionScopeError} naming what it crossed — the
 * `CosmosTransactionScopeError` precedent.
 *
 * Writes are **deferred**: they are buffered and flushed at `commit()` as one
 * CheckAndMutateRow whose mutation list applies atomically and in order
 * (measured: `[delete, insert]` replaced a row wholesale, dropping a qualifier
 * the insert did not name). Reads inside the transaction observe committed
 * state only — the contract's deferred-write clause, and the shape `D1Adapter`
 * and `CosmosTransaction` established.
 *
 * @module
 */
import type { IAdapterTransaction, IDataSource } from '@setu-ts/common';
import { BigtableTransactionScopeError } from '../../errors.ts';
import type {
  BigtableMutation,
  IBigtableInstance,
  IBigtableTable,
} from './bigtable-client-types.ts';
import type { BigtableTarget } from './bigtable-mapping.ts';

/** A family → qualifier → encoded-value cell bag. */
export type BigtableCellBag = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * The write sink a transaction-scoped data source drives.
 *
 * @internal
 */
export interface IBigtableWriteBuffer {
  /**
   * Claims the transaction's single (table, row key) pair.
   *
   * @param table - The physical table id
   * @param rowKey - The row key being written
   * @param operation - The calling operation, quoted in a refusal
   * @throws {BigtableTransactionScopeError} When a different row is already claimed
   */
  claim(table: string, rowKey: string, operation: string): void;
  /**
   * Buffers a cell write, merging it over anything already buffered.
   *
   * @param cells - The cells to write
   * @param requiresAbsent - `true` for a `create`, whose commit must refuse an
   *   existing row
   */
  insert(cells: BigtableCellBag, requiresAbsent: boolean): void;
  /** Buffers a whole-row delete, discarding any cells buffered before it. */
  remove(): void;
}

/**
 * The buffered state of one transaction.
 *
 * @internal
 */
interface BufferState {
  /** The claimed table id. */
  table: string;
  /** The claimed row key. */
  rowKey: string;
  /** Whether a whole-row delete is buffered ahead of the cells. */
  deleted: boolean;
  /** The cells buffered since the last delete. */
  cells: Record<string, Record<string, string>>;
  /** Whether the FIRST buffered operation was a `create`. */
  requiresAbsent: boolean;
  /** Whether any operation has been buffered at all. */
  touched: boolean;
}

/**
 * A single-row deferred-write transaction.
 *
 * @since 0.2.0
 */
export class BigtableTransaction implements IAdapterTransaction, IBigtableWriteBuffer {
  readonly #instance: IBigtableInstance;
  readonly #resolve: (entity: string) => BigtableTarget;
  readonly #createDataSource: (
    table: IBigtableTable,
    target: BigtableTarget,
    buffer: IBigtableWriteBuffer,
  ) => IDataSource;
  #state: BufferState | null = null;
  #settled = false;

  /**
   * Creates the handle.
   *
   * @param instance - The Bigtable instance the tables live in
   * @param resolve - Resolves an entity name to its target
   * @param createDataSource - Builds a transaction-scoped data source
   */
  constructor(
    instance: IBigtableInstance,
    resolve: (entity: string) => BigtableTarget,
    createDataSource: (
      table: IBigtableTable,
      target: BigtableTarget,
      buffer: IBigtableWriteBuffer,
    ) => IDataSource,
  ) {
    this.#instance = instance;
    this.#resolve = resolve;
    this.#createDataSource = createDataSource;
  }

  /**
   * Opens a data source bound to this transaction.
   *
   * @param entity - The entity name
   * @returns The transaction-scoped data source
   */
  createDataSource(entity: string): IDataSource {
    const target = this.#resolve(entity);
    return this.#createDataSource(this.#instance.table(target.table), target, this);
  }

  /** @inheritdoc */
  claim(table: string, rowKey: string, operation: string): void {
    if (this.#settled) {
      throw new BigtableTransactionScopeError(
        `Bigtable transaction has already settled; ${operation} cannot buffer another write.`,
      );
    }
    const state = this.#state;
    if (state === null) {
      this.#state = {
        table,
        rowKey,
        deleted: false,
        cells: {},
        requiresAbsent: false,
        touched: false,
      };
      return;
    }
    if (state.table === table && state.rowKey === rowKey) return;
    throw new BigtableTransactionScopeError(
      `Bigtable transactions are atomic on ONE row: this transaction already targets ` +
        `'${state.table}'/'${state.rowKey}', and ${operation} targets '${table}'/'${rowKey}'. ` +
        `Bigtable's only atomicity unit is the single row, so a second row would need a second ` +
        `transaction.`,
    );
  }

  /** @inheritdoc */
  insert(cells: BigtableCellBag, requiresAbsent: boolean): void {
    const state = this.#requireState();
    if (!state.touched) state.requiresAbsent = requiresAbsent;
    state.touched = true;
    for (const [family, qualifiers] of Object.entries(cells)) {
      const existing = state.cells[family] ?? {};
      state.cells[family] = { ...existing, ...qualifiers };
    }
  }

  /** @inheritdoc */
  remove(): void {
    const state = this.#requireState();
    state.touched = true;
    state.deleted = true;
    // A delete supersedes every cell buffered before it: the commit's mutation
    // list applies in order, so a cell written earlier would be erased by the
    // delete anyway. Clearing here keeps the buffer and the wire in agreement.
    state.cells = {};
  }

  /**
   * Flushes the buffer as ONE atomic CheckAndMutateRow.
   *
   * @throws {Error} When the transaction has already settled, when a buffered
   *   `create` finds the row present, or when a buffered `update` finds it absent
   */
  async commit(): Promise<void> {
    if (this.#settled) throw new Error('Bigtable transaction has already settled');
    this.#settled = true;
    const state = this.#state;
    if (state === null || !state.touched) return;

    const mutations: BigtableMutation[] = [];
    if (state.deleted) mutations.push({ method: 'delete' });
    if (Object.keys(state.cells).length > 0) {
      mutations.push({ method: 'insert', data: state.cells });
    }
    if (mutations.length === 0) return;

    const row = this.#instance.table(state.table).row(state.rowKey);
    // The predicate is not decoration: it is what makes a buffered `create`
    // refuse an existing row atomically, rather than the non-transactional
    // path's guarantee quietly degrading to an upsert inside a transaction.
    const matched = state.requiresAbsent
      ? await row.conditionalMutate([{ all: true }], { onNoMatch: mutations })
      : await row.conditionalMutate([{ all: true }], {
        onMatch: mutations,
        onNoMatch: mutations,
      });
    if (state.requiresAbsent && matched) {
      throw new Error(
        `Bigtable row '${state.table}'/'${state.rowKey}' already exists; the transaction's ` +
          `create was not applied.`,
      );
    }
  }

  /**
   * Discards the buffer without sending anything.
   *
   * Idempotent, unlike `commit()`. The framework rolls back inside the same
   * `catch` that saw a failed commit, so a refusal here would replace the
   * commit's own diagnostic with a complaint about rollback.
   */
  rollback(): Promise<void> {
    this.#settled = true;
    this.#state = null;
    return Promise.resolve();
  }

  /**
   * Returns the buffered state, refusing a write with no claim.
   *
   * @returns The state
   * @throws {BigtableTransactionScopeError} When nothing has been claimed
   */
  #requireState(): BufferState {
    const state = this.#state;
    if (state === null) {
      throw new BigtableTransactionScopeError(
        'Bigtable transaction received a write before any row was claimed.',
      );
    }
    return state;
  }
}
