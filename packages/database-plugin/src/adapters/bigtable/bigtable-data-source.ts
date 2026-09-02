/**
 * The per-entity `IDataSource` over one Bigtable table.
 *
 * Every read goes through {@linkcode planBigtableScan}, which decides what the
 * server can answer exactly; whatever it could not push down is evaluated here
 * by `matchesFilter` — the SAME evaluator the memory adapter uses as the
 * portable reference, so the six backends cannot drift about what a
 * `FilterExpression` means.
 *
 * Every write is a **conditional** single-row mutation rather than a blind
 * one. Bigtable's `insert` is an upsert, so `create` would otherwise overwrite
 * an existing row and `update` would fabricate an absent one; CheckAndMutateRow
 * reports which branch ran, and that boolean is what makes the two refusals
 * real (measured).
 *
 * @module
 */
import type {
  EntityKey,
  FilterExpression,
  IDataSource,
  NormalizedQuery,
  PageResult,
} from '@setu-ts/common';
import { decodeCursor, mintNextCursor, sortFingerprint } from '@setu-ts/common';
import { UnsupportedQueryFeatureError } from '../../errors.ts';
import { matchesFilter, matchesWhere, projectFields } from '../../query/query-builder.ts';
import type {
  BigtableReadOptions,
  BigtableReadRow,
  IBigtableTable,
} from './bigtable-client-types.ts';
import type { BigtableTarget } from './bigtable-mapping.ts';
import { columnAddress } from './bigtable-mapping.ts';
import { composeRowKey, composeRowKeyFromFields, parseRowKey } from './bigtable-row-key.ts';
import { planBigtableScan } from './bigtable-scan.ts';
import { decodeCellValue, encodeCellValue } from './bigtable-value.ts';
import type { BigtableCellBag, IBigtableWriteBuffer } from './bigtable-transaction.ts';

/** The adapter name every refusal carries. */
const ADAPTER = 'bigtable';

/** How many server round trips one `findPage` may take before returning bounded. */
const DEFAULT_MAX_PAGE_FETCHES = 10;

/**
 * Builds the qualifier → field index a decode reads.
 *
 * Only DECLARED columns need an entry: an unmapped field's qualifier is its
 * own name, so the fallback is the identity.
 *
 * @param target - The resolved entity target
 * @returns The index, keyed `family:qualifier`
 */
function buildFieldIndex(target: BigtableTarget): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const [field, address] of Object.entries(target.columns)) {
    index.set(`${address.family}:${address.qualifier}`, field);
  }
  return index;
}

/**
 * Decodes one read row into an entity.
 *
 * The cells are authoritative and the row key is parsed only to fill key
 * fields the cells did not carry. That order is load-bearing: a row key is
 * bytes and records no type, so overlaying it over a cell would turn a numeric
 * key field into a string. The parse-back exists for a table written OUTSIDE
 * this framework, which carries no key cells at all.
 *
 * @param target - The resolved entity target
 * @param index - The qualifier → field index
 * @param row - The row as read
 * @returns The decoded entity
 */
function decodeRow(
  target: BigtableTarget,
  index: ReadonlyMap<string, string>,
  row: BigtableReadRow,
): Record<string, unknown> {
  const entity: Record<string, unknown> = {};
  for (const [family, qualifiers] of Object.entries(row.data)) {
    for (const [qualifier, versions] of Object.entries(qualifiers)) {
      if (versions.length === 0) continue;
      const field = index.get(`${family}:${qualifier}`) ?? qualifier;
      // Versions arrive newest-first (measured), so `[0]` is the current value.
      // Cell versioning has no counterpart in the portable contract and is
      // deliberately not surfaced.
      entity[field] = decodeCellValue(versions[0].value, target.valueEncoding);
    }
  }
  for (const [field, value] of Object.entries(parseRowKey(target, row.key))) {
    if (!(field in entity)) entity[field] = value;
  }
  return entity;
}

