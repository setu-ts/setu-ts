import { describe, expect, it, vi } from 'vitest';
import type { IRedisQueueClient } from '../../src/interfaces/index.ts';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';

/**
 * Builds a minimal structural client with a `ping` that records every call and
 * an optional `status`. The probe under test reads `status` first, so a
 * non-`'ready'` status must short-circuit to `false` with zero pings, while
 * `'ready'` or an absent status pings as before.
 */
function makeStatusClient(
  status: string | undefined,
  ping: () => Promise<unknown> = () => Promise.resolve('PONG'),
): { client: IRedisQueueClient; ping: ReturnType<typeof vi.fn> } {
  const pingSpy = vi.fn(ping);
  const client: Record<string, unknown> = {
    zadd: () => Promise.resolve(1),
    zrangebyscore: () => Promise.resolve([]),
    zrem: () => Promise.resolve(0),
    hset: () => Promise.resolve(1),
    hget: () => Promise.resolve(null),
    hdel: () => Promise.resolve(0),
    del: () => Promise.resolve(0),
    quit: () => Promise.resolve(),
    ping: pingSpy,
  };
  if (status !== undefined) {
    client.status = status;
  }
  return { client: client as unknown as IRedisQueueClient, ping: pingSpy };
}

/** The status table the probe decides on, as data (M131a §3.1). */
const STATUS_TABLE: ReadonlyArray<{
  readonly status: string | undefined;
  readonly expected: boolean;
  readonly pings: number;
}> = [
  { status: 'ready', expected: true, pings: 1 },
  { status: 'connecting', expected: false, pings: 0 },
  { status: 'reconnecting', expected: false, pings: 0 },
  { status: 'wait', expected: false, pings: 0 },
  { status: 'end', expected: false, pings: 0 },
  { status: undefined, expected: true, pings: 1 },
];

describe('RedisQueue health — client status (M131a V11-10)', () => {
  for (const row of STATUS_TABLE) {
    const label = row.status === undefined ? 'no status' : `status ${row.status}`;
    it(`answers ${row.expected} with ${row.pings} ping(s) for ${label}`, async () => {
      const { client, ping } = makeStatusClient(row.status);
      const queue = new RedisQueue({ client });
      await queue.connect();
      const probe = queue.isHealthy;
      expect(typeof probe).toBe('function');
      if (typeof probe === 'function') {
        expect(await probe()).toBe(row.expected);
      }
      expect(ping).toHaveBeenCalledTimes(row.pings);
    });
  }

  it('a stopped ioredis client (status end) reads down without I/O', async () => {
    // ioredis parks a stopped server's commands in the offline queue, so a ping
    // cannot tell stopped from hung; the client already knows it has no
    // connection. The probe must not issue the I/O that would hang.
    const { client, ping } = makeStatusClient('end');
    const queue = new RedisQueue({ client });
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
    expect(ping).not.toHaveBeenCalled();
  });

  it('a ready status still pings, so a paused server reads up/unknown', async () => {
    // A paused server keeps 'ready' (the TCP connection is open), so the probe
    // must still issue the ping: a hung ping times out under the service's
    // bounded probe and the indicator reads up/unknown, the intended M119b
    // rule. Here the ping resolves, so the point is that 'ready' does not
    // short-circuit the I/O.
    const { client, ping } = makeStatusClient('ready');
    const queue = new RedisQueue({ client });
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
    expect(ping).toHaveBeenCalledTimes(1);
  });
});
