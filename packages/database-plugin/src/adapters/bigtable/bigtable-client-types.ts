/**
 * The structural Bigtable client facade — the only shape the adapter, the data
 * source and the transaction speak.
 *
 * It is deliberately NOT the `@google-cloud/bigtable` surface. Three
 * differences are load-bearing rather than cosmetic, and each records a fact
 * measured against the real emulator:
 *
 * - **Promises, not `[value]` tuples.** The SDK resolves every call to a
 *   one-element array. Adapting that once, in `bigtable-client.ts`, keeps the
 *   tuple out of nine call sites and out of every test double.
 * - **One read path.** The SDK offers both `table.getRows()` and
 *   `row.get()`, and `row.get()` REJECTS with a 404 for an absent row rather
 *   than answering nothing. A point read is therefore expressed here as a
 *   one-key {@linkcode IBigtableTable.readRows}, which answers `[]` — so the
 *   adapter has exactly one read path and no 404 branch to forget.
 * - **`conditionalMutate` returns the match flag.** The SDK's
 *   `row.filter(test, branches)` is CheckAndMutateRow, whose boolean is what
 *   makes `create` refuse an existing row and `update` refuse an absent one.
 *
 * An application may implement this facade itself and pass it as
 * `options.client`, which is the route for a client built with non-default
 * credentials or interceptors.
 *
 * @module
 */

/**
 * One stored cell: the raw value bytes as text, plus the server's timestamp.
 *
 * Bigtable keeps a timestamped version history per cell and returns the
 * versions **newest first** (measured). This adapter reads version `[0]` and
 * exposes no version surface — cell versioning has no counterpart in the
 * portable data-access contract.
 *
 * @since 0.2.0
 */
export interface BigtableCell {
  /** The cell value, as the text the adapter's value codec wrote. */
  readonly value: string;
  /** The server-assigned cell timestamp, in microseconds, as the SDK reports it. */
  readonly timestamp?: string;
}

/**
 * A row's cells, addressed `family → qualifier → versions`.
 *
 * @since 0.2.0
 */
export type BigtableRowData = Readonly<
  Record<string, Readonly<Record<string, readonly BigtableCell[]>>>
>;

/**
 * One row as a read returns it.
 *
 * @since 0.2.0
 */
export interface BigtableReadRow {
  /** The row key. */
  readonly key: string;
  /** The row's cells. */
  readonly data: BigtableRowData;
}

/**
 * One end of a row-key range.
 *
 * The `inclusive` flag is always written explicitly, and that is a
 * correctness requirement rather than a style: the SDK's `{ start, end }`
 * shorthand is **inclusive at both ends** (measured — a `[u#002, u#004]` scan
 * returned `u#004`), so a range built with the shorthand silently returns one
 * row too many at the top.
 *
 * @since 0.2.0
 */
export interface BigtableRowBoundary {
  /** The boundary row key. */
  readonly value: string;
  /** Whether the boundary row itself is included. */
  readonly inclusive: boolean;
}

/**
 * A row-key range. An omitted end is unbounded in that direction.
 *
 * @since 0.2.0
 */
export interface BigtableRowRange {
  /** The lower bound, or unbounded when omitted. */
  readonly start?: BigtableRowBoundary;
  /** The upper bound, or unbounded when omitted. */
  readonly end?: BigtableRowBoundary;
}

/**
 * An exact byte range a cell value must fall in.
 *
 * Used only in its degenerate `start === end` form, which is an exact byte
 * match. The SDK's string form (`{ value: 'a.*b' }`) is a **regex** — measured,
 * it matched both `a.*b` and `axxb` — so this adapter never uses it and has no
 * escaping to get wrong.
 *
 * @since 0.2.0
 */
export interface BigtableValueRange {
  /** The inclusive lower bound. */
  readonly start: string;
  /** The inclusive upper bound. */
  readonly end: string;
}

/**
 * A server-side read filter.
 *
 * The union covers exactly the shapes this adapter builds: a column-family
 * test, a qualifier-name test, an exact value-range test, a value-stripping
 * pass-through, a per-row cell cap, and the `condition`, `chain` and
 * `interleave` combinators that compose them.
 *
 * The cell cap exists for one reason. A filter that removes every cell of a
 * row removes the **row** — the service does not answer with an empty row
 * (measured) — so a projection naming columns a given row happens not to carry
 * would silently drop it. Interleaving a one-cell arm keeps the row present at
 * the cost of at most one extra cell, which the caller's own projection then
 * discards.
 *
 * @since 0.2.0
 */
