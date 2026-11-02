/**
 * Unit tests for the store resolver (plan §3.5, §3.14).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IIdempotencyStore } from '@setu-ts/common';
import type { IRedisIdempotencyClient } from '../../src/interfaces/index.ts';
import { resolveStore } from '../../src/stores/resolve-store.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A conforming injected Redis client. */
function injectedClient(policy = 'noeviction'): IRedisIdempotencyClient {
  return {
    eval: () => Promise.resolve('settled'),
    ping: () => Promise.resolve('PONG'),
    quit: () => Promise.resolve('OK'),
    call: () => Promise.resolve(['maxmemory-policy', policy]),
  };
}

/** The reporter the resolver forwards to a BUILT client only. */
const noopReporter = { report: () => {}, recovered: () => {} };

describe('resolveStore (M109a §3.14)', () => {
  it('defaults to a memory store when no config is given', async () => {
    expect((await resolveStore(undefined, noopReporter, () => undefined)).name).toBe('memory');
  });

  it('builds a memory store from a memory config', async () => {
    const store = await resolveStore(
      { type: 'memory', maxEntries: 5 },
      noopReporter,
      () => undefined,
    );
    expect(store.name).toBe('memory');
  });

  it('passes a custom store through unchanged', async () => {
    const custom: IIdempotencyStore = {
      name: 'custom',
      connect: () => Promise.resolve(),
      claim: () => Promise.resolve({ outcome: 'claimed', takeover: false }),
      complete: () => Promise.resolve('settled'),
      release: () => Promise.resolve('lost'),
    };
    expect(
      await resolveStore({ type: 'custom', store: custom }, noopReporter, () => undefined),
    ).toBe(custom);
  });

  it('builds an injected Redis store without connecting it', async () => {
    const store = await resolveStore(
      { type: 'redis', namespace: 'shop', client: injectedClient() },
      noopReporter,
      () => undefined,
    );
    expect(store.name).toBe('redis');
    // An injected client is not connected by the store.
    await expect(store.connect(createClockRuntime())).resolves.toBeUndefined();
  });

  it('attaches the reporter to an injected client too (M131a X88-3)', async () => {
    const events: string[] = [];
    const client = {
      ...injectedClient(),
      on: (event: string): void => void events.push(event),
    };
    await resolveStore({ type: 'redis', namespace: 'shop', client }, noopReporter, () => undefined);
    // An injected node-redis client's outages must be as visible as a built
    // ioredis client's (M131a §3.5): one listener for errors, one for recovery.
    expect(events).toEqual(['error', 'ready']);
  });

  it('detaches the injected client listeners on disconnect (M131a audit)', async () => {
    const { EventEmitter } = await import('node:events');
    const client = Object.assign(new EventEmitter(), injectedClient());
    const store = await resolveStore(
      { type: 'redis', namespace: 'shop', client: client as never },
      noopReporter,
      () => undefined,
    );
    expect(client.listenerCount('error')).toBe(1);
    await store.disconnect?.();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('logs through the thunk when the injected client reports an evicting policy', async () => {
    const warnings: string[] = [];
    const logger = {
      level: 'info',
      warn: (m: string) => void warnings.push(m),
    } as never;
    const store = await resolveStore(
      { type: 'redis', namespace: 'shop', client: injectedClient('allkeys-lru') },
      noopReporter,
      () => logger,
    );
    await store.connect(createClockRuntime());
    expect(warnings).toHaveLength(1);
  });
});

it('loads the real lazy Redis client without opening a connection, and can disconnect it', async () => {
  for (const config of [
    { type: 'redis' as const, namespace: 'default', url: 'redis://127.0.0.1:1' },
    {
      type: 'redis' as const,
      namespace: 'explicit',
      url: 'redis://127.0.0.1:1',
      keyPrefix: 'custom:',
      commandTimeoutMs: 0,
    },
  ]) {
    const store = await resolveStore(config, undefined, () => undefined);
    expect(store.name).toBe('redis');
    await store.disconnect?.();
  }
});
