/** DynamoDB implementation of the per-entity IDataSource port. @module */
import type { EntityKey, IDataSource, NormalizedQuery, PageResult } from '@setu-ts/common';
import { decodeCursor, encodeCursor, sortFingerprint } from '@setu-ts/common';
import type {
  DynamoAttributeMap,
  DynamoAttributeValue,
  DynamoReadCommandOutput,
  DynamoTransactWriteItem,
  IDynamoClient,
} from './dynamo-client-types.ts';
import { resolveDynamoAccessPath } from './dynamo-access-path.ts';
import type { DynamoEntityMapping } from './dynamo-mapping.ts';
import { resolveDynamoTarget } from './dynamo-mapping.ts';
import { marshalDynamoItem, marshalDynamoValue, unmarshalDynamoItem } from './dynamo-marshal.ts';
import { createDynamoExpressionBuilder } from './dynamo-expression.ts';
import type { IDynamoTransactionBuffer } from './dynamo-transaction-buffer.ts';
import { UnsupportedQueryFeatureError } from '../../errors.ts';
import { projectFields } from '../../query/query-builder.ts';

const ADAPTER = 'dynamodb';
const DEFAULT_MAX_PAGE_FETCHES = 10;

/**
 * The Dynamo-specific read-path reporting capability consumed by the service
 * logging wrapper.
 *
 * It stays outside {@linkcode IDataSource}: a resolved DynamoDB access path is
 * diagnostic metadata, not portable data-source behaviour. Other adapters
 * therefore retain their existing log entry shape.
 *
 * @internal
 */
export interface IDynamoAccessPathReportingDataSource extends IDataSource {
  /** Returns the label selected by the most recent Query, Scan, or GSI read. */
  readonly getLastAccessPath: () => string | undefined;
}

/**
 * Encodes ONE continuation-key attribute for the portable cursor codec.
 *
 * A `LastEvaluatedKey` carries native `AttributeValue`s, but
 * {@linkcode CursorPayload} holds `string | number | Date`, so the key's TYPE
 * is lost if the value is passed through unmarshalled. Two measured failures
 * follow from that: a numeric key whose decimal does not round-trip through
 * `Number` unmarshals to a string (the §3.15 lossy-`N` rule) and would be
 * rebuilt as `S`, which DynamoDB rejects with `Type mismatch for attribute to
 * update`; and a binary (`B`) key unmarshals to a `Uint8Array`, which the
 * cursor's JSON codec cannot represent at all, so the token it minted decoded
 * as malformed and the walk could never continue.
 *
 * The attribute is therefore encoded as `<type>:<payload>` — its own type tag
 * plus a lossless payload (`B` as base64) — and rebuilt verbatim by
 * {@linkcode decodeKeyAttribute}. The cursor stays an opaque string, so no
 * `common` contract changes.
 *
 * @param value - One attribute of the server's `LastEvaluatedKey`
 * @returns The tagged, lossless string form
 * @throws {UnsupportedQueryFeatureError} When the key attribute is not `S`,
 *   `N` or `B` — the only types DynamoDB allows in a key
 */
function encodeKeyAttribute(value: DynamoAttributeValue, entity: string): string {
  if (value.S !== undefined) return `S:${value.S}`;
  if (value.N !== undefined) return `N:${value.N}`;
  if (value.B !== undefined) {
    let binary = '';
    for (const byte of value.B) binary += String.fromCharCode(byte);
    return `B:${btoa(binary)}`;
  }
  throw new UnsupportedQueryFeatureError(
    'cursor-pagination',
    ADAPTER,
    `DynamoDB entity '${entity}' returned a continuation key attribute that is not S, N or B.`,
  );
}

/**
 * Rebuilds one continuation-key attribute encoded by
 * {@linkcode encodeKeyAttribute}, restoring its native type.
 *
 * @param encoded - The tagged string from the decoded cursor
 * @returns The native attribute value, or `null` when the token is malformed
 */
