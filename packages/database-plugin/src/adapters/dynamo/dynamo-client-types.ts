/**
 * Structural DynamoDB SDK shapes owned by the DynamoDB adapter.
 *
 * The adapter drives these interfaces rather than AWS SDK classes directly, so
 * an application can inject a faithful client without importing the optional
 * `@aws-sdk/client-dynamodb` dependency. The lazy loader adapts the SDK to
 * this surface in `dynamo-client.ts`.
 *
 * @internal
 * @module
 */

/** A DynamoDB attribute value in the subset the adapter reads and writes. */
export interface DynamoAttributeValue {
  readonly S?: string;
  readonly N?: string;
  readonly B?: Uint8Array;
  readonly BOOL?: boolean;
  readonly NULL?: boolean;
  readonly M?: DynamoAttributeMap;
  readonly L?: readonly DynamoAttributeValue[];
  readonly SS?: readonly string[];
  readonly NS?: readonly string[];
  readonly BS?: readonly Uint8Array[];
}

/** A DynamoDB item or key map. */
export type DynamoAttributeMap = Readonly<Record<string, DynamoAttributeValue>>;

/** The write response images supported by DynamoDB's single-item commands. */
export const DYNAMO_RETURN_VALUES = ['ALL_NEW', 'ALL_OLD'] as const;

/** A write response image accepted by DynamoDB's single-item commands. */
export type DynamoReturnValue = typeof DYNAMO_RETURN_VALUES[number];

/** Expression aliases shared by all command shapes. */
export interface DynamoExpressionAttributes {
  /** Generated `#name` aliases mapped to physical attribute names. */
  readonly ExpressionAttributeNames?: Readonly<Record<string, string>>;
  /** Generated `:value` aliases mapped to DynamoDB values. */
  readonly ExpressionAttributeValues?: DynamoAttributeMap;
}

/** A conditional expression used to prevent an unintended write. */
export interface DynamoConditionExpression extends DynamoExpressionAttributes {
  /** A DynamoDB condition expression, including attribute-existence guards. */
  readonly ConditionExpression?: string;
}

/** Shared fields for a DynamoDB query or scan. */
export interface DynamoReadCommandInput extends DynamoExpressionAttributes {
  /** The physical table to read. */
  readonly TableName: string;
  /** The maximum number of evaluated items. */
  readonly Limit?: number;
  /** The server continuation key from the preceding response. */
  readonly ExclusiveStartKey?: DynamoAttributeMap;
  /** A projection expression for selected attributes. */
  readonly ProjectionExpression?: string;
  /** A post-read filter expression. */
  readonly FilterExpression?: string;
  /** The response shape requested from DynamoDB. */
  readonly Select?: 'ALL_ATTRIBUTES' | 'ALL_PROJECTED_ATTRIBUTES' | 'COUNT' | 'SPECIFIC_ATTRIBUTES';
}

/** Input for DynamoDB `Query`. */
export interface DynamoQueryCommandInput extends DynamoReadCommandInput {
  /** An optional configured global secondary index. */
  readonly IndexName?: string;
  /** The required partition-key condition, optionally with a sort condition. */
  readonly KeyConditionExpression: string;
  /** `true` for ascending sort-key order and `false` for descending. */
  readonly ScanIndexForward?: boolean;
}

/** Input for DynamoDB `Scan`. */
export type DynamoScanCommandInput = DynamoReadCommandInput;

/** The common DynamoDB `Query` and `Scan` response shape. */
export interface DynamoReadCommandOutput {
  /** Returned items, omitted by `Select: 'COUNT'`. */
  readonly Items?: readonly DynamoAttributeMap[];
  /** The authoritative server continuation key, when further results exist. */
  readonly LastEvaluatedKey?: DynamoAttributeMap;
  /** Number of returned or counted items in this response. */
  readonly Count?: number;
  /** Number of items DynamoDB evaluated before filtering. */
  readonly ScannedCount?: number;
}

/** Input for DynamoDB `GetItem`. */
export interface DynamoGetItemCommandInput extends DynamoExpressionAttributes {
  /** The physical table to read. */
  readonly TableName: string;
  /** The complete primary key. */
  readonly Key: DynamoAttributeMap;
  /** A projection expression for selected attributes. */
  readonly ProjectionExpression?: string;
}

/** Output from DynamoDB `GetItem`. */
export interface DynamoGetItemCommandOutput {
  /** The item, omitted when no item matches the key. */
  readonly Item?: DynamoAttributeMap;
}

/** Input for DynamoDB `PutItem`. */
export interface DynamoPutItemCommandInput extends DynamoConditionExpression {
  /** The physical table to write. */
  readonly TableName: string;
  /** The complete item to persist. */
  readonly Item: DynamoAttributeMap;
}

