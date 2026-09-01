/**
 * Unit coverage for the DynamoDB inject-or-lazy SDK seam.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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
      (await client.query({
        TableName: 'orders',
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'tenantId' },
        ExpressionAttributeValues: { ':pk': { S: 'tenant-1' } },
        Select: 'COUNT',
      })).Count,
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
    for (
      const endpoint of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000']
    ) {
      expect(() => createLazyDynamoLoader({ region: 'us-east-1', endpoint, credentials }))
        .not.toThrow();
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
      })
    ).toThrow(/plaintext HTTP to remote host/);
  });

  it('allows https to a remote host, and plaintext with no credentials', () => {
    expect(() =>
      createLazyDynamoLoader({
        region: 'us-east-1',
        endpoint: 'https://dynamo.example.com',
        credentials,
      })
    ).not.toThrow();
    expect(() => createLazyDynamoLoader({ region: 'us-east-1', endpoint: 'http://example.com' }))
      .not.toThrow();
  });
});
