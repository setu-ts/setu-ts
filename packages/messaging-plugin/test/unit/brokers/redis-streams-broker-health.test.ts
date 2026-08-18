import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRedisStreamsClient } from '../../../src/interfaces/index.ts';
import { RedisStreamsBroker } from '../../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../../fixtures/fake-runtime.ts';

/**
 * Minimal Redis facade satisfying `validateClient` (xadd/xgroup/xreadgroup/
 * xack/quit/connect) plus a configurable `ping`.
 */
function makeRedisClient(ping?: () => Promise<string>): IRedisStreamsClient {
  const client: Record<string, unknown> = {
    xadd: () => Promise.resolve('0-1'),
    xgroup: () => Promise.resolve('OK'),
    xreadgroup: () => Promise.resolve(null),
    xack: () => Promise.resolve(0),
    quit: async () => {},
    connect: async () => {},
  };
  if (ping !== undefined) {
    client.ping = ping;
  }
  return client as unknown as IRedisStreamsClient;
}

function makeBroker(client: IRedisStreamsClient) {
  const runtime = createFakeRuntime();
  return new RedisStreamsBroker(runtime, new JsonSerializer(), {
    client,
    url: 'redis://localhost:6379',
  });
}

describe('RedisStreamsBroker health (M70c)', () => {
  it('reports down before connect', async () => {
    const broker = makeBroker(makeRedisClient(() => Promise.resolve('PONG')));
    expect(broker.isReady()).toBe(false);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true); // not known down
  });

  it('reports up when ping resolves', async () => {
    const broker = makeBroker(makeRedisClient(() => Promise.resolve('PONG')));
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(true);
    expect(await broker.isHealthy()).toBe(true);
  });

  it('reports down when ping rejects', async () => {
    const broker = makeBroker(makeRedisClient(() => {
      return Promise.reject(new Error('connection lost'));
    }));
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBe(false);
    expect(await broker.isHealthy()).toBe(false);
  });

  it('reports unknown when the client has no ping', async () => {
    const broker = makeBroker(makeRedisClient());
    await broker.connect();
    expect(broker.isReady()).toBe(true);
    expect(await broker.reachability()).toBeUndefined();
    expect(await broker.isHealthy()).toBe(true); // not known down
  });
});
