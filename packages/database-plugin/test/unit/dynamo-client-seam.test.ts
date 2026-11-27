/**
 * Unit coverage for the DynamoDB inject-or-lazy SDK seam.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { serializeError } from '@setu-ts/common';
import {
  adaptDynamoSdkModule,
  createInjectedDynamoLoader,
  createLazyDynamoLoader,
  type DynamoSdkModule,
} from '../../src/adapters/dynamo/dynamo-client.ts';
import type {
  DynamoDeleteItemCommandInput,
  DynamoDeleteItemCommandOutput,
  DynamoGetItemCommandInput,
  DynamoGetItemCommandOutput,
  DynamoPutItemCommandInput,
  DynamoPutItemCommandOutput,
  DynamoQueryCommandInput,
  DynamoReadCommandOutput,
  DynamoScanCommandInput,
  DynamoTransactWriteItemsCommandInput,
  DynamoTransactWriteItemsCommandOutput,
  DynamoUpdateItemCommandInput,
  DynamoUpdateItemCommandOutput,
  IDynamoClient,
} from '../../src/adapters/dynamo/dynamo-client-types.ts';
import { DynamoAdapter } from '../../src/adapters/dynamo/dynamo-adapter.ts';

class RecordingDynamoClient implements IDynamoClient {
  readonly calls: string[] = [];

  query(input: DynamoQueryCommandInput): Promise<DynamoReadCommandOutput> {
    this.calls.push(`query:${input.KeyConditionExpression}`);
    return Promise.resolve({ Count: 1 });
  }

  scan(input: DynamoScanCommandInput): Promise<DynamoReadCommandOutput> {
    this.calls.push(`scan:${input.TableName}`);
    return Promise.resolve({ Items: [] });
  }

  getItem(input: DynamoGetItemCommandInput): Promise<DynamoGetItemCommandOutput> {
    this.calls.push(`get:${input.TableName}`);
    return Promise.resolve({});
  }

  putItem(input: DynamoPutItemCommandInput): Promise<DynamoPutItemCommandOutput> {
    this.calls.push(`put:${input.ConditionExpression ?? ''}`);
    return Promise.resolve({});
  }

  updateItem(input: DynamoUpdateItemCommandInput): Promise<DynamoUpdateItemCommandOutput> {
    this.calls.push(`update:${input.ReturnValues ?? ''}`);
    return Promise.resolve({});
  }

  deleteItem(input: DynamoDeleteItemCommandInput): Promise<DynamoDeleteItemCommandOutput> {
    this.calls.push(`delete:${input.ReturnValues ?? ''}`);
    return Promise.resolve({});
  }

  transactWriteItems(
    input: DynamoTransactWriteItemsCommandInput,
  ): Promise<DynamoTransactWriteItemsCommandOutput> {
    this.calls.push(`transact:${input.TransactItems.length}`);
    return Promise.resolve({});
  }

  destroy(): void {
    this.calls.push('destroy');
  }
}

class FakeDynamoSdkClient {
  readonly commandNames: string[] = [];

  constructor(_configuration: unknown) {}

  send<TOutput>(_command: { readonly input: unknown }): Promise<TOutput> {
    this.commandNames.push(_command.constructor.name);
    return Promise.resolve({} as TOutput);
  }

  destroy(): void {}
}

class FakeQueryCommand {
  constructor(readonly input: DynamoQueryCommandInput) {}
}

class FakeScanCommand {
  constructor(readonly input: DynamoScanCommandInput) {}
}

class FakeGetItemCommand {
  constructor(readonly input: DynamoGetItemCommandInput) {}
}

class FakePutItemCommand {
  constructor(readonly input: DynamoPutItemCommandInput) {}
}

class FakeUpdateItemCommand {
  constructor(readonly input: DynamoUpdateItemCommandInput) {}
}

class FakeDeleteItemCommand {
  constructor(readonly input: DynamoDeleteItemCommandInput) {}
}

class FakeTransactWriteItemsCommand {
  constructor(readonly input: DynamoTransactWriteItemsCommandInput) {}
}

describe('DynamoDB client seam', () => {
  it('resolves an injected structural client without importing or constructing the SDK', async () => {
    const injected = new RecordingDynamoClient();
    const loader = createInjectedDynamoLoader(injected);
    const client = await loader.load();

    expect(client).toBe(injected);
    expect(
      (
        await client.query({
          TableName: 'orders',
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': 'tenantId' },
          ExpressionAttributeValues: { ':pk': { S: 'tenant-1' } },
          Select: 'COUNT',
        })
      ).Count,
    ).toBe(1);
    await client.scan({ TableName: 'orders' });
    await client.getItem({ TableName: 'orders', Key: { id: { S: 'order-1' } } });
    await client.putItem({
      TableName: 'orders',
      Item: { id: { S: 'order-1' } },
      ConditionExpression: 'attribute_not_exists(#pk)',
    });
    await client.updateItem({
      TableName: 'orders',
      Key: { id: { S: 'order-1' } },
      UpdateExpression: 'SET #status = :status',
      ReturnValues: 'ALL_NEW',
    });
    await client.deleteItem({
      TableName: 'orders',
      Key: { id: { S: 'order-1' } },
      ReturnValues: 'ALL_OLD',
    });
    await client.transactWriteItems({
      TransactItems: [{ Put: { TableName: 'orders', Item: { id: { S: 'order-2' } } } }],
    });
    client.destroy();

    expect(injected.calls).toEqual([
      'query:#pk = :pk',
      'scan:orders',
      'get:orders',
      'put:attribute_not_exists(#pk)',
      'update:ALL_NEW',
      'delete:ALL_OLD',
      'transact:1',
      'destroy',
    ]);
  });

  it('accepts a fake SDK module with all command constructors typed structurally', () => {
    const sdk: DynamoSdkModule = {
      DynamoDBClient: FakeDynamoSdkClient,
      QueryCommand: FakeQueryCommand,
      ScanCommand: FakeScanCommand,
      GetItemCommand: FakeGetItemCommand,
      PutItemCommand: FakePutItemCommand,
      UpdateItemCommand: FakeUpdateItemCommand,
      DeleteItemCommand: FakeDeleteItemCommand,
      TransactWriteItemsCommand: FakeTransactWriteItemsCommand,
    };

    const command = new sdk.QueryCommand({
      TableName: 'orders',
      KeyConditionExpression: '#pk = :pk',
    });
    expect(command.input.TableName).toBe('orders');
  });

  it('adapts every facade operation to its corresponding native SDK command', async () => {
    let nativeClient: FakeDynamoSdkClient | undefined;
    const sdk: DynamoSdkModule = {
      DynamoDBClient: class extends FakeDynamoSdkClient {
        constructor(configuration: unknown) {
          super(configuration);
          // eslint-disable-next-line @typescript-eslint/no-this-alias -- records the receiver under test
          nativeClient = this;
        }
      },
      QueryCommand: FakeQueryCommand,
      ScanCommand: FakeScanCommand,
      GetItemCommand: FakeGetItemCommand,
      PutItemCommand: FakePutItemCommand,
      UpdateItemCommand: FakeUpdateItemCommand,
      DeleteItemCommand: FakeDeleteItemCommand,
      TransactWriteItemsCommand: FakeTransactWriteItemsCommand,
    };
    const client = adaptDynamoSdkModule(sdk, { region: 'us-east-1' });

    await client.query({ TableName: 'orders', KeyConditionExpression: '#pk = :pk' });
    await client.scan({ TableName: 'orders' });
    await client.getItem({ TableName: 'orders', Key: { id: { S: 'order-1' } } });
    await client.putItem({ TableName: 'orders', Item: { id: { S: 'order-1' } } });
    await client.updateItem({
      TableName: 'orders',
      Key: { id: { S: 'order-1' } },
      UpdateExpression: 'SET #status = :status',
    });
    await client.deleteItem({ TableName: 'orders', Key: { id: { S: 'order-1' } } });
    await client.transactWriteItems({ TransactItems: [] });
    client.destroy();

    expect(nativeClient?.commandNames).toEqual([
      'FakeQueryCommand',
      'FakeScanCommand',
      'FakeGetItemCommand',
      'FakePutItemCommand',
      'FakeUpdateItemCommand',
      'FakeDeleteItemCommand',
      'FakeTransactWriteItemsCommand',
    ]);
  });

  it('lazily imports the real AWS SDK and exposes the structural facade', async () => {
    const loader = createLazyDynamoLoader({
      endpoint: 'http://127.0.0.1:8000',
      region: 'us-east-1',
      credentials: { accessKeyId: 'setu-m80', secretAccessKey: 'setu-m80' },
    });
    const client = await loader.load();

    expect(typeof client.query).toBe('function');
    expect(typeof client.scan).toBe('function');
    expect(typeof client.getItem).toBe('function');
    expect(typeof client.putItem).toBe('function');
    expect(typeof client.updateItem).toBe('function');
    expect(typeof client.deleteItem).toBe('function');
    expect(typeof client.transactWriteItems).toBe('function');
    client.destroy();
  });
});

describe('DynamoDB endpoint transport guard (CodeRabbit review)', () => {
  const credentials = { accessKeyId: 'a', secretAccessKey: 'b' };

  it('allows a loopback emulator over plaintext HTTP', () => {
    for (const endpoint of [
      'http://127.0.0.1:8000',
      'http://localhost:8000',
      'http://[::1]:8000',
    ]) {
      expect(() =>
        createLazyDynamoLoader({ region: 'us-east-1', endpoint, credentials }),
      ).not.toThrow();
    }
  });

  it('refuses credentials over plaintext HTTP to a remote host', () => {
    // SigV4 signs a request but does not encrypt it, and the AWS SDK does not
    // refuse this, so the adapter does.
    expect(() =>
      createLazyDynamoLoader({
        region: 'us-east-1',
        endpoint: 'http://dynamo.internal.example.com:8000',
        credentials,
      }),
    ).toThrow(/plaintext HTTP endpoint on remote host/);
  });

  it('preserves an invalid endpoint parser failure as the refusal cause', () => {
    let failure: unknown;
    try {
      createLazyDynamoLoader({ region: 'us-east-1', endpoint: 'not a URL' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeInstanceOf(TypeError);
    expect(serializeError(failure).cause?.name).toBe('TypeError');
  });

  it('allows https to a remote host', () => {
    expect(() =>
      createLazyDynamoLoader({
        region: 'us-east-1',
        endpoint: 'https://dynamo.example.com',
        credentials,
      }),
    ).not.toThrow();
  });

  it('refuses remote plaintext even when no credentials are configured', () => {
    // Not gated on `credentials`: AWS SDK v3 resolves them from the
    // environment, shared config or instance metadata, so an omitted bag
    // usually means "the SDK will find some" rather than "anonymous request",
    // and those ambient credentials would be signed over cleartext too.
    expect(() =>
      createLazyDynamoLoader({ region: 'us-east-1', endpoint: 'http://example.com' }),
    ).toThrow(/plaintext HTTP endpoint on remote host/);
    // Loopback stays allowed with or without credentials — the emulator case.
    expect(() =>
      createLazyDynamoLoader({ region: 'us-east-1', endpoint: 'http://127.0.0.1:8000' }),
    ).not.toThrow();
  });
});

describe('createLazyDynamoLoader — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the SDK is absent', async () => {
    vi.doMock('@aws-sdk/client-dynamodb', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await createLazyDynamoLoader({ region: 'us-east-1' }).load();
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@aws-sdk/client-dynamodb');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@aws-sdk/client-dynamodb');
    }
  });
});

/** What a recording SDK module saw: each constructor configuration and each `send` options bag. */
interface DynamoSdkRecord {
  readonly configurations: Record<string, unknown>[];
  readonly sendOptions: (Record<string, unknown> | undefined)[];
}

