/** Internal deferred-write buffer for one DynamoDB adapter transaction. @module */
import type { DynamoAttributeMap, DynamoTransactWriteItem } from './dynamo-client-types.ts';
import { UnsupportedQueryFeatureError } from '../../errors.ts';

const ADAPTER = 'dynamodb';
const MAX_TRANSACTION_WRITES = 100;

/**
 * The transaction-owned buffer that transaction-scoped DynamoDB data sources
 * append their native writes to.
 *
 * The adapter retrieves these writes once at commit and submits them in one
 * `TransactWriteItems` call. Rollback discards them without contacting DynamoDB.
 *
 * @internal
 */
export interface IDynamoTransactionBuffer {
  /** Adds one write, refusing a duplicate physical item key or a 101st write. */
  add(write: DynamoTransactWriteItem, key: DynamoAttributeMap): void;

  /** Returns the writes in their original call order for one atomic commit. */
  getWrites(): readonly DynamoTransactWriteItem[];

  /** Discards all pending writes and duplicate-key tracking for rollback. */
  discard(): void;
}

/**
 * Creates an empty, adapter-owned DynamoDB transaction write buffer.
 *
 * @returns A buffer shared by every data source created from one transaction
 * @internal
 */
export function createDynamoTransactionBuffer(): IDynamoTransactionBuffer {
  const writes: DynamoTransactWriteItem[] = [];
  const keys = new Set<string>();

  return {
    add: (write, key): void => {
      const table = write.Put?.TableName ?? write.Update?.TableName ?? write.Delete?.TableName;
      if (table === undefined) {
        throw new Error(
          'DynamoDB transaction write must contain a Put, Update, or Delete operation.',
        );
      }
      const serializedKey = JSON.stringify(key);
      const identity = `${table}\u0000${serializedKey}`;
      if (keys.has(identity)) {
        throw new UnsupportedQueryFeatureError(
          'transaction',
          ADAPTER,
          `DynamoDB transaction already contains an operation for key '${serializedKey}' on table '${table}'.`,
        );
      }
      if (writes.length >= MAX_TRANSACTION_WRITES) {
        throw new UnsupportedQueryFeatureError(
          'transaction',
          ADAPTER,
          `DynamoDB transaction cannot contain more than ${MAX_TRANSACTION_WRITES} write operations.`,
        );
      }
      keys.add(identity);
      writes.push(write);
    },

    getWrites: (): readonly DynamoTransactWriteItem[] => [...writes],

    discard: (): void => {
      writes.length = 0;
      keys.clear();
    },
  };
}