/**
 * Builds the cell bag for a write.
 *
 * @param target - The resolved entity target
 * @param data - The field values to write
 * @param operation - The calling operation, quoted in a refusal
 * @returns The cells
 * @throws {UnsupportedQueryFeatureError} When two fields resolve to one
 *   `family:qualifier`, which the decoder could not tell apart
 */
function buildCells(
  target: BigtableTarget,
  index: ReadonlyMap<string, string>,
  data: Readonly<Record<string, unknown>>,
  operation: string,
): BigtableCellBag {
  const cells: Record<string, Record<string, string>> = {};
  for (const [field, value] of Object.entries(data)) {
    // An absent field is an absent CELL, which is what makes a sparse row cheap
    // on a wide-column store — so `undefined` writes nothing rather than a
    // placeholder. `null` is a value and gets a cell.
    if (value === undefined) continue;
    const address = columnAddress(target, field);
    const slot = `${address.family}:${address.qualifier}`;
    // A DECLARED field can own the address an UNMAPPED one resolves to by
    // default — `{ foo: 'cf:bar' }` reserves `cf:bar`, and a field literally
    // named `bar` lands there too. Writing `bar` then succeeded and the
    // decoder, which reads that address back through the declared index,
    // returned it as `foo`: the entity silently changed shape. Checked HERE
    // rather than at mapping time, because the mapping cannot know which
    // fields exist and refusing every remapped qualifier would reject an
    // ordinary `{ createdAt: 'cf:created_at' }`.
    //
    // This is the ONLY collision check the write path needs. A same-payload
    // one used to sit beside it and is now unreachable: two collide only if
    // they share a `family:qualifier`, an unmapped field's qualifier IS its
    // own name so two unmapped fields cannot, two DECLARED fields sharing one
    // are refused at mapping resolution, and a declared/unmapped pair is
    // exactly the case below.
    const declaredOwner = index.get(slot);
    if (declaredOwner !== undefined && declaredOwner !== field) {
      throw new UnsupportedQueryFeatureError(
        'mapping',
        ADAPTER,
        `Bigtable entity '${target.entity}' writes '${field}' to '${slot}' in ${operation}, ` +
          `which the mapping ` +
          `reserves for '${declaredOwner}'. The decoder reads that address back as ` +
          `'${declaredOwner}', so the value would change field on the way out. Map '${field}' ` +
          `explicitly, or give '${declaredOwner}' a qualifier no field name reaches.`,
      );
    }
    const family = cells[address.family] ?? {};
    family[address.qualifier] = encodeCellValue(value, target.valueEncoding);
    cells[address.family] = family;
  }
  return cells;
}

/**
 * The subset of an update payload that actually produces a cell.
 *
 * Mirrors {@linkcode buildCells}' own rule, so the row an update REPORTS and
 * the row it WRITES cannot disagree about a field the caller passed as
 * `undefined`.
 *
 * @param data - The update payload
 * @returns The fields carrying a value
 */
function writtenFields(
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const written: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined) written[field] = value;
  }
  return written;
}

/**
 * Expands an entity key into its named key fields.
 *
 * @param target - The resolved entity target
 * @param id - The primary key
 * @returns The named key fields
 */
function keyFieldsOf(target: BigtableTarget, id: EntityKey): Record<string, unknown> {
  if (typeof id === 'string' || typeof id === 'number') {
    return target.keyFields.length === 1 ? { [target.keyFields[0]]: id } : {};
  }
  return { ...id };
}

/**
 * Refuses an update whose payload would move the row to a different key.
 *
 * Bigtable has no rename: writing a new key would create a SECOND row and
 * leave the original behind, so an update that appears to move a row would
 * silently duplicate it.
 *
 * @param target - The resolved entity target
 * @param id - The key being updated
 * @param data - The update payload
 * @throws {UnsupportedQueryFeatureError} When the payload disagrees with the key
 */