function recordingDynamoSdk(record: DynamoSdkRecord): DynamoSdkModule {
  return {
    DynamoDBClient: class {
      constructor(configuration: unknown) {
        record.configurations.push(configuration as Record<string, unknown>);
      }
      send<TOutput>(_command: unknown, options?: Record<string, unknown>): Promise<TOutput> {
        record.sendOptions.push(options);
        return Promise.resolve({} as TOutput);
      }
      destroy(): void {}
    },
    QueryCommand: FakeQueryCommand,
    ScanCommand: FakeScanCommand,
    GetItemCommand: FakeGetItemCommand,
    PutItemCommand: FakePutItemCommand,
    UpdateItemCommand: FakeUpdateItemCommand,
    DeleteItemCommand: FakeDeleteItemCommand,
    TransactWriteItemsCommand: FakeTransactWriteItemsCommand,
  };
}

/** Runs `body` with the lazy arm's `@aws-sdk/client-dynamodb` import served by a recording module. */
async function withRecordingDynamoSdk(
  body: (record: DynamoSdkRecord) => Promise<void>,
): Promise<void> {
  const record: DynamoSdkRecord = { configurations: [], sendOptions: [] };
  vi.doMock('@aws-sdk/client-dynamodb', () => recordingDynamoSdk(record));
  try {
    await body(record);
  } finally {
    vi.doUnmock('@aws-sdk/client-dynamodb');
  }
}

