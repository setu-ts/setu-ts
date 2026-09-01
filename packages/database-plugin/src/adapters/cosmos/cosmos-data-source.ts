/**
 * Data-source factory and transaction handle for the Cosmos adapter.
 *
 * This owns the six `IDataSource` members plus `findPage` over one container,
 * translating each onto the SDK calls with the shapes measured against the
 * real service: a 404 point read RETURNS `{ statusCode: 404, resource:
 * undefined }` while `delete`, `patch` and `replace` on a missing item THROW,
 * a stale `IfMatch` answers 412, and a batch is atomic within one
 * partition-key value.
 *
 * The SDK's structural types live in `cosmos-client-types.ts`; the
 * inject-or-lazy client seam lives in `cosmos-client.ts`; the SQL translation
 * lives in `cosmos-query.ts`.
 *
 * @module
 */
import type {
  CursorPayload,
  EntityKey,
  FilterExpression,
  IAdapterTransaction,
  IDataSource,
  NormalizedQuery,
  PageResult,
} from '@setu-ts/common';
import {
  decodeCursor,
  keysetPredicate,
  mintNextCursor,
  resolveKeysetSort,
  sortFingerprint,
} from '@setu-ts/common';
import type {
  CosmosItemResponse,
  CosmosPartitionKeyValue,
  CosmosPatchOperation,
  ICosmosContainer,
  ICosmosDatabase,
} from './cosmos-client-types.ts';
import type { CosmosTarget } from './cosmos-mapping.ts';
import { ETAG_PROPERTY, fromDocument, readPath, toDocument } from './cosmos-mapping.ts';
import type { PartitionKeyResolver, ResolvedPartitionKey } from './cosmos-partition-key.ts';
import { renderPaths } from './cosmos-partition-key.ts';
import { buildCountQuery, buildIdLookupQuery, buildQuery } from './cosmos-query.ts';
import { BatchBuffer } from './cosmos-transaction.ts';
import { CosmosConcurrentModificationError, UnsupportedQueryFeatureError } from '../../errors.ts';
import {
  normalizePageQuery,
  PageNormalizationError,
  projectFields,
} from '../../query/query-builder.ts';

/**
 * The largest number of operations one `patch` request accepts.
 *
 * Exported for tests only — it is NOT part of the package's public surface, so
 * `src/index.ts` does not re-export it.
 *
 * A payload wider than this is served by a read-merge-replace instead. The
 * emulator accepted more, so this is the conservative side of a limit that
 * cannot be measured locally — refusing a legitimate update would be worse
 * than one extra round trip.
 */
export const MAX_PATCH_OPERATIONS = 10;

/** The identity field every Cosmos document carries. */
const DOCUMENT_ID_FIELD = 'id';

/**
 * Everything one data source is bound to.
 *
 * @internal
 */
export interface CosmosDataSourceContext {
  /** The database the container lives in. */
  readonly database: ICosmosDatabase;
  /** The resolved entity target. */
  readonly target: CosmosTarget;
  /** The shared per-container partition-key resolver. */
  readonly partitionKeys: PartitionKeyResolver;
  /**
   * The transaction write buffer, when this data source is transaction-scoped.
   * Absent, every write is applied immediately.
   */
  readonly buffer?: BatchBuffer;
}

/**
 * A partition-key value read out of a row, beside the paths that were absent.
 *
 * @internal
 */
interface ReadPartitionKey {
  /** The value, scalar for a single path and an array for a hierarchical key. */
  readonly value: CosmosPartitionKeyValue;
  /** The partition-key paths the row did not carry. */
  readonly missing: readonly (readonly string[])[];
}

/**
 * The address of one document: its `id` and the partition-key value that
 * routes the request, plus the document itself when resolving the address
 * already had to read it.
 *
 * @internal
 */
