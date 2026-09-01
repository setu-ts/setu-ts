/**
 * An in-memory {@linkcode IBigtableClient} that reproduces the emulator
 * semantics this adapter depends on.
 *
 * Every behaviour below was measured against `cbtemulator` through
 * `npm:@google-cloud/bigtable@^6` before it was written here, because a
 * fixture that merely accepts what the adapter sends tests the fixture. The
 * ones that would otherwise be guessed wrong:
 *
 * - a range boundary honours its own `inclusive` flag (the SDK's `{start,end}`
 *   shorthand is inclusive at BOTH ends, which is why the adapter never uses
 *   it);
 * - a value filter matches an exact BYTE RANGE, so a metacharacter in the
 *   value has no regex meaning;
 * - a bare filter chain STRIPS non-matching cells from the answer, while a
 *   `condition` whose `pass` runs against the original row returns it whole;
 * - a row whose cells are all filtered away is absent from the result, which is
 *   why a projection is interleaved with a one-cell arm;
 * - an `interleave` unions its arms' surviving cells;
 * - CheckAndMutateRow reports whether the test matched, and applies its branch
 *   as an ordered, atomic list;
 * - cell versions come back NEWEST FIRST, and cells come back in lexicographic
 *   family-then-qualifier order rather than write order;
 * - rows are ordered as UTF-8 BYTES, which is code-point order, not the UTF-16
 *   code-unit order JavaScript's `<` applies.
 *
 * @module
 */
import type {
  BigtableCell,
  BigtableFilter,
  BigtableMutation,
  BigtableReadOptions,
  BigtableReadRow,
  BigtableRowBoundary,
  BigtableRowData,
  IBigtableClient,
  IBigtableInstance,
  IBigtableRow,
  IBigtableTable,
} from '../../src/adapters/bigtable/bigtable-client-types.ts';
import { compareRowKeys } from '../../src/adapters/bigtable/bigtable-row-key.ts';

/** A mutable cell set: family → qualifier → versions, newest first. */
type MutableRow = Map<string, Map<string, BigtableCell[]>>;

/** One recorded read, for tests that assert what was pushed down. */
export interface RecordedRead {
  /** The table the read targeted. */
  readonly table: string;
  /** The read request as the adapter built it. */
  readonly options: BigtableReadOptions;
}

/**
 * The in-memory store shared by every handle a fake client hands out.
 *
 * @since 0.2.0
 */
export class FakeBigtableStore {
  /** table id → row key → cells. */
  readonly tables = new Map<string, Map<string, MutableRow>>();
  /** Every read the adapter issued, in order. */
  readonly reads: RecordedRead[] = [];
  /** How many times `close()` was called. */
  closes = 0;
  /**
   * Returns (creating if needed) one table's rows.
   *
   * @param table - The table id
   * @returns The row map
   */
  rows(table: string): Map<string, MutableRow> {
    let rows = this.tables.get(table);
    if (rows === undefined) {
      rows = new Map();
      this.tables.set(table, rows);
    }
    return rows;
  }

  /**
   * Writes cells into a row, newest version first — the raw seam a test uses
   * to plant a row written OUTSIDE this framework.
   *
   * @param table - The table id
   * @param key - The row key
   * @param cells - family → qualifier → cell text
   */
  seed(
    table: string,
    key: string,
    cells: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): void {
    const rows = this.rows(table);
    let row = rows.get(key);
    if (row === undefined) {
      row = new Map();
      rows.set(key, row);
    }
    for (const [family, qualifiers] of Object.entries(cells)) {
      let stored = row.get(family);
      if (stored === undefined) {
        stored = new Map();
        row.set(family, stored);
      }
      for (const [qualifier, value] of Object.entries(qualifiers)) {
        const versions = stored.get(qualifier) ?? [];
        // Newest first, exactly as the service returns them.
        versions.unshift({ value });
        stored.set(qualifier, versions);
      }
    }
  }

  /**
   * Reads one row's current cells as a plain object.
   *
   * @param table - The table id
   * @param key - The row key
   * @returns The cells, or `undefined` when no row exists
   */
  snapshot(table: string, key: string): Record<string, Record<string, string>> | undefined {
    const row = this.tables.get(table)?.get(key);
    if (row === undefined) return undefined;
    const out: Record<string, Record<string, string>> = {};
    for (const [family, qualifiers] of row) {
      out[family] = {};
      for (const [qualifier, versions] of qualifiers) out[family][qualifier] = versions[0].value;
    }
    return out;
  }
}