function assertKeyUnchanged(
  target: BigtableTarget,
  id: EntityKey,
  data: Readonly<Record<string, unknown>>,
): void {
  const current = keyFieldsOf(target, id);
  for (const field of target.keyFields) {
    if (!(field in data)) continue;
    const supplied = data[field];
    if (supplied === undefined) continue;
    if (String(supplied) === String(current[field])) continue;
    throw new UnsupportedQueryFeatureError(
      'row-key',
      ADAPTER,
      `Bigtable entity '${target.entity}' cannot move a row: update() was given ` +
        `'${field}' = '${String(supplied)}' for the row keyed ` +
        `'${String(current[field])}'. Bigtable has no rename — writing the new key would ` +
        `create a second row and leave this one behind. Delete and re-create instead.`,
    );
  }
}

/** Everything one data source needs beyond the table handle. */
export interface BigtableDataSourceOptions {
  /** How many server round trips one `findPage` may take. Defaults to 10. */
  readonly maxPageFetches?: number;
  /** The transaction write sink, when the source is transaction-scoped. */
  readonly buffer?: IBigtableWriteBuffer;
}

/**
 * Creates a Bigtable data source bound to one mapped entity.
 *
 * @param table - The physical table handle
 * @param target - The resolved entity target
 * @param options - Paging bound and transaction sink
 * @returns The data source
 * @since 0.2.0
 */