/** Output from DynamoDB `PutItem`. */
export interface DynamoPutItemCommandOutput {
  /** Returned attributes when the command asks for them. */
  readonly Attributes?: DynamoAttributeMap;
}

/** Input for DynamoDB `UpdateItem`. */
export interface DynamoUpdateItemCommandInput extends DynamoConditionExpression {
  /** The physical table to write. */
  readonly TableName: string;
  /** The complete primary key. */
  readonly Key: DynamoAttributeMap;
  /** The update expression to apply. */
  readonly UpdateExpression: string;
  /** Requests the persisted row after a successful update. */
  readonly ReturnValues?: 'ALL_NEW';
}

/** Output from DynamoDB `UpdateItem`. */
export interface DynamoUpdateItemCommandOutput {
  /** The persisted row when `ReturnValues` is `ALL_NEW`. */
  readonly Attributes?: DynamoAttributeMap;
}

/** Input for DynamoDB `DeleteItem`. */
export interface DynamoDeleteItemCommandInput extends DynamoConditionExpression {
  /** The physical table to write. */
  readonly TableName: string;
  /** The complete primary key. */
  readonly Key: DynamoAttributeMap;
  /** Requests the prior row so deletion can report whether it existed. */
  readonly ReturnValues?: 'ALL_OLD';
}

/** Output from DynamoDB `DeleteItem`. */
export interface DynamoDeleteItemCommandOutput {
  /** The deleted row when one existed and `ALL_OLD` was requested. */
  readonly Attributes?: DynamoAttributeMap;
}

/** A transactional `Put` operation. */
export interface DynamoTransactPut extends DynamoConditionExpression {
  /** The physical table to write. */
  readonly TableName: string;
  /** The complete item to persist. */
  readonly Item: DynamoAttributeMap;
}

/** A transactional `Update` operation. */
export interface DynamoTransactUpdate extends DynamoConditionExpression {
  /** The physical table to write. */
  readonly TableName: string;
  /** The complete primary key. */
  readonly Key: DynamoAttributeMap;
  /** The update expression to apply. */
  readonly UpdateExpression: string;
}

/** A transactional `Delete` operation. */
export interface DynamoTransactDelete extends DynamoConditionExpression {
  /** The physical table to write. */
  readonly TableName: string;
  /** The complete primary key. */
  readonly Key: DynamoAttributeMap;
}

/** One transaction operation accepted by DynamoDB `TransactWriteItems`. */
export interface DynamoTransactWriteItem {
  /** A conditional create operation. */
  readonly Put?: DynamoTransactPut;
  /** A conditional update operation. */
  readonly Update?: DynamoTransactUpdate;
  /** A conditional delete operation. */
  readonly Delete?: DynamoTransactDelete;
}

/** Input for DynamoDB `TransactWriteItems`. */
export interface DynamoTransactWriteItemsCommandInput {
  /** The ordered writes that DynamoDB commits atomically. */
  readonly TransactItems: readonly DynamoTransactWriteItem[];
}

/** Output from DynamoDB `TransactWriteItems`. */
export type DynamoTransactWriteItemsCommandOutput = Record<never, never>;

/**
 * The structural DynamoDB facade the adapter drives.
 *
 * An injected implementation needs only these operations. No SDK class or
 * `instanceof` identity is required.
 *
 * @since 0.1.0
 */
export interface IDynamoClient {
  /** Sends a key-constrained query. */
  query(input: DynamoQueryCommandInput): Promise<DynamoReadCommandOutput>;
  /** Scans a table or index when no key-constrained query is possible. */
  scan(input: DynamoScanCommandInput): Promise<DynamoReadCommandOutput>;
  /** Reads a single item by its complete key. */
  getItem(input: DynamoGetItemCommandInput): Promise<DynamoGetItemCommandOutput>;
  /** Creates one item. */
  putItem(input: DynamoPutItemCommandInput): Promise<DynamoPutItemCommandOutput>;
  /** Updates one existing item. */
  updateItem(input: DynamoUpdateItemCommandInput): Promise<DynamoUpdateItemCommandOutput>;
  /** Deletes one item. */
  deleteItem(input: DynamoDeleteItemCommandInput): Promise<DynamoDeleteItemCommandOutput>;
  /** Commits a bounded set of writes atomically. */
  transactWriteItems(
    input: DynamoTransactWriteItemsCommandInput,
  ): Promise<DynamoTransactWriteItemsCommandOutput>;
  /** Releases resources held by a client constructed through the lazy path. */
  destroy(): void;
}
