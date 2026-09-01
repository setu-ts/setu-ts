// deno-lint-ignore-file require-await -- async facade fakes model IDynamoClient promises.
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  DynamoQueryCommandInput,
  IDynamoClient,
} from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { createDynamoDataSource } from '../../src/adapters/dynamo/dynamo-data-source.ts';
import { decodeCursor, encodeCursor } from '@setu-ts/common';
const query = (partial = {}) => ({
  where: { pk: 'p' },
  orderBy: {},
  limit: 2,
  offset: 0,
  select: [],
  ...partial,
});
describe('DynamoDB cursor pages', () => {
  it('uses LastEvaluatedKey, including on an empty non-terminal page', async () => {
    const client: IDynamoClient = {
      query: async () => ({ Items: [], LastEvaluatedKey: { pk: { S: 'next' } } }),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    const page = await ds.findPage!(query());
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
  });
  it('returns null only without LastEvaluatedKey and refuses offset', async () => {
    const client: IDynamoClient = {
      query: async () => ({ Items: [] }),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    expect((await ds.findPage!(query())).nextCursor).toBeNull();
    await expect(ds.findPage!(query({ offset: 1 }))).rejects.toThrow('offset');
  });
  it('restores a valid cursor, refuses malformed tokens, and stops at its fetch bound', async () => {
    let calls = 0;
    const client: IDynamoClient = {
      query: async () => {
        calls++;
        return { Items: [], LastEvaluatedKey: { pk: { S: `p${calls}` } } };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } }, 2);
    const cursor = encodeCursor({
      orderedValues: ['S:p'],
      keyValues: ['S:p'],
      sortFingerprint: '',
    });
    expect((await ds.findPage!(query({ cursor }))).nextCursor).not.toBeNull();
    expect(calls).toBe(2);
    await expect(ds.findPage!(query({ cursor: 'bad' }))).rejects.toThrow('malformed');
  });

  it('uses the remaining page budget as the native DynamoDB Limit', async () => {
    const inputs: DynamoQueryCommandInput[] = [];
    let calls = 0;
    const client: IDynamoClient = {
      query: async (input) => {
        inputs.push(input);
        calls += 1;
        return calls < 3
          ? {
            Items: [{ pk: { S: 'p' }, value: { N: String(calls) } }],
            LastEvaluatedKey: { pk: { S: `p${calls}` } },
          }
          : { Items: [{ pk: { S: 'p' }, value: { N: '3' } }] };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });

    const page = await ds.findPage!(query({ limit: 3 }));

    expect(page.rows.map((row) => row.value)).toEqual([1, 2, 3]);
    expect(inputs.map((input) => input.Limit)).toEqual([3, 2, 1]);
  });

  it('round-trips every GSI and table key through a cursor', async () => {
    const inputs: DynamoQueryCommandInput[] = [];
    let calls = 0;
    const client: IDynamoClient = {
      query: async (input) => {
        inputs.push(input);
        calls += 1;
        return calls === 1
          ? {
            Items: [{
              gpk: { S: 'customer' },
              gsk: { S: 'created' },
              pk: { S: 'tenant' },
              sk: { S: 'order' },
            }],
            LastEvaluatedKey: {
              gpk: { S: 'customer' },
              gsk: { S: 'created' },
              pk: { S: 'tenant' },
              sk: { S: 'order' },
            },
          }
          : { Items: [] };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', {
      Item: {
        partitionKey: 'pk',
        sortKey: 'sk',
        indexes: { byCustomer: { partitionKey: 'gpk', sortKey: 'gsk' } },
      },
    });

    const first = await ds.findPage!(query({ where: { gpk: 'customer' }, limit: 1 }));
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('GSI page must have a continuation cursor');
    expect(decodeCursor(cursor)?.keyValues).toEqual([
      'S:customer',
      'S:created',
      'S:tenant',
      'S:order',
    ]);

    await ds.findPage!(query({ where: { gpk: 'customer' }, cursor, limit: 1 }));
    expect(inputs[1]).toMatchObject({
      ExclusiveStartKey: {
        gpk: { S: 'customer' },
        gsk: { S: 'created' },
        pk: { S: 'tenant' },
        sk: { S: 'order' },
      },
    });
  });

  it('keeps primary-key Query and Scan cursor shapes to table keys', async () => {
    const primaryClient: IDynamoClient = {
      query: async () => ({ Items: [], LastEvaluatedKey: { pk: { S: 'p' }, sk: { S: 's' } } }),
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const scanClient: IDynamoClient = {
      query: async () => ({}),
      scan: async () => ({ Items: [], LastEvaluatedKey: { pk: { S: 'p' }, sk: { S: 's' } } }),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const mapping = { Item: { partitionKey: 'pk', sortKey: 'sk' } };

    const primary = await createDynamoDataSource(primaryClient, 'Item', mapping)
      .findPage!(query({ limit: 1 }));
    const scan = await createDynamoDataSource(scanClient, 'Item', mapping)
      .findPage!(query({ where: {}, limit: 1 }));

    expect(decodeCursor(primary.nextCursor ?? '')?.keyValues).toEqual(['S:p', 'S:s']);
    expect(decodeCursor(scan.nextCursor ?? '')?.keyValues).toEqual(['S:p', 'S:s']);
  });
});

describe('DynamoDB cursor key fidelity (Qodo review)', () => {
  /** A facade recording every ExclusiveStartKey it is handed. */
  function recorder(lastKey: Record<string, unknown>) {
    const seen: unknown[] = [];
    const client: IDynamoClient = {
      query: async (input: DynamoQueryCommandInput) => {
        seen.push(input.ExclusiveStartKey);
        return { Items: [], LastEvaluatedKey: lastKey as never };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    return { client, seen };
  }

  it('round-trips a numeric key that cannot survive Number()', async () => {
    // §3.15 preserves a non-round-trippable `N` as a STRING on read, so minting
    // the cursor from the unmarshalled row rebuilt this key as `S` and DynamoDB
    // answered `Type mismatch for attribute to update` (measured).
    const { client, seen } = recorder({ pk: { N: '9007199254740993' } });
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    const first = await ds.findPage!(query({ limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    await ds.findPage!(query({ limit: 1, cursor: first.nextCursor as string }));
    expect(seen[seen.length - 1]).toEqual({ pk: { N: '9007199254740993' } });
  });

  it('round-trips a binary key rather than minting an undecodable token', async () => {
    // A `B` key unmarshals to a Uint8Array, which the cursor's JSON codec
    // cannot represent — the minted token decoded as malformed.
    const bytes = new Uint8Array([1, 2, 3]);
    const { client, seen } = recorder({ pk: { B: bytes } });
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    const first = await ds.findPage!(query({ limit: 1 }));
    expect(first.nextCursor).not.toBeNull();
    await ds.findPage!(query({ limit: 1, cursor: first.nextCursor as string }));
    expect(seen[seen.length - 1]).toEqual({ pk: { B: bytes } });
  });

  it('drains an unlimited page instead of returning one server page', async () => {
    // `limit: -1` is the normalized UNLIMITED value; the memory reference
    // returns every matching row for it, and this adapter's own findAll
    // drains. findPage stopped after one response.
    let calls = 0;
    const client: IDynamoClient = {
      query: async () => {
        calls += 1;
        return calls < 3
          ? { Items: [{ pk: { S: `p${calls}` } }], LastEvaluatedKey: { pk: { S: `p${calls}` } } }
          : { Items: [{ pk: { S: 'p3' } }] };
      },
      scan: async () => ({}),
      getItem: async () => ({}),
      putItem: async () => ({}),
      updateItem: async () => ({}),
      deleteItem: async () => ({}),
      transactWriteItems: async () => ({}),
      destroy() {},
    };
    const ds = createDynamoDataSource(client, 'Item', { Item: { partitionKey: 'pk' } });
    const page = await ds.findPage!(query({ limit: -1 }));
    expect(calls).toBe(3);
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});