export function createBigtableDataSource(
  table: IBigtableTable,
  target: BigtableTarget,
  options: BigtableDataSourceOptions = {},
): IDataSource {
  const index = buildFieldIndex(target);
  const maxPageFetches = options.maxPageFetches ?? DEFAULT_MAX_PAGE_FETCHES;
  const buffer = options.buffer;

  /**
   * Whether a decoded row satisfies the caller's own constraints.
   *
   * Applied to EVERY row, including ones a push-down already selected: the
   * push-down is only ever a superset, and this is the single authoritative
   * evaluation.
   */
  const matches = (
    row: Record<string, unknown>,
    where: Readonly<Record<string, unknown>>,
    filter: FilterExpression | undefined,
  ): boolean => {
    if (!matchesWhere(row, where)) return false;
    return filter === undefined || matchesFilter(row, filter);
  };

  const readEntities = async (
    read: BigtableReadOptions,
  ): Promise<Record<string, unknown>[]> => {
    const rows = await table.readRows(read);
    return rows.map((row) => decodeRow(target, index, row));
  };

  const readOne = async (rowKey: string): Promise<Record<string, unknown> | null> => {
    const rows = await table.readRows({ keys: [rowKey] });
    return rows.length === 0 ? null : decodeRow(target, index, rows[0]);
  };

  return {
    async findAll(query: NormalizedQuery): Promise<Record<string, unknown>[]> {
      const plan = planBigtableScan(target, query);
      if (plan.empty) return [];
      const entities = (await readEntities(plan.read))
        .filter((row) => matches(row, query.where, query.filter));
      // Rows arrive in row-key order, which IS the only order this adapter
      // serves, so no client-side sort exists to drift from the scan.
      const limited = !plan.serverLimited && query.limit > 0
        ? entities.slice(0, query.limit)
        : entities;
      return limited.map((row) => projectFields(row, query.select) as Record<string, unknown>);
    },

    async findById(id: EntityKey): Promise<Record<string, unknown> | null> {
      return await readOne(composeRowKey(target, id, 'findById'));
    },

    async create(
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
      const rowKey = composeRowKeyFromFields(target, data, 'create');
      const cells = buildCells(target, index, data, 'create');
      const persisted = { ...data } as Record<string, unknown>;
      if (buffer !== undefined) {
        buffer.claim(target.table, rowKey, 'create');
        buffer.insert(cells, true);
        return persisted;
      }
      const existed = await table.row(rowKey).conditionalMutate([{ all: true }], {
        onNoMatch: [{ method: 'insert', data: cells }],
      });
      if (existed) {
        throw new Error(
          `Bigtable entity '${target.entity}' already has a row keyed '${rowKey}'; ` +
            `create() does not overwrite. Use update() to merge into it.`,
        );
      }
      return persisted;
    },

    async update(
      id: EntityKey,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> {
      const rowKey = composeRowKey(target, id, 'update');
      assertKeyUnchanged(target, id, data);
      const cells = buildCells(target, index, data, 'update');
      const hasCells = Object.keys(cells).length > 0;

      if (buffer !== undefined) {
        buffer.claim(target.table, rowKey, 'update');
        // A deferred write still has to REPORT the updated row, and the write
        // lands at commit, so the committed row is read and merged here.
        const committed = await readOne(rowKey);
        if (committed === null) {
          throw new Error(
            `Bigtable entity '${target.entity}' has no row keyed '${rowKey}' to update.`,
          );
        }
        if (hasCells) buffer.insert(cells, false);
        // Only the fields that produced a CELL are merged. An `undefined`
        // payload field writes nothing, so spreading `data` wholesale made the
        // buffered path answer `undefined` where the direct path — which
        // re-reads the row — answers the stored value: two entry points
        // disagreeing about one call.
        return { ...committed, ...writtenFields(data) } as Record<string, unknown>;
      }

      if (!hasCells) {
        const committed = await readOne(rowKey);
        if (committed === null) {
          throw new Error(
            `Bigtable entity '${target.entity}' has no row keyed '${rowKey}' to update.`,
          );
        }
        return committed;
      }
      const existed = await table.row(rowKey).conditionalMutate([{ all: true }], {
        onMatch: [{ method: 'insert', data: cells }],
      });
      if (!existed) {
        throw new Error(
          `Bigtable entity '${target.entity}' has no row keyed '${rowKey}' to update.`,
        );
      }
      const updated = await readOne(rowKey);
      return updated ??
        ({ ...keyFieldsOf(target, id), ...writtenFields(data) } as Record<string, unknown>);
    },

    async delete(id: EntityKey): Promise<boolean> {
      const rowKey = composeRowKey(target, id, 'delete');
      if (buffer !== undefined) {
        buffer.claim(target.table, rowKey, 'delete');
        const committed = await readOne(rowKey);
        buffer.remove();
        return committed !== null;
      }
      return await table.row(rowKey).conditionalMutate([{ all: true }], {
        onMatch: [{ method: 'delete' }],
      });
    },

    async count(
      where: Record<string, unknown>,
      filter?: FilterExpression,
    ): Promise<number> {
      const needsValues = Object.keys(where).length > 0 || filter !== undefined;
      const query: NormalizedQuery = {
        where,
        ...(filter === undefined ? {} : { filter }),
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      };
      // Counting reads only what the predicate needs. On a wide-column store
      // that is the whole cost of the operation: otherwise the server ships
      // every column of every candidate row to answer a number. Safe because
      // the projection interleaves a row-existence arm, so narrowing the
      // columns cannot drop a row.
      const plan = planBigtableScan(target, query, {
        stripValues: !needsValues,
        projectConstraints: needsValues,
      });
      if (plan.empty) return 0;
      if (!needsValues) {
        // Nothing needs a cell value, so the read strips every one of them and
        // the answer is the row count alone.
        return (await table.readRows(plan.read)).length;
      }
      const entities = await readEntities(plan.read);
      return entities.filter((row) => matches(row, where, filter)).length;
    },

    async findPage(query: NormalizedQuery): Promise<PageResult> {
      const fingerprint = sortFingerprint(query.orderBy);
      const after = decodeStartKey(target, query, fingerprint);
      const project = (row: Record<string, unknown>): Record<string, unknown> =>
        projectFields(row, query.select) as Record<string, unknown>;

      if (query.limit <= 0) {
        // The normalized UNLIMITED value means "every matching row", which the
        // memory reference answers with a single terminal page.
        const plan = planBigtableScan(target, query, after === null ? {} : { after });
        const rows = plan.empty
          ? []
          : (await readEntities(plan.read)).filter((row) =>
            matches(row, query.where, query.filter)
          );
        return { rows: rows.map(project), nextCursor: null };
      }

      const matched: Record<string, unknown>[] = [];
      let cursorKey = after;
      // The last row SCANNED, decoded, kept from the loop rather than re-read
      // at the end: a second round trip would also be a race, because a row
      // deleted between the scan and the re-read would leave the bounded page
      // reporting `nextCursor: null` — terminal — while further rows remain.
      let lastRawRow: Record<string, unknown> | null = null;
      let exhausted = false;
      let fetches = 0;
      const batchSize = query.limit + 1;

      while (matched.length <= query.limit && fetches < maxPageFetches) {
        const plan = planBigtableScan(
          target,
          query,
          cursorKey === null ? {} : { after: cursorKey },
        );
        if (plan.empty) {
          exhausted = true;
          break;
        }
        const rows = await table.readRows({ ...plan.read, limit: batchSize });
        fetches += 1;
        if (rows.length === 0) {
          exhausted = true;
          break;
        }
        cursorKey = rows[rows.length - 1].key;
        for (const row of rows) {
          const entity = decodeRow(target, index, row);
          lastRawRow = entity;
          if (matches(entity, query.where, query.filter)) matched.push(entity);
          if (matched.length > query.limit) break;
        }
        // A short answer means the server had nothing more in range; only a
        // FULL batch can leave rows behind.
        if (rows.length < batchSize) {
          exhausted = true;
          break;
        }
      }

      const full = matched.length > query.limit;
      const bounded = !exhausted && !full;
      const pageRows = full ? matched.slice(0, query.limit) : matched;
      const rows = pageRows.map(project);

      if (full) {
        // The page is full, so the continuation is "after the last row of THIS
        // page" — minted exactly as every other row-based backend mints it, so
        // the token is byte-identical across adapters.
        return {
          rows,
          nextCursor: mintNextCursor(pageRows, query.orderBy, target.keyFields, fingerprint, true),
        };
      }
      if (bounded && lastRawRow !== null) {
        // `maxPageFetches` bounded the walk before it could fill the page. The
        // page is NOT terminal, and `nextCursor` must say so even when it
        // carries zero rows — the contract's rule that the cursor is never
        // derived from `rows.length`. It is minted from the last row SCANNED
        // rather than the last row matched, because everything between them
        // failed the filter and re-scanning it would only cost a round trip.
        return {
          rows,
          nextCursor: mintNextCursor(
            [lastRawRow],
            query.orderBy,
            target.keyFields,
            fingerprint,
            true,
          ),
        };
      }
      return { rows, nextCursor: null };
    },
  };
}

/**
 * Decodes an incoming cursor into the exclusive start key it continues after.
 *
 * @param target - The resolved entity target
 * @param query - The page query
 * @param fingerprint - The sort fingerprint the query resolves to
 * @returns The start key, or `null` when the walk starts at the beginning
 * @throws {UnsupportedQueryFeatureError} When the token is malformed or was
 *   minted under a different sort
 */
function decodeStartKey(
  target: BigtableTarget,
  query: NormalizedQuery,
  fingerprint: string,
): string | null {
  if (query.cursor === undefined) return null;
  const decoded = decodeCursor(query.cursor);
  if (decoded === null) {
    throw new UnsupportedQueryFeatureError(
      'cursor-pagination',
      ADAPTER,
      `Bigtable entity '${target.entity}' received a malformed cursor token.`,
    );
  }
  if (decoded.sortFingerprint !== fingerprint) {
    throw new UnsupportedQueryFeatureError(
      'cursor-pagination',
      ADAPTER,
      `Bigtable entity '${target.entity}' received a cursor minted under sort ` +
        `'${decoded.sortFingerprint}' but was asked for '${fingerprint}'.`,
    );
  }
  if (decoded.keyValues.length !== target.keyFields.length) {
    throw new UnsupportedQueryFeatureError(
      'cursor-pagination',
      ADAPTER,
      `Bigtable entity '${target.entity}' received a cursor carrying ` +
        `${decoded.keyValues.length} key values for a ${target.keyFields.length}-field row key.`,
    );
  }
  const fields: Record<string, unknown> = {};
  target.keyFields.forEach((field, position) => {
    fields[field] = decoded.keyValues[position];
  });
  return composeRowKeyFromFields(target, fields, 'findPage');
}