interface DocumentAddress {
  /** The document id. */
  readonly id: string;
  /** The partition-key value. */
  readonly partitionKey: CosmosPartitionKeyValue;
  /** The document, when the address was resolved by finding it. */
  readonly document?: Record<string, unknown>;
}

/**
 * Creates a data source bound to one entity's container.
 *
 * @param context - The database, target, resolver, and optional write buffer
 * @returns The data source serving that entity
 * @since 0.2.0
 */
export function createCosmosDataSource(context: CosmosDataSourceContext): IDataSource {
  const { database, target, partitionKeys, buffer } = context;
  const container = (): ICosmosContainer => database.container(target.container);

  /**
   * Refuses a primary-key value Cosmos cannot store.
   *
   * @param value - The candidate id
   * @param operation - The calling member, for the message
   * @returns The id as a string
   * @throws {Error} When the value is not a string
   */
  const requireStringId = (value: unknown, operation: string): string => {
    if (typeof value !== 'string') {
      throw new Error(
        `CosmosAdapter.${operation}: a Cosmos document id must be a string, but ` +
          `'${String(value)}' is a ${typeof value}. The service refuses a non-string id ` +
          "('Id must be a string.'), and converting it silently would return a key of a " +
          'different type than the caller supplied.',
      );
    }
    return value;
  };

  /**
   * Reads the partition-key value for a document out of a row.
   *
   * @param row - The row (or composite key record) to read from
   * @param resolved - The container's partition key
   * @returns The value, scalar for a single path and an array for a hierarchical key
   */
  const partitionKeyOf = (
    row: Record<string, unknown>,
    resolved: ResolvedPartitionKey,
  ): ReadPartitionKey => {
    const missing: (readonly string[])[] = [];
    const values = resolved.paths.map((path) => {
      // A composite EntityKey record is flat, so a nested partition-key path is
      // addressed by its dotted join ('address.city'); a row is nested, so the
      // segment walk finds it. Both spellings are tried, in that order.
      const flat = row[path.join('.')];
      const value = flat === undefined ? readPath(row, path) : flat;
      // `undefined` is ABSENT; `null` is a partition-key value Cosmos stores,
      // so the two are told apart rather than collapsed.
      if (value === undefined) missing.push(path);
      return value as string | number | boolean | null;
    });
    return {
      value: values.length === 1 ? (values[0] as CosmosPartitionKeyValue) : values,
      missing,
    };
  };

  /**
   * Reads the partition key and refuses a value with any segment absent.
   *
   * A hierarchical key reads as an ARRAY, so a missing segment leaves a hole
   * inside it rather than making the whole value `undefined` — which the
   * service then answers with a 404, reporting "no such row" for a row that
   * exists. The single-path and hierarchical arms therefore share one refusal.
   *
   * @param row - The row or composite key record to read from
   * @param resolved - The container's partition key
   * @param operation - The calling member, for the message
   * @param subject - What the value was read from, for the message
   * @returns The partition-key value
   * @throws {Error} When any partition-key path is absent
   */
  const requirePartitionKey = (
    row: Record<string, unknown>,
    resolved: ResolvedPartitionKey,
    operation: string,
    subject: string,
  ): CosmosPartitionKeyValue => {
    const read = partitionKeyOf(row, resolved);
    if (read.missing.length > 0) {
      throw new Error(
        `CosmosAdapter.${operation}: ${subject} for '${target.container}' must carry the ` +
          `partition key ${renderPaths(resolved.paths)}, but ${
            renderPaths(read.missing)
          } is absent. A Cosmos request carrying an incomplete partition key answers 404 rather ` +
          'than an error, so it would report "not found" for a row that exists.',
      );
    }
    return read.value;
  };

  /**
   * Resolves the address of one document from an {@linkcode EntityKey}.
   *
   * Three cases, measured rather than assumed. A composite record carrying the
   * partition key addresses the document directly. A scalar key whose
   * container partitions BY the primary-key field addresses it directly too.
   * Otherwise the partition key is unknown, so the document is found by a
   * cross-partition query — which is legitimate but can match two different
   * documents, because an `id` is unique only within a partition, and that
   * genuine ambiguity is refused rather than resolved by picking one.
   *
   * @param id - The key the caller supplied
   * @param operation - The calling member, for messages
   * @returns The resolved address, or `null` when no document has that key
   */
  const addressOf = async (
    id: EntityKey,
    operation: string,
  ): Promise<DocumentAddress | null> => {
    const resolved = await partitionKeys.resolve(target);
    if (typeof id === 'object') {
      const record = id as Record<string, string | number>;
      const keyValue = record[target.primaryKey];
      if (keyValue === undefined) {
        throw new Error(
          `CosmosAdapter.${operation}: the composite key for '${target.container}' must carry ` +
            `'${target.primaryKey}', but it carries ${JSON.stringify(Object.keys(record))}`,
        );
      }
      const partitionKey = requirePartitionKey(
        record,
        resolved,
        operation,
        'the composite key',
      );
      return { id: requireStringId(keyValue, operation), partitionKey };
    }

    const scalar = requireStringId(id, operation);
    if (partitionsByPrimaryKey(resolved, target)) {
      return { id: scalar, partitionKey: scalar };
    }

    // The partition key is a different field, so it has to be found. Two rows
    // are fetched: one is the answer, two is a genuine ambiguity.
    const spec = buildIdLookupQuery(scalar, target);
    const found = await container().items.query(spec).fetchAll();
    if (found.resources.length === 0) return null;
    if (found.resources.length > 1) {
      throw new Error(
        `CosmosAdapter.${operation}: '${scalar}' matches more than one document in ` +
          `'${target.container}'. A Cosmos id is unique only within a partition, so pass the ` +
          `partition key alongside it: a composite key carrying '${target.primaryKey}' and ` +
          `${renderPaths(resolved.paths)}.`,
      );
    }
    const document = found.resources[0] as Record<string, unknown>;
    return {
      id: scalar,
      partitionKey: requirePartitionKey(document, resolved, operation, 'the stored document'),
      document,
    };
  };

  /**
   * Runs a query and maps every row out of the driver's document shape.
   *
   * @param query - The normalized query
   * @returns The mapped rows
   */
  const runQuery = async (query: NormalizedQuery): Promise<Record<string, unknown>[]> => {
    const spec = buildQuery(query, target);
    const response = await container().items.query(spec).fetchAll();
    return response.resources.map((row) => fromDocument(row, target));
  };

  /**
   * Reads one document by address, answering `null` for a 404.
   *
   * @param address - The resolved address
   * @returns The raw document, or `null`
   */
  const readDocument = async (
    address: DocumentAddress,
  ): Promise<Record<string, unknown> | null> => {
    if (address.document !== undefined) return address.document;
    const response = await container().item(address.id, address.partitionKey).read();
    return response.resource ?? null;
  };

  return {
    findAll: (query: NormalizedQuery): Promise<Record<string, unknown>[]> => runQuery(query),

    findById: async (id: EntityKey): Promise<Record<string, unknown> | null> => {
      const address = await addressOf(id, 'findById');
      if (address === null) return null;
      const document = await readDocument(address);
      return document === null ? null : fromDocument(document, target);
    },

    create: async (data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> => {
      const document = toDocument(data as Record<string, unknown>, target);
      if (document[DOCUMENT_ID_FIELD] !== undefined) {
        requireStringId(document[DOCUMENT_ID_FIELD], 'create');
      }
      if (buffer !== undefined) {
        // Deferred write (the D1 shape): the row returned describes what WILL
        // be written. An id the caller did not supply cannot be reported here,
        // because the SDK mints it when the operation is actually sent.
        const resolved = await partitionKeys.resolve(target);
        buffer.add({
          container: target.container,
          // A batch is addressed by ONE partition-key value, so an incomplete
          // one here would send the whole batch to the wrong place.
          partitionKey: requirePartitionKey(document, resolved, 'create', 'the row'),
          operation: { operationType: 'Create', resourceBody: document },
        });
        return fromDocument(document, target);
      }
      const created = await container().items.create(document);
      return fromDocument(created.resource ?? document, target);
    },

    update: async (
      id: EntityKey,
      data: Partial<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      const address = await addressOf(id, 'update');
      if (address === null) throw missingRow(target, id);
      const resolved = await partitionKeys.resolve(target);

      // The primary key never travels in an update payload: `id` already
      // addresses the row and no adapter moves a row to a new key. A
      // partition-key field is different — a `replace` that changes one
      // answers 404 rather than moving the item, so a genuine change is
      // refused by name while a restatement of the current value is dropped.
      const payload = { ...data } as Record<string, unknown>;
      delete payload[target.primaryKey];
      delete payload[DOCUMENT_ID_FIELD];
      for (const [index, path] of resolved.paths.entries()) {
        const head = path[0] as string;
        if (!Object.prototype.hasOwnProperty.call(payload, head)) continue;
        const supplied = readPath(payload, path);
        const current = Array.isArray(address.partitionKey)
          ? address.partitionKey[index]
          : address.partitionKey;
        if (supplied !== current) {
          throw new Error(
            `CosmosAdapter.update: the payload would change the partition key ` +
              `${renderPaths([path])} of '${address.id}' in '${target.container}'. Cosmos cannot ` +
              'move an item between partitions — delete it and create it under the new key.',
          );
        }
        // A single-segment path IS the partition-key field, so restating it is
        // dropped. A nested one is left in place: its parent object carries
        // other fields the caller may legitimately be updating, and setting the
        // same partition-key value inside it changes nothing.
        if (path.length === 1) delete payload[head];
      }

      if (buffer !== undefined) {
        // The row is read to honour the contract's missing-row throw, NOT to
        // build the write: a `Replace` assembled from a committed read would
        // discard both a concurrent writer's other fields and any earlier
        // buffered update of the same row (measured — two such replaces answer
        // 200 and the first one's change is gone). A `Patch` writes only the
        // fields the payload names and two of them COMPOSE, which is why this
        // is the same operation the non-transactional path already uses.
        const existing = await readDocument(address);
        if (existing === null) throw missingRow(target, id);
        const merged = { ...existing, ...payload };
        const fields = Object.entries(payload);
        if (fields.length === 0) return fromDocument(existing, target);
        if (fields.length <= MAX_PATCH_OPERATIONS) {
          buffer.add({
            container: target.container,
            partitionKey: address.partitionKey,
            operation: {
              operationType: 'Patch',
              id: address.id,
              resourceBody: { operations: patchOperations(fields) },
            },
          });
        } else {
          // Wider than one patch accepts, so the whole document is written.
          // That cannot compose, which is why `BatchBuffer` refuses this write
          // when the transaction has already written the same row.
          buffer.add({
            container: target.container,
            partitionKey: address.partitionKey,
            operation: { operationType: 'Replace', id: address.id, resourceBody: merged },
          });
        }
        return fromDocument(merged, target);
      }

      const item = container().item(address.id, address.partitionKey);
      const fields = Object.entries(payload);
      if (fields.length === 0) {
        // Nothing left to write. Read the row rather than sending an empty
        // patch, which is a write that changes nothing.
        const existing = await readDocument(address);
        if (existing === null) throw missingRow(target, id);
        return fromDocument(existing, target);
      }
      if (fields.length <= MAX_PATCH_OPERATIONS) {
        const patched = await mapMissing(item.patch(patchOperations(fields)), target, id);
        return fromDocument(patched.resource ?? {}, target);
      }

      // Wider than one patch request accepts: read, merge, and replace
      // conditionally on the `_etag` the read returned, so a concurrent writer
      // is reported rather than silently overwritten.
      const existing = await readDocument(address);
      if (existing === null) throw missingRow(target, id);
      const etag = existing[ETAG_PROPERTY];
      const merged = { ...existing, ...payload };
      const replaced = await item.replace(
        merged,
        typeof etag === 'string' ? { accessCondition: { type: 'IfMatch', condition: etag } } : {},
      ).catch((error: unknown) => {
        if (statusOf(error) === 412) {
          throw new CosmosConcurrentModificationError(
            `CosmosAdapter.update: '${address.id}' in '${target.container}' was modified by ` +
              'another writer between the read and the write of a payload too wide for a single ' +
              'patch request. Retry the update.',
          );
        }
        if (statusOf(error) === 404) throw missingRow(target, id);
        throw error;
      });
      return fromDocument(replaced.resource ?? merged, target);
    },

    delete: async (id: EntityKey): Promise<boolean> => {
      const address = await addressOf(id, 'delete');
      if (address === null) return false;
      if (buffer !== undefined) {
        // A deferred delete reports whether a COMMITTED row matched, and the
        // delete itself lands at commit — the contract's deferred-write clause.
        const existing = await readDocument(address);
        if (existing === null) return false;
        buffer.add({
          container: target.container,
          partitionKey: address.partitionKey,
          operation: { operationType: 'Delete', id: address.id },
        });
        return true;
      }
      try {
        await container().item(address.id, address.partitionKey).delete();
        return true;
      } catch (error) {
        // A missing document is a 404 THROW here, unlike the point read, which
        // returns. The contract answers `false` rather than propagating.
        if (statusOf(error) === 404) return false;
        throw error;
      }
    },

    count: async (
      where: Record<string, unknown>,
      filter?: FilterExpression,
    ): Promise<number> => {
      const spec = buildCountQuery(where, filter, target);
      const response = await container().items.query(spec).fetchAll();
      const first = response.resources[0];
      return typeof first === 'number' ? first : 0;
    },

    findPage: async (query: NormalizedQuery): Promise<PageResult> => {
      // The portable keyset pipeline every adapter shares. Cosmos returns no
      // continuation token for a query carrying ORDER BY (measured), and a page
      // without a stable sort is not a page — so the portable cursor is not a
      // fallback here, it is the only mechanism the service supports.
      const normalized = normalizePageQuery(query);
      if (normalized instanceof PageNormalizationError) return Promise.reject(normalized);

      let decoded: CursorPayload | null = null;
      if (normalized.cursor !== undefined) {
        decoded = decodeCursor(normalized.cursor);
        if (decoded === null) {
          return Promise.reject(
            new UnsupportedQueryFeatureError(
              'cursor-pagination',
              'cosmos',
              `cursor-pagination: entity '${target.container}': malformed cursor token`,
            ),
          );
        }
      }

      const fingerprint = sortFingerprint(normalized.orderBy);
      if (decoded !== null && decoded.sortFingerprint !== fingerprint) {
        return Promise.reject(
          new UnsupportedQueryFeatureError(
            'cursor-pagination',
            'cosmos',
            `cursor-pagination: entity '${target.container}': cursor fingerprint mismatch — ` +
              `expected '${fingerprint}', got '${decoded.sortFingerprint}'`,
          ),
        );
      }

      const keyColumns = [target.primaryKey];
      const keysetSort = resolveKeysetSort(normalized.orderBy, keyColumns);
      const keyset = decoded === null ? undefined : keysetPredicate(
        decoded.orderedValues,
        decoded.keyValues,
        normalized.orderBy,
        keyColumns,
      );
      const filter = conjoinFilters(normalized.filter, keyset);
      // The projection is widened to the key and ordered columns so the probe
      // can mint a cursor, then narrowed back to what the caller asked for.
      const internalSelect = normalized.select.length > 0
        ? [...new Set([...normalized.select, ...keyColumns, ...Object.keys(normalized.orderBy)])]
        : [];
      const rows = await runQuery({
        ...normalized,
        orderBy: keysetSort,
        limit: normalized.limit > 0 ? normalized.limit + 1 : normalized.limit,
        select: internalSelect,
        ...(filter === undefined ? {} : { filter }),
      });

      const hasMore = normalized.limit > 0 && rows.length > normalized.limit;
      const pageRows = hasMore ? rows.slice(0, normalized.limit) : rows;
      const nextCursor = mintNextCursor(
        pageRows,
        normalized.orderBy,
        keyColumns,
        fingerprint,
        hasMore,
      );
      return {
        rows: internalSelect.length > 0
          ? pageRows.map((row) => projectFields(row, normalized.select) as Record<string, unknown>)
          : pageRows,
        nextCursor,
      };
    },
  };
}

/**
 * Translates a payload's field list into `set` patch operations.
 *
 * One owner for both the immediate patch and the buffered one, so the two
 * cannot drift about how a field name becomes a patch path.
 *
 * @param fields - The payload entries to write
 * @returns The patch operations, in payload order
 * @since 0.2.0
 */
export function patchOperations(
  fields: readonly (readonly [string, unknown])[],
): CosmosPatchOperation[] {
  return fields.map(([field, value]) => ({ op: 'set', path: `/${field}`, value }));
}

/**
 * Whether a container partitions by the very field that carries the primary
 * key, which is what makes a scalar key sufficient for a point read.
 *
 * @param resolved - The container's partition key
 * @param target - The resolved entity target
 * @returns `true` when the single partition-key path is the primary-key field
 * @since 0.2.0
 */
export function partitionsByPrimaryKey(
  resolved: ResolvedPartitionKey,
  target: CosmosTarget,
): boolean {
  if (resolved.paths.length !== 1) return false;
  const path = resolved.paths[0] as readonly string[];
  if (path.length !== 1) return false;
  return path[0] === target.primaryKey || path[0] === DOCUMENT_ID_FIELD;
}

/**
 * Conjoin two optional portable filters, preferring the single expression when
 * only one is present — an `and` node with one child would be a shape the
 * caller never wrote.
 *
 * @param base - The caller's own filter, or `undefined`
 * @param extra - The keyset predicate, or `undefined` on the first page
 * @returns The conjoined expression, or `undefined` when neither is present
 * @since 0.2.0
 */
export function conjoinFilters(
  base: FilterExpression | undefined,
  extra: FilterExpression | undefined,
): FilterExpression | undefined {
  if (base === undefined) return extra;
  if (extra === undefined) return base;
  return { type: 'and', filters: [base, extra] };
}

/**
 * The HTTP status an SDK error carries, when it carries one.
 *
 * @param error - The thrown value
 * @returns The status code, or `undefined`
 * @since 0.2.0
 */
export function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * The error `update` throws when no row carries the key.
 *
 * @param target - The resolved entity target
 * @param id - The key that matched nothing
 * @returns The error to throw
 * @since 0.2.0
 */
export function missingRow(target: CosmosTarget, id: EntityKey): Error {
  return new Error(
    `CosmosAdapter: no ${target.container} row with ${target.primaryKey} ${JSON.stringify(id)}`,
  );
}

/**
 * Translates a 404 from a write into the contract's missing-row error.
 *
 * @param pending - The in-flight SDK call
 * @param target - The resolved entity target
 * @param id - The key being written
 * @returns The response, when the write succeeded
 * @since 0.2.0
 */
export async function mapMissing(
  pending: Promise<CosmosItemResponse<Record<string, unknown>>>,
  target: CosmosTarget,
  id: EntityKey,
): Promise<CosmosItemResponse<Record<string, unknown>>> {
  try {
    return await pending;
  } catch (error) {
    if (statusOf(error) === 404) throw missingRow(target, id);
    throw error;
  }
}

/**
 * The transaction handle: a deferred-write Unit of Work whose buffer is
 * flushed as ONE transactional batch at commit.
 *
 * @since 0.2.0
 */
export class CosmosTransaction implements IAdapterTransaction {
  readonly #database: ICosmosDatabase;
  readonly #partitionKeys: PartitionKeyResolver;
  readonly #resolveTarget: (entity: string) => CosmosTarget;
  readonly #buffer = new BatchBuffer();
  #settled = false;

  /**
   * Creates the handle.
   *
   * @param database - The database every scoped data source targets
   * @param partitionKeys - The shared per-container partition-key resolver
   * @param resolveTarget - Resolves an entity name to its target
   */
  constructor(
    database: ICosmosDatabase,
    partitionKeys: PartitionKeyResolver,
    resolveTarget: (entity: string) => CosmosTarget,
  ) {
    this.#database = database;
    this.#partitionKeys = partitionKeys;
    this.#resolveTarget = resolveTarget;
  }

  /**
   * Opens a data source whose writes join this transaction's batch.
   *
   * @param entity - The entity name
   * @returns A data source that buffers its writes
   */
  createDataSource(entity: string): IDataSource {
    return createCosmosDataSource({
      database: this.#database,
      target: this.#resolveTarget(entity),
      partitionKeys: this.#partitionKeys,
      buffer: this.#buffer,
    });
  }

  /**
   * Flushes every buffered write as one transactional batch.
   *
   * An empty transaction sends nothing rather than an empty batch, and a batch
   * that reports a non-2xx overall code is surfaced with the per-operation
   * status codes, because that is what names the operation that failed.
   *
   * @throws {Error} When the batch reports a failure
   */
  async commit(): Promise<void> {
    this.#settle('commit');
    if (this.#buffer.isEmpty()) return;
    const containerName = this.#buffer.container() as string;
    const partitionKey = this.#buffer.partitionKey() as CosmosPartitionKeyValue;
    const operations = this.#buffer.operations();
    const response = await this.#database.container(containerName).items.batch(
      operations,
      partitionKey,
    );
    // Success is exactly 200. A batch whose operations did not all apply answers
    // **207** with per-operation statuses (measured: 424 for the operations the
    // failure aborted, and the real fault's own status beside them), so a
    // `>= 300` threshold would report a rolled-back batch as committed.
    const code = response.code ?? 200;
    if (code !== 200) {
      const statuses = (response.result ?? []).map((entry) => entry.statusCode).join(', ');
      throw new Error(
        `CosmosAdapter: the transactional batch on '${containerName}' failed with status ${code} ` +
          `(per-operation: ${statuses}). The batch is atomic, so no operation was applied.`,
      );
    }
  }

  /**
   * Discards every buffered write. Nothing was ever sent, so nothing is
   * undone.
   */
  rollback(): Promise<void> {
    // Idempotent, unlike `commit`, and that asymmetry is load-bearing rather
    // than lenient: `DatabaseService.transaction()` rolls back inside a `catch`
    // that also runs when `commit()` itself failed, and `commit()` marks the
    // handle settled BEFORE it awaits the batch. A refusal here would therefore
    // replace the batch's own diagnostic — its status and per-operation codes,
    // the only thing naming the operation that failed — with a message about
    // rollback, on every throttled or rejected batch. `D1Adapter` records the
    // same reasoning for the same call pattern, and `MongoAdapter` returns
    // early on `#finalized`.
    this.#settled = true;
    this.#buffer.clear();
    return Promise.resolve();
  }

  /**
   * Refuses a second settlement of the same handle.
   *
   * Called from `commit`, which is `async`, so this throw becomes a rejection.
   * `rollback` deliberately does NOT call it — see the note there.
   *
   * @param operation - The member being called
   * @throws {Error} When the transaction has already settled
   */
  #settle(operation: string): void {
    if (this.#settled) {
      throw new Error(
        `CosmosAdapter: this transaction has already settled; ${operation} is a no-op`,
      );
    }
    this.#settled = true;
  }
}
