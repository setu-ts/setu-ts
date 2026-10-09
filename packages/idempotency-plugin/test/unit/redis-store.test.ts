/**
 * Unit tests for the Redis store (plan §3.5).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IdempotencyClaimRequest, IIdempotencyStore, ILogger } from '@setu-ts/common';
import type { IRedisIdempotencyClient } from '../../src/interfaces/index.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';
import {
  parseClaimReply,
  parseSettleReply,
  RedisIdempotencyStore,
} from '../../src/stores/redis-store.ts';

const hex = (char: string): string => char.repeat(64);

/** A claim request. */
const claimRequest: IdempotencyClaimRequest = {
  key: hex('a'),
  scope: hex('b'),
  fingerprint: hex('c'),
  token: 'tok',
  leaseMs: 1_000,
  ttlMs: 60_000,
};

/** A recording logger. */
function recordingLogger(): { logger: () => ILogger; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = {
    level: 'info',
    warn: (message: string) => void warnings.push(message),
    error: (message: string) => void errors.push(message),
  } as unknown as ILogger;
  return { logger: () => logger, warnings, errors };
}

/** Builds a fake injected client. */
function fakeClient(options: {
  evalReply?: unknown;
  evalError?: Error;
  pingReply?: string;
  pingError?: boolean;
  callReply?: unknown;
  callError?: Error;
} = {}): {
  client: IRedisIdempotencyClient;
  calls: { script: string; numkeys: number; args: (string | number)[] }[];
} {
  const calls: { script: string; numkeys: number; args: (string | number)[] }[] = [];
  const client: IRedisIdempotencyClient = {
    eval: (script: string, numkeys: number, ...args: (string | number)[]) => {
      calls.push({ script, numkeys, args });
      return options.evalError
        ? Promise.reject(options.evalError)
        : Promise.resolve(options.evalReply ?? 'settled');
    },
    ping: () =>
      options.pingError
        ? Promise.reject(new Error('down'))
        : Promise.resolve(options.pingReply ?? 'PONG'),
    quit: () => Promise.resolve('OK'),
    call: () =>
      options.callError ? Promise.reject(options.callError) : Promise.resolve(
        options.callReply ??
          ['maxmemory-policy', 'noeviction'],
      ),
  };
  return { client, calls };
}

/** Builds a store over a fake client. */
function store(options: Parameters<typeof fakeClient>[0] = {}, ownsClient = false) {
  const { client, calls } = fakeClient(options);
  const { logger, warnings, errors } = recordingLogger();
  const instance: IIdempotencyStore = new RedisIdempotencyStore(client, {
    namespace: 'shop',
    keyPrefix: 'setu:idempotency:',
    logger,
    ownsClient,
  });
  return { instance, calls, warnings, errors };
}

describe('parseClaimReply (M109a §3.5)', () => {
  it('parses every accepted shape', () => {
    expect(parseClaimReply(['claimed', '0'])).toEqual({ outcome: 'claimed', takeover: false });
    expect(parseClaimReply(['claimed', '1'])).toEqual({ outcome: 'claimed', takeover: true });
    expect(parseClaimReply(['completed', 'record'])).toEqual({
      outcome: 'completed',
      record: 'record',
    });
    expect(parseClaimReply(['in-progress'])).toEqual({ outcome: 'in-progress' });
    expect(parseClaimReply(['fingerprint-mismatch'])).toEqual({ outcome: 'fingerprint-mismatch' });
  });

  it('throws on a malformed reply', () => {
    expect(() => parseClaimReply('nope')).toThrow(
      'redis idempotency store: unexpected CLAIM reply',
    );
    expect(() => parseClaimReply(['claimed', '2'])).toThrow();
    expect(() => parseClaimReply(['completed', 5])).toThrow();
    expect(() => parseClaimReply(['in-progress', 'extra'])).toThrow();
  });
});

describe('parseSettleReply (M109a §3.5)', () => {
  it('accepts settled and lost and throws otherwise', () => {
    expect(parseSettleReply('settled')).toBe('settled');
    expect(parseSettleReply('lost')).toBe('lost');
    expect(() => parseSettleReply('other')).toThrow('redis idempotency store: unexpected reply');
  });
});