export type BigtableFilter =
  | { readonly family: string }
  | { readonly column: readonly string[] }
  | { readonly value: BigtableValueRange }
  | { readonly value: { readonly strip: true } }
  | { readonly all: true }
  | { readonly row: { readonly cellLimit: number } }
  | { readonly interleave: readonly (readonly BigtableFilter[])[] }
  | { readonly chain: readonly BigtableFilter[] }
  | {
    readonly condition: {
      readonly test: readonly BigtableFilter[];
      readonly pass?: readonly BigtableFilter[];
    };
  };

/**
 * What a read asks the server for.
 *
 * @since 0.2.0
 */
export interface BigtableReadOptions {
  /** An explicit key list. A key with no row contributes no result. */
  readonly keys?: readonly string[];
  /** Row-key ranges, unioned. */
  readonly ranges?: readonly BigtableRowRange[];
  /** A server-side filter applied to every candidate row. */
  readonly filter?: BigtableFilter;
  /** A server-side row cap. Omitted means unbounded. */
  readonly limit?: number;
}

/**
 * One mutation in a CheckAndMutateRow branch or a batch entry.
 *
 * The order within a list is preserved and the whole list applies atomically
 * to its row (measured: `[delete, insert]` replaced a row wholesale, dropping a
 * qualifier the insert did not name).
 *
 * @since 0.2.0
 */
export type BigtableMutation =
  | { readonly method: 'delete' }
  | {
    readonly method: 'insert';
    readonly data: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };

/**
 * One entry of a batch write: a row key plus the mutation applied to it.
 *
 * @since 0.2.0
 */
export interface BigtableEntry {
  /** The row key the mutation targets. */
  readonly key: string;
  /** The mutation to apply. */
  readonly mutation: BigtableMutation;
}

/**
 * The row-scoped write surface: one atomic check-and-mutate.
 *
 * @since 0.2.0
 */
export interface IBigtableRow {
  /**
   * Applies one branch of a CheckAndMutateRow atomically.
   *
   * @param test - The predicate evaluated against the row
   * @param branches - The mutation lists for a matching and a non-matching row
   * @returns `true` when the test matched (so `onMatch` ran), `false` otherwise
   */
  conditionalMutate(
    test: readonly BigtableFilter[],
    branches: {
      readonly onMatch?: readonly BigtableMutation[];
      readonly onNoMatch?: readonly BigtableMutation[];
    },
  ): Promise<boolean>;
}

/**
 * One table's data-plane surface.
 *
 * @since 0.2.0
 */
export interface IBigtableTable {
  /**
   * Reads rows matching the supplied key set, range set and filter.
   *
   * @param options - What to read
   * @returns The matching rows, in row-key order
   */
  readRows(options: BigtableReadOptions): Promise<BigtableReadRow[]>;
  /**
   * Returns the row-scoped write surface for one key.
   *
   * @param key - The row key
   * @returns The row handle
   */
  row(key: string): IBigtableRow;
  /**
   * Applies a batch of per-row mutations. Each entry is atomic on its own row;
   * the batch as a whole is not.
   *
   * @param entries - The mutations to apply
   */
  mutate(entries: readonly BigtableEntry[]): Promise<void>;
}

/**
 * One Bigtable instance.
 *
 * @since 0.2.0
 */
export interface IBigtableInstance {
  /**
   * Returns a handle for one table. No RPC is issued.
   *
   * @param id - The table id
   * @returns The table handle
   */
  table(id: string): IBigtableTable;
}

/**
 * The Bigtable client the adapter drives.
 *
 * @since 0.2.0
 */
export interface IBigtableClient {
  /**
   * Returns a handle for one instance. No RPC is issued.
   *
   * @param id - The instance id
   * @returns The instance handle
   */
  instance(id: string): IBigtableInstance;
  /**
   * Releases the client's gRPC channels.
   */
  close(): Promise<void>;
}