/**
 * Whether a row key falls within one boundary pair.
 *
 * Ordered with {@linkcode compareRowKeys}, not `<`: the service sorts row keys
 * as UTF-8 bytes and JavaScript's operators compare UTF-16 code units, which
 * disagree for every non-BMP character. A double comparing with `<` would place
 * an emoji-bearing key on the opposite side of a boundary from the real
 * service.
 */
function withinBoundary(
  key: string,
  start: BigtableRowBoundary | undefined,
  end: BigtableRowBoundary | undefined,
): boolean {
  if (start !== undefined) {
    const order = compareRowKeys(key, start.value);
    if (start.inclusive ? order < 0 : order <= 0) return false;
  }
  if (end !== undefined) {
    const order = compareRowKeys(key, end.value);
    if (end.inclusive ? order > 0 : order >= 0) return false;
  }
  return true;
}

/**
 * Deep-copies a row's cells so a filter never mutates the store, in
 * **lexicographic family-then-qualifier order**.
 *
 * The order is not cosmetic. The service returns cells sorted, not in write
 * order, and a filter that caps cells per row (`{ row: { cellLimit } }`) keeps
 * the FIRST ones — so a double preserving insertion order would rescue a
 * different cell than production does, and a test asserting which cell
 * survived would pass here and fail against Bigtable.
 */
function copyRow(row: MutableRow): MutableRow {
  const copy: MutableRow = new Map();
  for (const family of [...row.keys()].sort()) {
    const qualifiers = row.get(family) as Map<string, BigtableCell[]>;
    const inner = new Map<string, BigtableCell[]>();
    for (const qualifier of [...qualifiers.keys()].sort()) {
      inner.set(qualifier, [...(qualifiers.get(qualifier) as BigtableCell[])]);
    }
    copy.set(family, inner);
  }
  return copy;
}

/** Whether a cell set holds at least one cell. */
function hasCells(row: MutableRow): boolean {
  for (const qualifiers of row.values()) {
    if (qualifiers.size > 0) return true;
  }
  return false;
}

/**
 * Applies one filter to a cell set, answering the cells that survive.
 *
 * @param row - The cells to filter (never mutated)
 * @param filter - The filter to apply
 * @returns The surviving cells
 */
function applyFilter(row: MutableRow, filter: BigtableFilter): MutableRow {
  if ('all' in filter) return copyRow(row);
  if ('chain' in filter) return applyChain(row, filter.chain);
  if ('interleave' in filter) {
    // The UNION of every arm's surviving cells, deduplicated by
    // family+qualifier — which is what keeps a row present when one arm keeps
    // nothing.
    const merged: MutableRow = new Map();
    for (const arm of filter.interleave) {
      for (const [family, qualifiers] of applyChain(row, arm)) {
        const inner = merged.get(family) ?? new Map<string, BigtableCell[]>();
        for (const [qualifier, versions] of qualifiers) {
          if (!inner.has(qualifier)) inner.set(qualifier, [...versions]);
        }
        merged.set(family, inner);
      }
    }
    return merged;
  }
  if ('row' in filter) {
    // The first `cellLimit` cells of the row, in the service's own
    // lexicographic order.
    const kept: MutableRow = new Map();
    let remaining = filter.row.cellLimit;
    for (const [family, qualifiers] of copyRow(row)) {
      if (remaining <= 0) break;
      const inner = new Map<string, BigtableCell[]>();
      for (const [qualifier, versions] of qualifiers) {
        if (remaining <= 0) break;
        inner.set(qualifier, [...versions]);
        remaining -= 1;
      }
      if (inner.size > 0) kept.set(family, inner);
    }
    return kept;
  }
  if ('condition' in filter) {
    // The `test` decides; `pass` runs against the ORIGINAL row, which is what
    // makes a condition return the whole row rather than only the tested cell.
    const tested = applyChain(row, filter.condition.test);
    if (!hasCells(tested)) return new Map();
    return filter.condition.pass === undefined
      ? copyRow(row)
      : applyChain(row, filter.condition.pass);
  }
  if ('family' in filter) {
    const kept: MutableRow = new Map();
    const qualifiers = row.get(filter.family);
    if (qualifiers !== undefined) {
      kept.set(filter.family, new Map([...qualifiers].map(([q, v]) => [q, [...v]])));
    }
    return kept;
  }
  if ('column' in filter) {
    const wanted = new Set(filter.column);
    const kept: MutableRow = new Map();
    for (const [family, qualifiers] of row) {
      const inner = new Map<string, BigtableCell[]>();
      for (const [qualifier, versions] of qualifiers) {
        if (wanted.has(qualifier)) inner.set(qualifier, [...versions]);
      }
      if (inner.size > 0) kept.set(family, inner);
    }
    return kept;
  }
  // `value`
  const spec = filter.value;
  if ('strip' in spec) {
    const kept: MutableRow = new Map();
    for (const [family, qualifiers] of row) {
      const inner = new Map<string, BigtableCell[]>();
      for (const [qualifier, versions] of qualifiers) {
        inner.set(qualifier, versions.map((cell) => ({ ...cell, value: '' })));
      }
      kept.set(family, inner);
    }
    return kept;
  }
  const kept: MutableRow = new Map();
  for (const [family, qualifiers] of row) {
    const inner = new Map<string, BigtableCell[]>();
    for (const [qualifier, versions] of qualifiers) {
      // An exact BYTE range — never a regex, which is what the SDK's string
      // form is and why the adapter never uses it.
      const surviving = versions.filter((cell) =>
        cell.value >= spec.start && cell.value <= spec.end
      );
      if (surviving.length > 0) inner.set(qualifier, surviving);
    }
    if (inner.size > 0) kept.set(family, inner);
  }
  return kept;
}

