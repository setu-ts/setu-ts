/** DynamoDB implementation of the per-entity IDataSource port. @module */
import type { EntityKey, IDataSource, NormalizedQuery, PageResult } from '@setu-ts/common';
import { decodeCursor, encodeCursor, sortFingerprint } from '@setu-ts/common';
import type {
  DynamoAttributeMap,
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
  ): Promise<DynamoReadCommandOutput> => {
    const path = resolveDynamoAccessPath(entity, target, query);
    lastAccessPath = path.logPath;
    const input = { ...path.command, ...(start === undefined ? {} : { ExclusiveStartKey: start }) };
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
        return { ...unmarshalDynamoItem(existing.Item), ...Object.fromEntries(entries) };
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
        const output = await read(query, start);
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
          decoded.keyValues.length !== path.keyColumns.length
        ) {
          throw new UnsupportedQueryFeatureError(
            'cursor-pagination',
            ADAPTER,
            `DynamoDB entity '${entity}' received a malformed cursor.`,
          );
        }
        start = Object.fromEntries(
          path.keyColumns.map((
            column,
            index,
          ) => [column, marshalDynamoValue(decoded.keyValues[index])]),
        );
      }
      const rows: Record<string, unknown>[] = [];
      let last: DynamoAttributeMap | undefined;
      let fetches = 0;
      do {
        const output = await read(query, start);
        rows.push(...(output.Items ?? []).map(unmarshalDynamoItem));
        last = output.LastEvaluatedKey;
        start = last;
        fetches += 1;
      } while (
        last !== undefined && query.limit > 0 && rows.length < query.limit &&
        fetches < maxPageFetches
      );
      const pageRows = query.limit > 0 ? rows.slice(0, query.limit) : rows;
      const nextCursor = last === undefined ? null : encodeCursor({
        orderedValues: path.keyColumns.map((column) =>
          unmarshalDynamoItem(last)[column] as string | number
        ),
        keyValues: path.keyColumns.map((column) =>
          unmarshalDynamoItem(last)[column] as string | number
        ),
        sortFingerprint: fingerprint,
      });
      return {
        rows: pageRows.map((row) => projectFields(row, query.select) as Record<string, unknown>),
        nextCursor,
      };
    },
  };
}