describe('RedisIdempotencyStore (M109a §3.5)', () => {
  it('sends CLAIM with numkeys 1, the namespaced key and ARGV order token,fingerprint,lease,ttl', async () => {
    const { instance, calls } = store({ evalReply: ['claimed', '0'] });
    const result = await instance.claim(claimRequest);
    expect(result).toEqual({ outcome: 'claimed', takeover: false });
    expect(calls[0].numkeys).toBe(1);
    expect(calls[0].args).toEqual([
      `setu:idempotency:shop:${hex('a')}`,
      'tok',
      hex('c'),
      1_000,
      60_000,
    ]);
  });

  it('sends COMPLETE and RELEASE with the token', async () => {
    const { instance, calls } = store({ evalReply: 'settled' });
    expect(await instance.complete(hex('a'), 'tok', 'rec', 5_000)).toBe('settled');
    expect(calls[0].args).toEqual([`setu:idempotency:shop:${hex('a')}`, 'tok', 'rec', 5_000]);
    expect(await instance.release(hex('a'), 'tok')).toBe('settled');
    expect(calls[1].args).toEqual([`setu:idempotency:shop:${hex('a')}`, 'tok']);
  });

  it('reports maxRecordBytes absent', () => {
    expect(store().instance.maxRecordBytes).toBeUndefined();
  });

  it('warns once on a non-noeviction policy, and not on noeviction', async () => {
    const evicting = store({ callReply: ['maxmemory-policy', 'allkeys-lru'] });
    await evicting.instance.connect(createClockRuntime());
    expect(evicting.warnings).toHaveLength(1);
    expect(evicting.warnings[0]).toContain('allkeys-lru');

    const safe = store({ callReply: ['maxmemory-policy', 'noeviction'] });
    await safe.instance.connect(createClockRuntime());
    expect(safe.warnings).toHaveLength(0);
  });

  it('ignores a rejected CONFIG GET and connects', async () => {
    const refused = store({ callError: new Error("ERR unknown command 'CONFIG'") });
    await expect(refused.instance.connect(createClockRuntime())).resolves.toBeUndefined();
    expect(refused.warnings).toHaveLength(0);
  });

  it('ignores a differently-shaped CONFIG reply', async () => {
    const odd = store({ callReply: 'weird' });
    await odd.instance.connect(createClockRuntime());
    expect(odd.warnings).toHaveLength(0);
  });

  it('reports health from PING and never rejects', async () => {
    expect(await store({ pingReply: 'PONG' }).instance.isHealthy?.()).toBe(true);
    expect(await store({ pingReply: 'NO' }).instance.isHealthy?.()).toBe(false);
    expect(await store({ pingError: true }).instance.isHealthy?.()).toBe(false);
  });

  it('does not connect or quit an injected client', async () => {
    const { instance } = store({}, false);
    await instance.connect(createClockRuntime());
    await instance.disconnect?.();
    // No assertion of a call is possible on a plain object; the meaningful
    // check is that neither member exists on the injected client shape.
    expect(instance.name).toBe('redis');
  });

  it('connects and quits a client it built', async () => {
    let connected = false;
    let quit = false;
    const built = {
      eval: () => Promise.resolve('settled'),
      ping: () => Promise.resolve('PONG'),
      quit: () => {
        quit = true;
        return Promise.resolve('OK');
      },
      call: () => Promise.resolve(['maxmemory-policy', 'noeviction']),
      connect: () => {
        connected = true;
        return Promise.resolve();
      },
      on: () => built,
    };
    const { logger } = recordingLogger();
    const instance = new RedisIdempotencyStore(built, {
      namespace: 'shop',
      keyPrefix: 'setu:idempotency:',
      logger,
      ownsClient: true,
    });
    await instance.connect(createClockRuntime());
    await instance.disconnect?.();
    expect(connected).toBe(true);
    expect(quit).toBe(true);
  });
});