/** Applies a filter chain in sequence. */
function applyChain(row: MutableRow, chain: readonly BigtableFilter[]): MutableRow {
  let current = copyRow(row);
  for (const filter of chain) current = applyFilter(current, filter);
  return current;
}

/** Renders a filtered cell set as the facade's read shape, in service order. */
function toReadRow(key: string, row: MutableRow): BigtableReadRow {
  const data: Record<string, Record<string, BigtableCell[]>> = {};
  for (const [family, qualifiers] of copyRow(row)) {
    if (qualifiers.size === 0) continue;
    data[family] = {};
    for (const [qualifier, versions] of qualifiers) data[family][qualifier] = versions;
  }
  return { key, data: data as BigtableRowData };
}

/** Applies one mutation to a table's rows. */
function applyMutation(
  store: FakeBigtableStore,
  table: string,
  key: string,
  mutation: BigtableMutation,
): void {
  if (mutation.method === 'delete') {
    store.rows(table).delete(key);
    return;
  }
  store.seed(table, key, mutation.data);
}

/**
 * Creates a fake client over a store.
 *
 * @param store - The shared in-memory store
 * @returns The client facade
 * @since 0.2.0
 */
export function createFakeBigtableClient(store: FakeBigtableStore): IBigtableClient {
  const makeTable = (tableId: string): IBigtableTable => ({
    readRows: (options: BigtableReadOptions): Promise<BigtableReadRow[]> => {
      store.reads.push({ table: tableId, options });
      const rows = store.rows(tableId);
      let candidates = [...rows.keys()].sort(compareRowKeys);
      if (options.keys !== undefined && options.keys.length > 0) {
        const wanted = new Set(options.keys);
        candidates = candidates.filter((key) => wanted.has(key));
      }
      if (options.ranges !== undefined && options.ranges.length > 0) {
        candidates = candidates.filter((key) =>
          options.ranges?.some((range) => withinBoundary(key, range.start, range.end)) ?? false
        );
      }
      const results: BigtableReadRow[] = [];
      for (const key of candidates) {
        const stored = rows.get(key);
        if (stored === undefined) continue;
        const filtered = options.filter === undefined
          ? copyRow(stored)
          : applyFilter(stored, options.filter);
        // A filter that removes every cell removes the ROW — the service does
        // not answer with an empty row.
        if (!hasCells(filtered)) continue;
        results.push(toReadRow(key, filtered));
        if (options.limit !== undefined && results.length >= options.limit) break;
      }
      return Promise.resolve(results);
    },
    row: (key: string): IBigtableRow => ({
      conditionalMutate: (test, branches): Promise<boolean> => {
        const stored = store.rows(tableId).get(key);
        const matched = stored !== undefined && hasCells(applyChain(stored, test));
        const mutations = matched ? branches.onMatch : branches.onNoMatch;
        for (const mutation of mutations ?? []) {
          applyMutation(store, tableId, key, mutation);
        }
        return Promise.resolve(matched);
      },
    }),
  });

  const instance: IBigtableInstance = { table: makeTable };
  return {
    instance: (): IBigtableInstance => instance,
    close: (): Promise<void> => {
      store.closes += 1;
      return Promise.resolve();
    },
  };
}