describe('DynamoDB clientOptions on the lazy arm', () => {
  it('spreads every clientOptions key into the SDK constructor, top-level keys winning', () => {
    const record: DynamoSdkRecord = { configurations: [], sendOptions: [] };
    const requestHandler = { handle: (): void => {} };
    adaptDynamoSdkModule(recordingDynamoSdk(record), {
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:8000',
      credentials: { accessKeyId: 'top', secretAccessKey: 'top' },
      clientOptions: {
        region: 'eu-west-1',
        endpoint: 'http://127.0.0.1:9999',
        credentials: { accessKeyId: 'inner', secretAccessKey: 'inner' },
        maxAttempts: 2,
        requestHandler,
      },
    });
    expect(record.configurations).toEqual([
      {
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:8000',
        credentials: { accessKeyId: 'top', secretAccessKey: 'top' },
        maxAttempts: 2,
        requestHandler,
      },
    ]);
  });

  it('keeps a clientOptions key the adapter does not set, and writes no undefined key', async () => {
    await withRecordingDynamoSdk(async (record) => {
      const adapter = new DynamoAdapter({
        region: 'us-east-1',
        clientOptions: { endpoint: 'http://127.0.0.1:8000', maxAttempts: 1 },
        entities: { Row: { partitionKey: 'id' } },
      });
      await adapter.connect();
      await adapter.disconnect();
      expect(record.configurations).toHaveLength(1);
      const configuration = record.configurations[0]!;
      expect(configuration).toEqual({
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:8000',
        maxAttempts: 1,
      });
      // `toEqual` treats an undefined-valued key as absent, so the keys are listed.
      expect(Object.keys(configuration).sort()).toEqual(['endpoint', 'maxAttempts', 'region']);
      expect(Object.values(configuration)).not.toContain(undefined);
    });
  });

  it('refuses a remote plaintext endpoint that arrives through clientOptions', () => {
    expect(() =>
      createLazyDynamoLoader({
        region: 'us-east-1',
        clientOptions: { endpoint: 'http://dynamo.example.com:8000' },
      }),
    ).toThrow(/plaintext HTTP endpoint on remote host 'dynamo.example.com'/);
  });

  it('passes an abort signal to send on every call, and none when the bound is 0', async () => {
    await withRecordingDynamoSdk(async (record) => {
      const bounded = new DynamoAdapter({
        region: 'us-east-1',
        entities: { Row: { partitionKey: 'id' } },
      });
      await bounded.connect();
      await bounded.createDataSource('Row').findById('a');
      await bounded.disconnect();
      expect(record.sendOptions.length).toBeGreaterThan(0);
      for (const options of record.sendOptions) {
        expect(options?.['abortSignal']).toBeInstanceOf(AbortSignal);
      }

      record.sendOptions.length = 0;
      const unbounded = new DynamoAdapter({
        region: 'us-east-1',
        requestTimeoutMs: 0,
        entities: { Row: { partitionKey: 'id' } },
      });
      await unbounded.connect();
      await unbounded.createDataSource('Row').findById('a');
      await unbounded.disconnect();
      expect(record.sendOptions.length).toBeGreaterThan(0);
      for (const options of record.sendOptions) {
        expect(options?.['abortSignal']).toBeUndefined();
      }
    });
  });

  it('leaves clientOptions unread when a client is injected', async () => {
    await withRecordingDynamoSdk(async (record) => {
      const touched: string[] = [];
      const clientOptions = new Proxy<Record<string, unknown>>(
        { region: 'eu-west-1' },
        {
          get: (target, property) => {
            touched.push(`get:${String(property)}`);
            return Reflect.get(target, property);
          },
          ownKeys: (target) => {
            touched.push('ownKeys');
            return Reflect.ownKeys(target);
          },
        },
      );
      const injected = new RecordingDynamoClient();
      const adapter = new DynamoAdapter({
        client: injected,
        clientOptions,
        entities: { Row: { partitionKey: 'id' } },
      });
      await adapter.connect();
      await adapter.createDataSource('Row').findById('a');
      await adapter.disconnect();
      expect(injected.calls).toContain('get:Row');
      expect(record.configurations).toEqual([]);
      expect(touched).toEqual([]);
    });
  });
});