function decodeKeyAttribute(encoded: unknown): DynamoAttributeValue | null {
  if (typeof encoded !== 'string' || encoded.length < 2) return null;
  const payload = encoded.slice(2);
  switch (encoded.slice(0, 2)) {
    case 'S:':
      return { S: payload };
    case 'N:':
      return { N: payload };
    case 'B:': {
      try {
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return { B: bytes };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/** Creates a DynamoDB data source bound to one mapped entity. @internal */
export function createDynamoDataSource(
  client: IDynamoClient,
  entity: string,
  mappings: Readonly<Record<string, DynamoEntityMapping>> | undefined,
  maxPageFetches = DEFAULT_MAX_PAGE_FETCHES,
  transactionBuffer?: IDynamoTransactionBuffer,
): IDynamoAccessPathReportingDataSource {
  const target = resolveDynamoTarget(entity, mappings);
  let lastAccessPath: string | undefined;
  const key = (
    id: EntityKey | Partial<Record<string, unknown>>,
    operation: string,
  ): DynamoAttributeMap => {
    const columns = target.keyColumns;
    if ((typeof id === 'string' || typeof id === 'number') && columns.length !== 1) {
      throw new UnsupportedQueryFeatureError(
        'composite-key',
        ADAPTER,
        `DynamoDB entity '${entity}' ${operation} requires key columns '${columns.join("', '")}'.`,
      );
    }
    const values = typeof id === 'string' || typeof id === 'number'
      ? { [columns[0] ?? 'id']: id }
      : id;
    const result: Record<string, ReturnType<typeof marshalDynamoValue>> = {};
    for (const column of columns) {
      const value = values[column];
      if (value === undefined || value === '') {
        throw new UnsupportedQueryFeatureError(
          'key',
          ADAPTER,
          `DynamoDB entity '${entity}' ${operation} requires non-empty key '${column}'.`,
        );
      }
      result[column] = marshalDynamoValue(value, target.dateAttributes[column]);
    }
    return result;
  };
  const read = async (
    query: NormalizedQuery,
    start?: DynamoAttributeMap,
    limit?: number,
    countOnly = false,
  ): Promise<DynamoReadCommandOutput> => {
    const path = resolveDynamoAccessPath(entity, target, query);
    lastAccessPath = path.logPath;
    const input = {
      ...path.command,
      ...(limit === undefined ? {} : { Limit: limit }),
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      ...(countOnly ? { Select: 'COUNT' as const } : {}),
    };
    return path.commandType === 'Query'
      ? await client.query(input as import('./dynamo-client-types.ts').DynamoQueryCommandInput)
      : await client.scan(input);
  };
  const conditional = (error: unknown, operation: 'create' | 'update'): never => {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new Error(
        `DynamoDB entity '${entity}' ${operation} failed: the key already ${
          operation === 'create' ? 'exists' : 'does not exist'
        }.`,
      );
    }
    throw error;
  };
  return {
    getLastAccessPath: (): string | undefined => lastAccessPath,
    async findAll(query): Promise<Record<string, unknown>[]> {
      if (query.offset !== 0) {
        throw new UnsupportedQueryFeatureError(
          'offset',
          ADAPTER,
          `DynamoDB entity '${entity}' cannot honour offset.`,
        );
      }
      const rows: Record<string, unknown>[] = [];
      let start: DynamoAttributeMap | undefined;
      do {
        const output = await read(query, start);
        rows.push(...(output.Items ?? []).map(unmarshalDynamoItem));
        start = output.LastEvaluatedKey;
      } while (start !== undefined && (query.limit < 0 || rows.length < query.limit));
      const limited = query.limit > 0 ? rows.slice(0, query.limit) : rows;
      return limited.map((row) => projectFields(row, query.select) as Record<string, unknown>);
    },
    async findById(id): Promise<Record<string, unknown> | null> {
      const output = await client.getItem({ TableName: target.table, Key: key(id, 'findById') });
      return output.Item === undefined ? null : unmarshalDynamoItem(output.Item);
    },
    async create(data): Promise<Record<string, unknown>> {
      const item = marshalDynamoItem(data as Record<string, unknown>, target.dateAttributes);
      const identifier = key(data, 'create');
      const builder = createDynamoExpressionBuilder();
      const alias = builder.aliasPath(target.partitionKey);
      const put = {
        TableName: target.table,
        Item: item,
        ConditionExpression: `attribute_not_exists(${alias})`,
        ...builder.expressionAttributes(),
      };
      const write: DynamoTransactWriteItem = {
        Put: put,
      };
      if (transactionBuffer !== undefined) {
        transactionBuffer.add(write, identifier);
        return unmarshalDynamoItem(item);
      }
      try {
        await client.putItem(put);
        return unmarshalDynamoItem(item);
      } catch (error) {
        return conditional(error, 'create');
      }
    },
    async update(id, data): Promise<Record<string, unknown>> {
      const identifier = key(id, 'update');
      const entries = Object.entries(data).filter(([name, value]) =>
        value !== undefined && !target.keyColumns.includes(name)
      );
      if (entries.length === 0) {
        throw new UnsupportedQueryFeatureError(
          'update',
          ADAPTER,
          `DynamoDB entity '${entity}' update requires at least one non-key value.`,
        );
      }
      const builder = createDynamoExpressionBuilder();
      const updates = entries.map(([name, value]) =>
        `${builder.aliasPath(name)} = ${builder.addValue(value, target.dateAttributes[name])}`
      );
      const exists = builder.aliasPath(target.partitionKey);
      const update = {
        TableName: target.table,
        Key: identifier,
        UpdateExpression: `SET ${updates.join(', ')}`,
        ConditionExpression: `attribute_exists(${exists})`,
        ...builder.expressionAttributes(),
      };
      const write: DynamoTransactWriteItem = {
        Update: update,
      };
      if (transactionBuffer !== undefined) {
        const existing = await client.getItem({ TableName: target.table, Key: identifier });
        if (existing.Item === undefined) {
          throw new Error(`DynamoDB entity '${entity}' update failed: the key does not exist.`);
        }
        transactionBuffer.add(write, identifier);
        // Round-trip the merged values through marshalling so the row this
        // returns is the row that will be COMMITTED. Spreading the caller's
        // raw `entries` returned a mapped `Date` as a `Date`, while the
        // non-transactional path returns the encoded persisted form (an ISO
        // string or epoch number) — the same call answering differently
        // depending on whether a transaction was open.
        const merged = Object.fromEntries(entries) as Record<string, unknown>;
        return {
          ...unmarshalDynamoItem(existing.Item),
          ...unmarshalDynamoItem(marshalDynamoItem(merged, target.dateAttributes)),
        };
      }
      try {
        const output = await client.updateItem({
          ...update,
          ReturnValues: 'ALL_NEW',
        });
        if (output.Attributes === undefined) {
          throw new Error(`DynamoDB entity '${entity}' update returned no row.`);
        }
        return unmarshalDynamoItem(output.Attributes);
      } catch (error) {
        return conditional(error, 'update');
      }
    },
    async delete(id): Promise<boolean> {
      const identifier = key(id, 'delete');
      if (transactionBuffer !== undefined) {
        const existing = await client.getItem({ TableName: target.table, Key: identifier });
        if (existing.Item === undefined) return false;
        transactionBuffer.add({
          Delete: { TableName: target.table, Key: identifier },
        }, identifier);
        return true;
      }
      const output = await client.deleteItem({
        TableName: target.table,
        Key: identifier,
        ReturnValues: 'ALL_OLD',
      });
      return output.Attributes !== undefined;
    },
    async count(where, filter): Promise<number> {
      const query: NormalizedQuery = {
        where,
        ...(filter === undefined ? {} : { filter }),
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      };
      let total = 0;
      let start: DynamoAttributeMap | undefined;
      do {
        // `Select: 'COUNT'` so the server returns the tally without the item
        // payloads; `Count` already reflects the FilterExpression, and the
        // loop below still drains every page because a COUNT response is
        // paginated exactly like an item response.
        const output = await read(query, start, undefined, true);
        total += output.Count ?? 0;
        start = output.LastEvaluatedKey;
      } while (start !== undefined);
      return total;
    },
    async findPage(query): Promise<PageResult> {
      if (query.offset !== 0) {
        throw new UnsupportedQueryFeatureError(
          'offset',
          ADAPTER,
          `DynamoDB entity '${entity}' cannot honour offset.`,
        );
      }
      const path = resolveDynamoAccessPath(entity, target, query);
      const fingerprint = sortFingerprint(query.orderBy);
      let start: DynamoAttributeMap | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor);
        if (
          decoded === null || decoded.sortFingerprint !== fingerprint ||
          decoded.keyValues.length !== path.cursorKeyColumns.length
        ) {
          throw new UnsupportedQueryFeatureError(
            'cursor-pagination',
            ADAPTER,
            `DynamoDB entity '${entity}' received a malformed cursor.`,
          );
        }
        const rebuilt: Record<string, DynamoAttributeValue> = {};
        for (const [index, column] of path.cursorKeyColumns.entries()) {
          const attribute = decodeKeyAttribute(decoded.keyValues[index]);
          if (attribute === null) {
            return Promise.reject(
              new UnsupportedQueryFeatureError(
                'cursor-pagination',
                ADAPTER,
                `DynamoDB entity '${entity}' received a malformed cursor.`,
              ),
            );
          }
          rebuilt[column] = attribute;
        }
        start = rebuilt;
      }
      const rows: Record<string, unknown>[] = [];
      let last: DynamoAttributeMap | undefined;
      let fetches = 0;
      // A non-positive `limit` is the normalized UNLIMITED value (`-1`), which
      // the contract and the memory reference both take to mean "every
      // matching row". Draining it here keeps `findPage` consistent with this
      // adapter's own `findAll` and with the other built-in paging backend;
      // stopping after one server page returned a short page whenever the
      // result crossed DynamoDB's native page boundary. The `maxPageFetches`
      // bound still applies, and a bounded return always carries a non-`null`
      // cursor, so it can cost a round trip but never a row.
      const unlimited = query.limit <= 0;
      do {
        const remaining = unlimited ? undefined : query.limit - rows.length;
        const output = await read(query, start, remaining);
        rows.push(...(output.Items ?? []).map(unmarshalDynamoItem));
        last = output.LastEvaluatedKey;
        start = last;
        fetches += 1;
      } while (
        last !== undefined && (unlimited || rows.length < query.limit) &&
        fetches < maxPageFetches
      );
      const pageRows = query.limit > 0 ? rows.slice(0, query.limit) : rows;
      // Minted from the RAW `LastEvaluatedKey`, never from the unmarshalled
      // row: the tagged encoding is what preserves a key attribute's native
      // type across the round trip (see `encodeKeyAttribute`).
      let nextCursor: string | null = null;
      if (last !== undefined) {
        const terminal = last;
        const keyValues: string[] = [];
        for (const column of path.cursorKeyColumns) {
          const attribute = terminal[column];
          if (attribute === undefined) {
            return Promise.reject(
              new UnsupportedQueryFeatureError(
                'cursor-pagination',
                ADAPTER,
                `DynamoDB entity '${entity}' continuation key is missing '${column}'.`,
              ),
            );
          }
          keyValues.push(encodeKeyAttribute(attribute, entity));
        }
        nextCursor = encodeCursor({
          orderedValues: keyValues,
          keyValues,
          sortFingerprint: fingerprint,
        });
      }
      return {
        rows: pageRows.map((row) => projectFields(row, query.select) as Record<string, unknown>),
        nextCursor,
      };
    },
  };
}
