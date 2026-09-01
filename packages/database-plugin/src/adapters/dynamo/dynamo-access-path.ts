/**
 * DynamoDB read access-path resolution.
 *
 * DynamoDB can query only when an equality constrains a table or configured
 * GSI partition key. This module therefore selects that native path when it
 * is semantically safe, folds the chosen key predicates into the key
 * condition, and leaves every other predicate for the filter expression.
 *
 * @module
 */
import type {
  FilterComparison,
  FilterExpression,
  NormalizedQuery,
  OrderDirection,
} from '@setu-ts/common';
import type { DynamoQueryCommandInput, DynamoScanCommandInput } from './dynamo-client-types.ts';
import { createDynamoExpressionBuilder, translateDynamoFilter } from './dynamo-expression.ts';
import type { DynamoDateEncoding, resolveDynamoTarget } from './dynamo-mapping.ts';
import { UnsupportedQueryFeatureError } from '../../errors.ts';

/** The adapter name every access-path refusal carries. */
const ADAPTER = 'dynamodb';

/** A queryable DynamoDB key schema, for either the table or one mapped GSI. */
interface DynamoKeySchema {
  /** The partition-key attribute whose equality makes `Query` possible. */
  readonly partitionKey: string;
  /** The optional sort-key attribute that DynamoDB can order and constrain. */
  readonly sortKey?: string;
}

/** A table or configured index selected for one read. */
interface DynamoQueryPath extends DynamoKeySchema {
  /** The configured GSI name, absent when this is the table primary key. */
  readonly indexName?: string;
}

/**
 * The command shape selected for one DynamoDB read, plus its log label.
 *
 * `logPath` is intentionally data rather than a logging side effect: the
 * database service owns the single `logQueries` wrapper, while the data source
 * built in the next slice consumes this label when it invokes that seam.
 *
 * @internal
 */
export type DynamoAccessPath = {
  /** The selected native command and the fields access-path resolution owns. */
  readonly command: DynamoQueryCommandInput | DynamoScanCommandInput;
  /** Whether the selected command is a key-constrained query or a scan. */
  readonly commandType: 'Query' | 'Scan';
  /** The observable path label: `Query`, `Scan`, or the configured GSI name. */
  readonly logPath: string;
  /** Key columns in partition-then-sort order for the selected path. */
  readonly keyColumns: readonly string[];
  /** Complete key columns needed to resume this path from `LastEvaluatedKey`. */
  readonly cursorKeyColumns: readonly string[];
};

/** A comparison selected for folding into the native key condition. */
interface KeyComparison {
  /** The comparison node to remove from the remaining filter. */
  readonly comparison: DynamoKeyComparison;
  /** The physical key attribute it addresses. */
  readonly field: string;
}

