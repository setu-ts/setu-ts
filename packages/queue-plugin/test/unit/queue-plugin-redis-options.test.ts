import { describe, expect, it } from 'vitest';
import { QueuePlugin } from '../../src/index.ts';
import type { IPluginContext, IQueue } from '@setu-ts/common';
import { FakeEvalRedisClient } from '../fixtures/fake-ioredis-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('QueuePlugin Redis namespace', () => {
  it('validates visibilityTimeoutMs at plugin construction', () => {
    for (const value of [0, 999, -1, NaN, Infinity, 2_147_483_648, null, 'bad']) {
      expect(() => QueuePlugin({ adapter: 'redis', visibilityTimeoutMs: value as number })).toThrow(
        'options.visibilityTimeoutMs',
      );
    }
    expect(() => QueuePlugin({ adapter: 'memory', visibilityTimeoutMs: 0 })).not.toThrow();
  });
  it('validates the namespace at plugin construction', () => {
    for (const value of ['', 'x'.repeat(129), '\n', '\x7f', '\x80', null, 2]) {
      expect(() => QueuePlugin({ adapter: 'redis', keyPrefix: value as string })).toThrow(
        'options.keyPrefix',
      );
    }
    expect(() => QueuePlugin({ adapter: 'memory', keyPrefix: '' })).not.toThrow();
  });

  for (const keyPrefix of [undefined, 'app:']) {
    it(`forwards keyPrefix=${keyPrefix} and ignores the RabbitMQ prefix`, async () => {
      const client = new FakeEvalRedisClient();
      let queue: IQueue | undefined;
      const close: (() => void | Promise<void>)[] = [];
      const runtime = new FakeRuntimeServices(0);
      const ctx = {
        runtime,
        services: {
          has: () => false,
          register: (token: string, value: IQueue) => {
            if (token === 'queue') queue = value;
          },
        },
        health: { register: () => {} },
        lifecycle: {
          onClose: (fn: () => void | Promise<void>) => {
            close.push(fn);
          },
        },
      } as unknown as IPluginContext;
      await QueuePlugin({
        adapter: 'redis',
        client,
        visibilityTimeoutMs: 1000,
        prefix: 'rabbit-only',
        ...(keyPrefix === undefined ? {} : { keyPrefix }),
      }).register(ctx);
      await queue!.add('email', {});
      expect(client.calls.filter((call) => call.method === 'hset')[0].args[0]).toBe(
        `${keyPrefix ?? 'queue:'}email:jobs`,
      );
      queue!.process('email', () => {});
      await runtime.advanceMs(1000);
      expect(
        client.calls.filter(
          (call) => call.method === 'zadd' && String(call.args[0]).endsWith(':processing'),
        )[0].args[1],
      ).toBe(1100);
      for (const hook of close) await hook();
    });
  }
});
