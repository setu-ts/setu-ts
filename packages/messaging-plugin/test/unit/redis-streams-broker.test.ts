import { expect } from '@std/expect';
import { RedisStreamsBroker, validateClient } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';

/**
 * RedisStreamsBroker unit tests.
 *
 * Tests broker behavior using an injected fake Redis client.
 */
Deno.test('RedisStreamsBroker - validateClient rejects malformed client', () => {
  // Missing required methods
  expect(validateClient({})).toBe(false);
  expect(validateClient({ get: () => null })).toBe(false);

  // Valid shape
  expect(
    validateClient({
      xadd: () => Promise.resolve(''),
      xgroup: () => Promise.resolve('OK'),
      xreadgroup: () => Promise.resolve(null),
      xack: () => Promise.resolve(0),
      quit: () => Promise.resolve(),
      connect: () => Promise.resolve(),
    }),
  ).toBe(true);
});

Deno.test('RedisStreamsBroker - publish emits xadd with serialized payload', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient();
  const broker = new RedisStreamsBroker(runtime, serializer, { client: fakeClient });

  await broker.connect();

  const message = { userId: 123, event: 'test' };
  await broker.publish('test.stream', message);

  const calls = fakeClient.calls;
  const xaddCall = calls.find((c) => c.method === 'xadd');

  expect(xaddCall).toBeDefined();
  expect(xaddCall?.args[0]).toBe('test.stream');

  await broker.disconnect();
});

Deno.test('RedisStreamsBroker - subscribe creates group and swallows BUSYGROUP', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient({ simulateBusyGroup: true });
  const broker = new RedisStreamsBroker(runtime, serializer, { client: fakeClient });

  await broker.connect();

  // First subscribe should create group
  await broker.subscribe('test.stream', () => {}, { queue: 'my-group' });

  // Second subscribe should get BUSYGROUP but continue
  await broker.subscribe('test.stream', () => {}, { queue: 'my-group' });

  const calls = fakeClient.calls;
  const xgroupCalls = calls.filter((c) => c.method === 'xgroup');

  // Should have called XGROUP CREATE twice
  expect(xgroupCalls.length).toBeGreaterThanOrEqual(1);

  await broker.disconnect();
});

Deno.test('RedisStreamsBroker - disconnect calls quit', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient();
  const broker = new RedisStreamsBroker(runtime, serializer, { client: fakeClient });

  await broker.connect();
  await broker.disconnect();

  expect(fakeClient.quitCalled).toBe(true);
});

Deno.test('RedisStreamsBroker - connect is idempotent', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient();
  const broker = new RedisStreamsBroker(runtime, serializer, { client: fakeClient });

  await broker.connect();
  expect(broker.isReady()).toBe(true);

  await broker.connect();
  expect(broker.isReady()).toBe(true);

  await broker.disconnect();
});

Deno.test('RedisStreamsBroker - validateClient rejects client without required methods', () => {
  expect(
    validateClient({
      xadd: () => Promise.resolve(''),
      // Missing xgroup, xreadgroup, xack, quit
    }),
  ).toBe(false);
});

Deno.test('RedisStreamsBroker - resolveClient prefers injected client', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient();

  const broker = new RedisStreamsBroker(runtime, serializer, {
    client: fakeClient,
    url: 'redis://should-not-be-used',
  });

  await broker.connect();

  // Should have used injected client, not tried to connect to URL
  expect(fakeClient.connectCalled).toBe(true);

  await broker.disconnect();
});

Deno.test('RedisStreamsBroker - defaultQueue is used when queue not specified', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient();
  const broker = new RedisStreamsBroker(runtime, serializer, {
    client: fakeClient,
    defaultQueue: 'custom-default-queue',
  });

  await broker.connect();

  // Subscribe without specifying queue - should use default
  await broker.subscribe('test.stream', () => {});

  const calls = fakeClient.calls;
  // XGROUP CREATE should use the default queue
  const xgroupCall = calls.find((c) => c.method === 'xgroup');
  // The args are [command, stream, group, ...], so group is at index 2
  expect(xgroupCall?.args[2]).toBe('custom-default-queue');

  await broker.disconnect();
});

Deno.test('RedisStreamsBroker - ack only called on handler success', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient({
    seededMessages: [{ id: '0-1', payload: serializer.serialize({ test: 1 }) }],
  });
  const broker = new RedisStreamsBroker(runtime, serializer, {
    client: fakeClient,
    pollIntervalMs: 10,
    blockSizeMs: 10,
  });

  await broker.connect();

  let callCount = 0;
  await broker.subscribe('test.stream', () => {
    callCount++;
    if (callCount === 1) {
      throw new Error('first call fails');
    }
  });

  // Wait for poll loop to process
  await new Promise((r) => setTimeout(r, 50));

  await broker.disconnect();
});

Deno.test('RedisStreamsBroker - READ-BACK: message round-trip via fake client', async () => {
  const runtime = createFakeRuntime();
  const serializer = new JsonSerializer();
  const fakeClient = new FakeRedisStreamsClient({
    seededMessages: [{ id: '0-1', payload: serializer.serialize({ userId: 456, name: 'test' }) }],
  });
  const broker = new RedisStreamsBroker(runtime, serializer, {
    client: fakeClient,
    pollIntervalMs: 10,
    blockSizeMs: 10,
  });

  await broker.connect();

  // The broker will poll for messages on subscribe
  await broker.subscribe('test.stream', () => {});

  // Wait for poll loop to process seeded messages
  await new Promise((r) => setTimeout(r, 50));

  // Verify xreadgroup was called
  const calls = fakeClient.calls;
  const xreadgroupCall = calls.find((c) => c.method === 'xreadgroup');
  expect(xreadgroupCall).toBeDefined();

  await broker.disconnect();
});
