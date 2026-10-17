import { describe, expect, it } from 'vitest';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { FakeEvalRedisClient, FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';

const job = (id: string) => ({
  id,
  name: 'email',
  data: {},
  attempts: 1,
  maxAttempts: 3,
  availableAtMs: 0,
});

describe('Redis key prefix', () => {
  for (const atomic of [false, true]) {
    for (const prefix of [undefined, 'app-one:']) {
      it(`routes every key through the namespace (eval=${atomic}, prefix=${prefix})`, async () => {
        const client = atomic ? new FakeEvalRedisClient() : new FakeRedisClient();
        const queue = new RedisQueue({
          client,
          deadLetterTtlMs: 1000,
          ...(prefix === undefined ? {} : { keyPrefix: prefix }),
        });
        await queue.connect();
        await queue.enqueue(job('ack'));
        let [reserved] = await queue.reserve('email', 1, 0);
        await queue.ack('email', 'ack', reserved.claimToken);
        await queue.enqueue(job('retry'));
        [reserved] = await queue.reserve('email', 1, 0);
        await queue.requeue('email', 'retry', 0, 2, reserved.claimToken);
        [reserved] = await queue.reserve('email', 1, 0);
        await queue.deadLetter('email', 'retry', 0, reserved.claimToken);
        await queue.enqueue(job('dead'));
        [reserved] = await queue.reserve('email', 1, 0);
        await queue.deadLetter('email', 'dead', 2000, reserved.claimToken);
        await queue.depths!('email');
        await queue.storeRecurring({
          id: 'rec',
          name: 'email',
          data: {},
          cron: '* * * * *',
          nextRunAtMs: 0,
        });
        expect(await queue.fetchRecurringDue(0)).toHaveLength(1);
        await queue.advanceRecurring('rec', 1000);
        const actual = new Set(
          client.calls
            .filter((call) => !['connect', 'quit'].includes(call.method))
            .map((call) => call.args[0]),
        );
        if (client instanceof FakeEvalRedisClient) {
          for (const [, count, ...args] of client.evals) {
            for (const key of args.slice(0, Number(count))) actual.add(key);
          }
        }
        const namespace = prefix ?? 'queue:';
        expect([...actual].sort()).toEqual(
          [
            ...(atomic ? ['email:claims', 'email:stalls', 'email:claimseq'] : []),
            'email:ready',
            'email:processing',
            'email:jobs',
            'email:dead',
            'email:dead:jobs',
            'recurring:due',
            'recurring:jobs',
          ]
            .map((suffix) => namespace + suffix)
            .sort(),
        );
        await queue.disconnect();
      });
    }
  }
  it('refuses invalid prefixes without echoing the supplied value', () => {
    for (const prefix of ['', 'a'.repeat(129), 'a\nb', 'a\x7fb', 'a\x9fb', 123, null]) {
      expect(() => new RedisQueue({ keyPrefix: prefix as string })).toThrow(
        'options.keyPrefix must be a non-empty string',
      );
    }
    expect(() => new RedisQueue({ keyPrefix: 'a'.repeat(128) })).not.toThrow();
  });
});
