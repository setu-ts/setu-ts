// deno-lint-ignore-file require-await -- fake native commands reject asynchronously.
import type {
  DynamoAttributeMap,
  DynamoConditionExpression,
  IDynamoClient,
} from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
import { unmarshalDynamoValue } from '../../src/adapters/dynamo/dynamo-marshal.ts';

/** Recording native command seam with the exact condition subset this source emits. */
export function dynamoFixture() {
  const rows = new Map<string, DynamoAttributeMap>();
  const calls: { operation: string; input: unknown }[] = [];
  let failure: Error | undefined;
  let omitAttributes = false;
  const key = (item: DynamoAttributeMap) => String(unmarshalDynamoValue(item.id!));
  const matches = (item: DynamoAttributeMap | undefined, input: DynamoConditionExpression) => {
    if (item === undefined) return false;
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    return (input.ConditionExpression ?? '').split(' AND ').every((condition) => {
      if (condition.startsWith('attribute_exists')) return true;
      const [attribute, value] = condition.split(' = ');
      // Own attributes only: DynamoDB has no prototype, so a condition on a
      // `constructor` attribute is a missing attribute and fails the check.
      const name = names[attribute!]!;
      const actual = Object.prototype.hasOwnProperty.call(item, name) ? item[name] : undefined;
      return actual !== undefined &&
        unmarshalDynamoValue(actual) === unmarshalDynamoValue(values[value!]!);
    });
  };
  const checkFailure = (): void => {
    if (failure !== undefined) throw failure;
  };
  const refused = (): Error =>
    Object.assign(new Error('not matched'), { name: 'ConditionalCheckFailedException' });
  const client: IDynamoClient = {
    destroy: () => {},
    getItem: (input) =>
      Promise.resolve(rows.has(key(input.Key)) ? { Item: rows.get(key(input.Key))! } : {}),
    putItem: (input) => {
      rows.set(key(input.Item), { ...input.Item });
      return Promise.resolve({});
    },
    updateItem: async (input) => {
      calls.push({ operation: 'update', input });
      checkFailure();
      const stored = rows.get(key(input.Key));
      if (!matches(stored, input)) throw refused();
      const updated = { ...stored };
      for (const assignment of input.UpdateExpression.slice(4).split(', ')) {
        const [field, value] = assignment.split(' = ');
        updated[input.ExpressionAttributeNames![field!]!] = input
          .ExpressionAttributeValues![value!]!;
      }
      rows.set(key(input.Key), updated);
      return omitAttributes ? {} : { Attributes: updated };
    },
    deleteItem: async (input) => {
      calls.push({ operation: 'delete', input });
      checkFailure();
      const stored = rows.get(key(input.Key));
      if (input.ConditionExpression !== undefined && !matches(stored, input)) throw refused();
      rows.delete(key(input.Key));
      return stored === undefined ? {} : { Attributes: stored };
    },
    query: () => Promise.resolve({ Items: [...rows.values()] }),
    scan: () => Promise.resolve({ Items: [...rows.values()] }),
    transactWriteItems: () => Promise.resolve({}),
  };
  return {
    source: createDynamoDataSource(client, 'User', { User: { partitionKey: 'id' } }),
    client,
    calls,
    fail: (error: Error) => {
      failure = error;
    },
    omitAttributes: () => {
      omitAttributes = true;
    },
  };
}
