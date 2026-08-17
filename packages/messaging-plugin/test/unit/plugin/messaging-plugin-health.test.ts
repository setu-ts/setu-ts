import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { HealthCheckResult, IPluginContext, IRuntimeServices } from '@setu-ts/common';
import { MessagingPlugin } from '../../../src/plugin/messaging-plugin.ts';
import type { IRedisStreamsClient } from '../../../src/interfaces/index.ts';

function makeRuntime(): IRuntimeServices {
  return {
    platform: () => 'deno' as const,
    version: () => 'test',
    now: () => 0,
    hrtime: () => 0,
    setTimeout: (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return { id } as unknown as { id: number };
    },
    clearTimeout: (handle: { id: number }) => clearTimeout(handle.id),
    setInterval: (fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return { id } as unknown as { id: number };
    },
    clearInterval: (handle: { id: number }) => clearInterval(handle.id),
    uuid: () => 'u',
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as SubtleCrypto,
    env: {},
    exit: () => {
      throw new Error('exit');
    },
    hostname: () => 'localhost',
  };
}

function makeContext(): {
  ctx: IPluginContext;
  indicators: Map<string, unknown>;
} {
  const indicators = new Map<string, unknown>();
  const ctx: IPluginContext = {
    services: {
      has: () => false,
      get: <T>(): T => undefined as T,
      getAll: <T>(_: string): readonly T[] => [],
      register: () => {},
      registerFactory: () => {},
      unregister: () => false,
    },
    health: {
      register: (name: string, indicator: unknown) => {
        indicators.set(name, indicator);
      },
    },
    lifecycle: {
      onClose: () => {},
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onStopping: () => {},
      onShutdown: () => {},
    },
    middleware: { add: () => {} },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    environment: { validate: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    runtime: makeRuntime(),
    options: {},
    app: null as unknown as IPluginContext['app'],
  };
  return { ctx, indicators };
}

async function indicatorFor(indicators: Map<string, unknown>): Promise<HealthCheckResult> {
  const indicator = indicators.get(CAPABILITIES.MESSAGING) as () => Promise<HealthCheckResult>;
  return await indicator();
}

describe('MessagingPlugin health indicator four arms (M70c)', () => {
  it('up + reachable true when ready and the probe is healthy', async () => {
    const { ctx, indicators } = makeContext();
    await MessagingPlugin({ broker: 'memory' }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ broker: 'memory', reachable: true });
  });

  it('down + reachable false when not started (isReady false)', async () => {
    // A redis-streams broker whose client never connects: register() connects,
    // so simulate the not-started arm by disconnecting via a broker that
    // reports isReady false. The memory broker is ready after register, so use
    // a custom instance whose isReady is false.
    const { ctx, indicators } = makeContext();
    const instance = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      request: () => Promise.resolve(null as never),
      respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
      isReady: () => false,
    };
    await MessagingPlugin({ broker: 'custom', instance }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('down');
    expect(result.data).toEqual({ broker: 'custom', reachable: false });
  });

  it('down + reachable false when ready but the probe reports unreachable', async () => {
    // A redis-streams client whose ping rejects: ready (lifecycle) but
    // unreachable (backend down) — the X2-1 "broker restarted under us" case.
    const { ctx, indicators } = makeContext();
    const client: Record<string, unknown> = {
      xadd: () => Promise.resolve('0-1'),
      xgroup: () => Promise.resolve('OK'),
      xreadgroup: () => Promise.resolve(null),
      xack: () => Promise.resolve(0),
      quit: async () => {},
      connect: async () => {},
      ping: () => {
        return Promise.reject(new Error('connection lost'));
      },
    };
    await MessagingPlugin({
      broker: 'redis-streams',
      client: client as unknown as IRedisStreamsClient,
      url: 'redis://localhost:6379',
    }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('down');
    expect(result.data).toEqual({ broker: 'redis-streams', reachable: false });
  });

  it('up + reachable unknown when ready but the probe is unimplemented', async () => {
    // A redis-streams client without ping: the indicator must not lie and
    // report down; it reports 'unknown' reachability with an up status.
    const { ctx, indicators } = makeContext();
    const client: Record<string, unknown> = {
      xadd: () => Promise.resolve('0-1'),
      xgroup: () => Promise.resolve('OK'),
      xreadgroup: () => Promise.resolve(null),
      xack: () => Promise.resolve(0),
      quit: async () => {},
      connect: async () => {},
    };
    await MessagingPlugin({
      broker: 'redis-streams',
      client: client as unknown as IRedisStreamsClient,
      url: 'redis://localhost:6379',
    }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ broker: 'redis-streams', reachable: 'unknown' });
  });

  it('data carries broker plus reachable on every arm', async () => {
    const { ctx, indicators } = makeContext();
    await MessagingPlugin({ broker: 'memory' }).register(ctx);
    const result = await indicatorFor(indicators);
    const data = result.data as Record<string, unknown>;
    expect('broker' in data).toBe(true);
    expect('reachable' in data).toBe(true);
  });
});
