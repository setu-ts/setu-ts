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

/**
 * Runtime with a MANUALLY advanced monotonic clock and MANUALLY fired
 * timers, so the 2s probe bound is driven by the test rather than the wall
 * clock (M95b §3.6 finding 2: the bound is asserted, not assumed).
 */
function makeManualRuntime(): {
  runtime: IRuntimeServices;
  advance: (ms: number) => void;
  fireTimers: () => void;
} {
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const base = makeRuntime();
  const runtime: IRuntimeServices = {
    ...base,
    hrtime: () => clock,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: clock + ms, fn });
      return { manual: timers.length } as unknown as { id: number };
    },
    clearTimeout: (_handle: { id: number }) => {},
  };
  return {
    runtime,
    advance: (ms: number) => void (clock += ms),
    fireTimers: () => {
      for (const timer of timers.splice(0)) timer.fn();
    },
  };
}

function makeContext(runtime?: IRuntimeServices): {
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
    runtime: runtime ?? makeRuntime(),
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

  describe('the indicator bounds the probe (M95b §3.6)', () => {
    it('a probe that NEVER settles resolves reachable unknown and the indicator SETTLES', async () => {
      // X51-2's blast radius: before M95b the indicator did
      // `await broker.reachability()` directly, so a hung backend held
      // `/health` and `/ready` open indefinitely. Reverting the
      // `createCachedProbe` wrapper leaves this case pending forever —
      // which is the finding's own reproduction.
      const manual = makeManualRuntime();
      // Hoisted into a variable (the excess-property rule: a fresh literal
      // is checked against IMessageBroker, a variable is not). It carries
      // the FULL internal seam so `asBrokerAdapter` returns it unchanged —
      // a partial seam would be wrapped and its `reachability` never read,
      // which made this test's first draft pass vacuously.
      const instance = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        publish: () => Promise.resolve(),
        subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
        request: () => Promise.resolve(null as never),
        respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
        publishWithHeaders: () => Promise.resolve(),
        subscribeWithHeaders: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
        requestWithHeaders: () => Promise.resolve(null as never),
        isReady: () => true,
        reachability: () => new Promise<boolean>(() => {}), // never settles
        isHealthy: () => new Promise<boolean>(() => {}),
      };
      const { ctx, indicators } = makeContext(manual.runtime);
      await MessagingPlugin({ broker: 'custom', instance }).register(ctx);

      const pending = indicatorFor(indicators);
      // Fire the deadline timer the bound armed.
      manual.advance(2_000);
      manual.fireTimers();
      const result = await pending;
      expect(result.status).toBe('up');
      expect(result.data).toEqual({ broker: 'custom', reachable: 'unknown' });
    });

    it('two polls inside the TTL issue ONE probe call', async () => {
      const manual = makeManualRuntime();
      const calls = { count: 0 };
      const instance = {
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        publish: () => Promise.resolve(),
        subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
        request: () => Promise.resolve(null as never),
        respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
        publishWithHeaders: () => Promise.resolve(),
        subscribeWithHeaders: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
        requestWithHeaders: () => Promise.resolve(null as never),
        isReady: () => true,
        reachability: () => {
          calls.count++;
          return Promise.resolve(true);
        },
        isHealthy: () => Promise.resolve(true),
      };
      const { ctx, indicators } = makeContext(manual.runtime);
      await MessagingPlugin({ broker: 'custom', instance }).register(ctx);

      await indicatorFor(indicators);
      await indicatorFor(indicators);
      // Both answered from the one cached outcome.
      expect(calls.count).toBe(1);

      // Past the TTL the probe is consulted again.
      manual.advance(5_001);
      await indicatorFor(indicators);
      expect(calls.count).toBe(2);
    });
  });
});
