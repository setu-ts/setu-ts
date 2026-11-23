import { describe, expect, it } from 'vitest';
import { BigtableAdapter, CosmosAdapter, DynamoAdapter, DatabaseTimeoutError } from '../../src/index.ts';
import { createFakeCosmosClient } from '../fixtures/fake-cosmos-client.ts';
import { createFakeBigtableClient, FakeBigtableStore } from '../fixtures/fake-bigtable-client.ts';
import { dynamoFixture } from '../fixtures/conditional-dynamo.ts';
import { frozenFacade } from '../fixtures/frozen-facade.ts';

function fixture(type: string, timeout = 25) {
  if (type === 'dynamodb') {
    const client = dynamoFixture().client;
    client.getItem = () => Promise.resolve({});
    const native = frozenFacade(client);
    return { ...native, adapter: new DynamoAdapter({ client: native.client, requestTimeoutMs: timeout, entities: { First: { table: 'first', partitionKey: 'tenant', sortKey: 'order' }, Second: { partitionKey: 'id' } } }) };
  }
  if (type === 'cosmos') {
    const native = frozenFacade(createFakeCosmosClient({ containers: {} }).client);
    return { ...native, adapter: new CosmosAdapter({ database: 'db', client: native.client, requestTimeoutMs: timeout }) };
  }
  const native = frozenFacade(createFakeBigtableClient(new FakeBigtableStore()));
  return { ...native, adapter: new BigtableAdapter({ instance: 'i', client: native.client, requestTimeoutMs: timeout, tables: { First: { table: 'first' }, Second: { table: 'second' } } }) };
}
for (const type of ['dynamodb','cosmos','bigtable']) describe(`${type} readiness probe`, () => {
  it('uses a data-plane read, reports lifecycle state, and bounds an unanswered probe', async () => {
    const f = fixture(type);
    expect(await f.adapter.isHealthy!()).toBe(false);
    await f.adapter.connect();
    expect(await f.adapter.isHealthy!()).toBe(true);
    const call = f.calls.at(-1)!;
    if (type === 'dynamodb') expect(call.args[0]).toMatchObject({ TableName: 'first', Key: { tenant: { S: '__setu_readiness__' }, order: { S: '__setu_readiness__' } } });
    if (type === 'bigtable') expect(call.args[0]).toMatchObject({ keys: ['__setu_readiness__'] });
    f.freeze();
    await expect(f.adapter.isHealthy!()).rejects.toBeInstanceOf(DatabaseTimeoutError);
    await f.adapter.disconnect();
    expect(await f.adapter.isHealthy!()).toBe(false);
  });
  it('keeps a two-second probe bound when the application disables request deadlines', async () => {
    const f = fixture(type, 0); await f.adapter.connect();
    try {
      expect(await f.adapter.isHealthy!()).toBe(true);
      const options = f.calls.at(-1)!.options;
      if (type === 'bigtable') expect(options.timeoutMs).toBe(2000);
      else expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    } finally { await f.adapter.disconnect(); }
  });
  const refused = type === 'dynamodb' ? ['ResourceNotFoundException','AccessDeniedException','UnrecognizedClientException'] : type === 'cosmos' ? [401,403,404,503] : [5,7,14,16];
  for (const code of refused) it(`reports a refused ${code} read as false`, async () => {
    const f = fixture(type); await f.adapter.connect();
    try {
      f.fail(typeof code === 'string' ? Object.assign(new Error('refused'), { name: code }) : Object.assign(new Error('refused'), { code }));
      expect(await f.adapter.isHealthy!()).toBe(false);
    } finally { await f.adapter.disconnect(); }
  });
  it('rejects an unknown failure rather than treating it as a refusal', async () => {
    const f = fixture(type); await f.adapter.connect(); const error = new Error('unknown');
    try { f.fail(error); await expect(f.adapter.isHealthy!()).rejects.toBe(error); }
    finally { await f.adapter.disconnect(); }
  });
});
it('M-5: a numeric-key ValidationException is reachable; no mapped target warns once', async () => {
  const native = frozenFacade(dynamoFixture().client);
  const adapter = new DynamoAdapter({ client: native.client, readinessEntity: 'Explicit' });
  await adapter.connect(); native.fail(Object.assign(new Error('wrong key type'), { name: 'ValidationException' }));
  expect(await adapter.isHealthy!()).toBe(true); await adapter.disconnect();
  for (const type of ['dynamodb','bigtable']) {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const adapter = type === 'dynamodb' ? new DynamoAdapter({ client: dynamoFixture().client }, warn) : new BigtableAdapter({ instance: 'i', client: createFakeBigtableClient(new FakeBigtableStore()) }, undefined, warn);
    expect(adapter.isHealthy).toBeUndefined(); await adapter.connect(); await adapter.disconnect(); await adapter.connect();
    expect(warnings).toHaveLength(1); expect(warnings[0]).toContain('readinessEntity'); await adapter.disconnect();
  }
});
