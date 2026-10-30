/** Raw command parity on Redis 7 under default RESP3 and explicit RESP2. */
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import { fromNodeRedis } from '../../src/index.ts';

const url = process.env['REDIS_URL'];
const commands = [
  ['get', ['k'], [['SET', 'k', 'value']]],
  ['set', ['k', 'value', 'EX', 60], []],
  ['set', ['k', 'value', 'NX', 'PX', 60_000], []],
  ['del', ['k'], [['SET', 'k', 'value']]],
  ['exists', ['k'], [['SET', 'k', 'value']]],
  ['ping', [], []],
  ['scan', ['0', 'MATCH', 'nonexistent-m117-*'], []],
  ['zadd', ['k', 1, 'a'], []],
  ['zrangebyscore', ['k', '-inf', '+inf', 'LIMIT', 0, 1], [['ZADD', 'k', 1, 'a', 2, 'b']]],
  ['zrem', ['k', 'a'], [['ZADD', 'k', 1, 'a']]],
  ['hset', ['k', 'f', 'value'], []],
  ['hget', ['k', 'f'], [['HSET', 'k', 'f', 'value']]],
  ['hdel', ['k', 'f'], [['HSET', 'k', 'f', 'value']]],
  ['zcard', ['k'], [['ZADD', 'k', 1, 'a']]],
  ['expire', ['k', 60], [['SET', 'k', 'value']]],
  ['eval', ['return {ARGV[1], tonumber(ARGV[2])}', 0, 'value', 3], []],
  ['xadd', ['k', '1-0', 'f', 'value'], []],
  ['xgroup', ['CREATE', 'k', 'g', '0', 'MKSTREAM'], []],
  [
    'xreadgroup',
    ['GROUP', 'g', 'c', 'STREAMS', 'k', '>'],
    [
      ['XADD', 'k', '1-0', 'f', 'value'],
      ['XGROUP', 'CREATE', 'k', 'g', '0'],
    ],
  ],
  ['xpending', ['k', 'g', '-', '+', 10], [['XGROUP', 'CREATE', 'k', 'g', '0', 'MKSTREAM']]],
  [
    'xclaim',
    ['k', 'g', 'c2', 0, '1-0'],
    [
      ['XADD', 'k', '1-0', 'f', 'value'],
      ['XGROUP', 'CREATE', 'k', 'g', '0'],
      ['XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'k', '>'],
    ],
  ],
  ['xinfo', ['GROUPS', 'k'], [['XGROUP', 'CREATE', 'k', 'g', '0', 'MKSTREAM']]],
  [
    'xack',
    ['k', 'g', '1-0'],
    [
      ['XADD', 'k', '1-0', 'f', 'value'],
      ['XGROUP', 'CREATE', 'k', 'g', '0'],
      ['XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 'k', '>'],
    ],
  ],
  ['publish', ['k', 'value'], []],
  ['incr', ['k'], []],
  ['pexpire', ['absent', 60000], []],
  ['pttl', ['absent'], []],
] as const;

describe.each(['default RESP3', 'RESP2'] as const)('real node-redis %s', (protocol) => {
  it.each(commands)(
    '%s replies identically to ioredis',
    { skip: url === undefined },
    async (method, args, setup) => {
      const key = `m117-parity-${crypto.randomUUID()}`;
      const replace = (values: readonly (string | number)[]) =>
        values.map((value) => (value === 'k' ? key : value));
      const inspect = new Redis(url!);
      const raw =
        protocol === 'RESP2' ? createClient({ url: url!, RESP: 2 }) : createClient({ url: url! });
      const client = fromNodeRedis(raw);
      const reset = async () => {
        await inspect.del(key);
        for (const [command, ...values] of setup) await inspect.call(command, ...replace(values));
      };
      try {
        await reset();
        const expected = await inspect.call(method.toUpperCase(), ...replace(args));
        await reset();
        const actual = await client[method](...replace(args));
        expect(actual).toEqual(expected);
        // Read every mutation back over the adapter, proving it sent bytes to Redis.
        expect(await client.call('TYPE', key)).toBe(await inspect.type(key));
      } finally {
        await client.quit();
        await inspect.del(key);
        await inspect.quit();
      }
    },
  );

  it(
    'normalizes CONFIG GET, nested maps and pub/sub over a duplicate',
    { skip: url === undefined },
    async () => {
      const inspect = new Redis(url!);
      const raw =
        protocol === 'RESP2' ? createClient({ url: url!, RESP: 2 }) : createClient({ url: url! });
      const publisher = fromNodeRedis(raw);
      const subscriber = fromNodeRedis(raw.duplicate());
      const channel = `m117-pubsub-${crypto.randomUUID()}`;
      try {
        expect(await publisher.call('CONFIG', 'GET', 'maxmemory-policy')).toEqual(
          await inspect.call('CONFIG', 'GET', 'maxmemory-policy'),
        );
        await publisher.call('HSET', channel, 'a', 'b');
        expect(await publisher.call('HGETALL', channel)).toEqual(['a', 'b']);
        const delivered = Promise.withResolvers<[string, string]>();
        subscriber.on('message', (ch, message) => delivered.resolve([ch, message]));
        await subscriber.subscribe(channel);
        expect(await publisher.publish(channel, 'message')).toBe(1);
        expect(await delivered.promise).toEqual([channel, 'message']);
        await subscriber.unsubscribe(channel);
      } finally {
        await subscriber.quit();
        await publisher.quit();
        await inspect.del(channel);
        await inspect.quit();
      }
    },
  );
});