/** The portable comparisons DynamoDB can place in a query key condition. */
type DynamoKeyComparison = Extract<
  FilterComparison,
  { readonly operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' }
>;

/**
 * Resolves a query's predicates and ordering onto a DynamoDB access path.
 *
 * A primary-key partition equality wins over a configured GSI; otherwise the
 * first configured GSI whose partition key has an equality is used. Only
 * comparisons proven to be conjunctive are folded into `KeyConditionExpression`.
 * No eligible equality means `Scan`, whose remaining predicates become a
 * `FilterExpression`.
 *
 * @param entity - Repository entity name, used in refusal diagnostics
 * @param target - Resolved table/index mapping for the entity
 * @param query - Fully normalised repository query
 * @returns The selected command shape and its reporting metadata
 * @throws {UnsupportedQueryFeatureError} When `orderBy` cannot be honoured
 * @internal
 */
export function resolveDynamoAccessPath(
  entity: string,
  target: ReturnType<typeof resolveDynamoTarget>,
  query: NormalizedQuery,
): DynamoAccessPath {
  const candidates = conjunctiveComparisons(query);
  const primaryPath: DynamoQueryPath = {
    partitionKey: target.partitionKey,
    ...(target.keyColumns[1] === undefined ? {} : { sortKey: target.keyColumns[1] }),
  };
  const path = selectQueryPath(primaryPath, target.indexes, candidates);
  const order = resolveOrderBy(entity, path, query.orderBy);
  const folded = path === undefined ? [] : foldKeyComparisons(path, candidates);
  const filter = remainingFilter(query, folded.map((entry) => entry.comparison));
  const builder = createDynamoExpressionBuilder();

  if (path === undefined) {
    const filterExpression = filter === undefined
      ? undefined
      : translateDynamoFilter(filter, builder, target.dateAttributes);
    const command: DynamoScanCommandInput = {
      TableName: target.table,
      ...(filterExpression === undefined ? {} : { FilterExpression: filterExpression }),
      ...builder.expressionAttributes(),
    };
    return {
      command,
      commandType: 'Scan',
      logPath: 'Scan',
      keyColumns: target.keyColumns,
      cursorKeyColumns: target.keyColumns,
    };
  }

  const keyCondition = folded.map((entry) =>
    renderKeyComparison(entry, builder, target.dateAttributes)
  );
  const filterExpression = filter === undefined
    ? undefined
    : translateDynamoFilter(filter, builder, target.dateAttributes);
  const command: DynamoQueryCommandInput = {
    TableName: target.table,
    KeyConditionExpression: keyCondition.join(' AND '),
    ...(path.indexName === undefined ? {} : { IndexName: path.indexName }),
    ...(order === undefined ? {} : { ScanIndexForward: order === 'asc' }),
    ...(filterExpression === undefined ? {} : { FilterExpression: filterExpression }),
    ...builder.expressionAttributes(),
  };
  return {
    command,
    commandType: 'Query',
    logPath: path.indexName ?? 'Query',
    keyColumns: path.sortKey === undefined
      ? [path.partitionKey]
      : [path.partitionKey, path.sortKey],
    cursorKeyColumns: cursorKeyColumns(path, target.keyColumns),
  };
}

/**
 * Returns every attribute DynamoDB requires in a continuation key.
 *
 * A table query needs its selected primary-key columns only. A GSI query's
 * `LastEvaluatedKey` also contains the table primary key, so the cursor must
 * retain both schemas in this stable order to rebuild `ExclusiveStartKey`.
 */
function cursorKeyColumns(
  path: DynamoQueryPath,
  tableKeyColumns: readonly string[],
): readonly string[] {
  const pathKeyColumns = path.sortKey === undefined
    ? [path.partitionKey]
    : [path.partitionKey, path.sortKey];
  if (path.indexName === undefined) return pathKeyColumns;
  return [
    ...pathKeyColumns,
    ...tableKeyColumns.filter((column) => !pathKeyColumns.includes(column)),
  ];
}

/**
 * Produces the equality comparisons in `where` plus comparisons located only
 * beneath `and` groups. A comparison below `or` cannot be folded: it is not a
 * fact that holds for every returned item.
 */
function conjunctiveComparisons(query: NormalizedQuery): readonly FilterComparison[] {
  const where = Object.entries(query.where).map(([field, value]): FilterComparison => ({
    type: 'comparison',
    field,
    operator: 'eq',
    value,
  }));
  if (query.filter === undefined) return where;
  return [...where, ...collectConjunctiveComparisons(query.filter)];
}

/** Collects comparison leaves that are semantically conjoined with the root. */
function collectConjunctiveComparisons(filter: FilterExpression): readonly FilterComparison[] {
  if (filter.type === 'comparison') return [filter];
  if (filter.type === 'or') return [];
  return filter.filters.flatMap(collectConjunctiveComparisons);
}

/** Chooses the primary key first, then the first configured eligible GSI. */
function selectQueryPath(
  primaryPath: DynamoQueryPath,
  indexes: Readonly<Record<string, DynamoKeySchema>>,
  comparisons: readonly FilterComparison[],
): DynamoQueryPath | undefined {
  if (hasPartitionEquality(primaryPath, comparisons)) return primaryPath;
  for (const [indexName, index] of Object.entries(indexes)) {
    const path: DynamoQueryPath = { ...index, indexName };
    if (hasPartitionEquality(path, comparisons)) return path;
  }
  return undefined;
}

/** Whether a path's partition key has a flat equality comparison. */
function hasPartitionEquality(
  path: DynamoKeySchema,
  comparisons: readonly FilterComparison[],
): boolean {
  return comparisons.some((comparison) =>
    comparison.operator === 'eq' && comparison.field === path.partitionKey
  );
}

/** Selects the partition equality and at most one valid sort-key comparison. */
function foldKeyComparisons(
  path: DynamoQueryPath,
  comparisons: readonly FilterComparison[],
): readonly KeyComparison[] {
  const partition = comparisons.find((comparison): comparison is DynamoKeyComparison =>
    comparison.operator === 'eq' && comparison.field === path.partitionKey
  );
  // `selectQueryPath` calls this only after `hasPartitionEquality` succeeds.
  // The defensive guard keeps this helper total if that call order changes.
  if (partition === undefined) return [];
  const sortKey = path.sortKey;
  const sort = sortKey === undefined
    ? undefined
    : comparisons.find((comparison): comparison is DynamoKeyComparison =>
      comparison.field === sortKey && isKeySortOperator(comparison)
    );
  if (sort === undefined || sortKey === undefined) {
    return [{ comparison: partition, field: path.partitionKey }];
  }
  return [
    { comparison: partition, field: path.partitionKey },
    { comparison: sort, field: sortKey },
  ];
}

/** DynamoDB `Query` accepts these portable comparisons on its sort key. */
function isKeySortOperator(
  comparison: FilterComparison,
): comparison is DynamoKeyComparison {
  return comparison.operator === 'eq' || comparison.operator === 'gt' ||
    comparison.operator === 'gte' || comparison.operator === 'lt' || comparison.operator === 'lte';
}

/** Renders one folded key comparison through the shared alias/value builder. */
function renderKeyComparison(
  entry: KeyComparison,
  builder: ReturnType<typeof createDynamoExpressionBuilder>,
  dateAttributes: Readonly<Record<string, DynamoDateEncoding>>,
): string {
  const operator = entry.comparison.operator;
  const alias = builder.aliasPath(entry.field);
  const value = builder.addValue(entry.comparison.value, dateAttributes[entry.field]);
  const comparators: Readonly<Record<DynamoKeyComparison['operator'], string>> = {
    eq: '=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  };
  return `${alias} ${comparators[operator]} ${value}`;
}

/**
 * Converts all non-folded predicates into a single conjunction for the shared
 * filter renderer. `where` always has conjunctive equality semantics; a
 * folded filter comparison is removed only from an `and` path, never an `or`.
 */
function remainingFilter(
  query: NormalizedQuery,
  folded: readonly FilterComparison[],
): FilterExpression | undefined {
  const foldedSet = new Set(folded);
  const where = Object.entries(query.where)
    .map(([field, value]): FilterComparison => ({
      type: 'comparison',
      field,
      operator: 'eq',
      value,
    }))
    .filter((comparison) => !hasEquivalentComparison(comparison, folded));
  const filter = query.filter === undefined
    ? undefined
    : removeFoldedComparisons(query.filter, foldedSet);
  const filters = [...where, ...(filter === undefined ? [] : [filter])];
  if (filters.length === 0) return undefined;
  if (filters.length === 1 && filters[0] !== undefined) return filters[0];
  return { type: 'and', filters };
}

/** Checks whether a reconstructed `where` comparison is one selected for folding. */
function hasEquivalentComparison(
  comparison: FilterComparison,
  folded: readonly FilterComparison[],
): boolean {
  return folded.some((entry) =>
    entry.operator === comparison.operator && entry.field === comparison.field &&
    Object.is(entry.value, comparison.value)
  );
}

/** Removes selected comparison object identities while preserving boolean semantics. */
function removeFoldedComparisons(
  filter: FilterExpression,
  folded: ReadonlySet<FilterComparison>,
): FilterExpression | undefined {
  if (filter.type === 'comparison') return folded.has(filter) ? undefined : filter;
  if (filter.type === 'or') return filter;
  const children = filter.filters
    .map((child) => removeFoldedComparisons(child, folded))
    .filter((child): child is FilterExpression => child !== undefined);
  if (children.length === 0) return undefined;
  if (children.length === 1 && children[0] !== undefined) return children[0];
  return { type: 'and', filters: children };
}

/** Refuses every ordering DynamoDB cannot execute natively and deterministically. */
function resolveOrderBy(
  entity: string,
  path: DynamoQueryPath | undefined,
  orderBy: Readonly<Record<string, OrderDirection>>,
): OrderDirection | undefined {
  const fields = Object.keys(orderBy);
  if (fields.length === 0) return undefined;
  const field = fields[0] ?? '';
  const orderable = path?.sortKey;
  if (fields.length !== 1 || orderable !== field) {
    const rejected = fields.join(', ');
    throw new UnsupportedQueryFeatureError(
      'orderBy',
      ADAPTER,
      `DynamoDB adapter cannot order entity '${entity}' by '${rejected}'; only the resolved access path's sort key '${
        orderable ?? '(none)'
      }' is orderable.`,
    );
  }
  return orderBy[field];
}
