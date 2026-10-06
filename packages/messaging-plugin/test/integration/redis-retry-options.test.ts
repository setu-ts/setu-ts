import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '../../src/index.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';

describe('Redis retry options through MessagingPlugin', () => {
  it('uses every non-default option on the real registration and delivery paths', async () => {
    const clock = clockRuntime();
    const client = new FakeRedisStreamsClient({ now: clock.runtime.hrtime });
    let attempts = 0;
    let classifications = 0;
    const delays = [30, 60];
    const app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'deno', adapters: { deno: () => clock.runtime } }),
        MessagingPlugin({
          broker: 'redis-streams',
          client,
          defaultQueue: 'g',
          pollIntervalMs: 5,
          reclaimIntervalMs: 10,
          deadLetterMaxLen: 7,
          consumerIdleSweepMs: 15,
          consumerRetry: {
            maxAttempts: 2,
            delaysMs: delays,
            isRetryable: () => {
              classifications++;
              return true;
            },
          },
          subscriptions: [{
            topic: 't',
            handler: () => {
              attempts++;
              throw Error('always');
            },
          }],
        }),
      ],
    });
    try {
      await app.start();
      await client.xreadgroup('GROUP', 'g', 'foreign', 'STREAMS', 't', '>');
      await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish('t', 'm1');
      await clock.advance(5);
      expect(attempts).toBe(1);
      // Mutating the caller array after construction must not shorten backoff.
      delays[0] = 1;
      await clock.advance(34);
      expect(attempts).toBe(1);
      await clock.advance(1);
      expect(attempts).toBe(2);
      expect(classifications).toBe(2);
      const dead = client.calls.find((c) => c.method === 'xadd' && c.args[0] === 't.dead.g');
      expect(dead?.args.slice(0, 5)).toEqual(['t.dead.g', 'MAXLEN', '~', '7', '*']);
      await clock.advance(10);
      expect(client.calls.some((c) => c.args[0] === 'DELCONSUMER' && c.args[3] === 'foreign')).toBe(
        true,
      );
    } finally {
      await app.stop();
    }
    expect(clock.timerCount()).toBe(0);
  });
});
