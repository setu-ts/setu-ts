import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IAdapterTransaction,
  IDataSource,
  IPluginContext,
  IRuntimeServices,
  TimerHandle,
} from '@setu-ts/common';
import type { IDatabaseAdapter } from '@setu-ts/common';
import { DatabasePlugin } from '../../src/index.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import { FakeMongoClient } from '../fixtures/fake-mongo-client.ts';

function emptySource(): IDataSource {
  return {
    findAll: () => Promise.resolve([]),
    findById: () => Promise.resolve(null),
    create: (data) => Promise.resolve({ ...data } as Record<string, unknown>),
    update: (_id, data) => Promise.resolve({ ...data } as Record<string, unknown>),
    delete: () => Promise.resolve(true),
    count: () => Promise.resolve(0),
  };
}

function emptyTx(): IAdapterTransaction {
  return {
    createDataSource: () => emptySource(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
  };
}

/**
 * A custom adapter whose probe the test controls. Hoisted into a variable
 * and conditionally widened — an adapter with NO `isHealthy?()` is its own
 * test row, not an `undefined` assignment (`exactOptionalPropertyTypes`).
 */
function makeAdapter(probe?: () => Promise<boolean>): IDatabaseAdapter {
  const adapter: IDatabaseAdapter = {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    isReady: () => true,
    createDataSource: () => emptySource(),
    beginTransaction: () => Promise.resolve(emptyTx()),
    rawQuery: () => Promise.resolve([]),
  };
  if (probe !== undefined) {
    adapter.isHealthy = probe;
  }
  return adapter;
}

/**
 * Runtime with a MANUALLY advanced monotonic clock and MANUALLY fired
 * timers, so the 2 s probe bound is driven by the test rather than the wall
 * clock.
 */
function makeManualRuntime(): {
  runtime: IRuntimeServices;
  advance: (ms: number) => void;
  fireTimers: () => void;
} {
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const runtime: IRuntimeServices = {
    platform: () => 'deno' as const,
    version: () => 'test',
    now: () => 0,
    hrtime: () => clock,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: clock + ms, fn });
      return { manual: timers.length } as unknown as TimerHandle;
    },
    clearTimeout: (_handle: TimerHandle) => {},
    setInterval: (fn: () => void, ms: number) => {
      timers.push({ at: clock + ms, fn });
      return { manual: timers.length } as unknown as TimerHandle;
    },
    clearInterval: (_handle: TimerHandle) => {},
    uuid: () => 'u',
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as SubtleCrypto,
    env: {},
    exit: () => {
      throw new Error('exit');
    },
    hostname: () => 'localhost',
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
  services: Map<string, unknown>;
} {
  const indicators = new Map<string, unknown>();
  const services = new Map<string, unknown>();
  const ctx: IPluginContext = {
    services: {
      has: (token: string) => services.has(token),
      get: <T>(token: string): T => services.get(token) as T,
      getAll: <T>(_: string): readonly T[] => [],
      register: (token: string, service: unknown) => {
        services.set(token, service);
      },
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
    runtime: runtime ?? makeManualRuntime().runtime,
    options: {},
    app: null as unknown as IPluginContext['app'],
  };
  return { ctx, indicators, services };
}

async function indicatorFor(
  indicators: Map<string, unknown>,
): Promise<{ status: string; data?: Record<string, unknown> }> {
  const indicator = indicators.get(CAPABILITIES.DATABASE) as () => Promise<{
    status: string;
    data?: Record<string, unknown>;
  }>;
  return await indicator();
}

describe('DatabasePlugin reachability indicator mapping (M95b §3.5)', () => {
  it('(a) a probe resolving true reports up with reachable true', async () => {
    const { ctx, indicators } = makeContext();
    await DatabasePlugin({
      type: 'custom',
      adapter: makeAdapter(() => Promise.resolve(true)),
    }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ adapter: 'custom', name: 'default', reachable: true });
  });

  it('(b) a probe resolving false reports down with reachable false', async () => {
    const { ctx, indicators } = makeContext();
    await DatabasePlugin({
      type: 'custom',
      adapter: makeAdapter(() => Promise.resolve(false)),
    }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('down');
    expect(result.data).toEqual({ adapter: 'custom', name: 'default', reachable: false });
  });

  it('(c) a probe that EXISTS and never settles reports degraded — and the poll SETTLES', async () => {
    // The X51-1 half that is worse than a wrong answer: a probe that hangs
    // must not hold `/health` open, and must never read `up` for a backend
    // it cannot vouch for. `degraded` fails `/ready`
    // (`status === 'up' ? 200 : 503` at health-plugin.ts:214).
    const manual = makeManualRuntime();
    const { ctx, indicators } = makeContext(manual.runtime);
    await DatabasePlugin({
      type: 'custom',
      adapter: makeAdapter(() => new Promise<boolean>(() => {})),
    }).register(ctx);
    const pending = indicatorFor(indicators);
    manual.advance(2_000);
    manual.fireTimers();
    const result = await pending;
    expect(result.status).toBe('degraded');
    expect(result.data).toEqual({ adapter: 'custom', name: 'default', reachable: 'unknown' });
  });

  it('(d) an adapter with NO probe reports up with reachable OMITTED', async () => {
    // The deliberate no-change row: a probe that was never written is
    // evidence of nothing. Mapping it to `degraded` would answer 503 for a
    // healthy backend — draining every probe-less application on upgrade.
    const { ctx, indicators } = makeContext();
    await DatabasePlugin({ type: 'custom', adapter: makeAdapter() }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('up');
    expect('reachable' in (result.data as Record<string, unknown>)).toBe(false);
  });

  it('(e) a Mongo adapter whose facade omits command() lands in (d), not a throw', async () => {
    // FakeMongoDatabase declares collection() only — no command? — so the
    // adapter assigns no probe and the indicator takes the no-change row.
    const { ctx, indicators } = makeContext();
    await DatabasePlugin({
      type: 'mongodb',
      options: { client: new FakeMongoClient(), database: 'test' },
    }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('up');
    expect('reachable' in (result.data as Record<string, unknown>)).toBe(false);
  });

  it('(f) the lifecycle gate still wins after close()', async () => {
    const { ctx, indicators, services } = makeContext();
    await DatabasePlugin({
      type: 'custom',
      adapter: makeAdapter(() => Promise.resolve(true)),
    }).register(ctx);
    const service = services.get(CAPABILITIES.DATABASE) as { close(): Promise<void> };
    await service.close();
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('down');
  });

  it('the memory adapter carries a probe that resolves true', async () => {
    const { ctx, indicators } = makeContext();
    await DatabasePlugin({ type: 'memory' }).register(ctx);
    const result = await indicatorFor(indicators);
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ adapter: 'memory', name: 'default', reachable: true });
  });
});

describe('DatabaseService reachability seam (M95b §3.5)', () => {
  it('hasReachabilityProbe reads adapter presence both ways', () => {
    const withProbe = new DatabaseService(
      makeAdapter(() => Promise.resolve(true)),
      () => emptySource(),
      'custom',
    );
    const withoutProbe = new DatabaseService(makeAdapter(), () => emptySource(), 'custom');
    expect(withProbe.hasReachabilityProbe).toBe(true);
    expect(withoutProbe.hasReachabilityProbe).toBe(false);
  });

  it('reachability() resolves the probe answer', async () => {
    const service = new DatabaseService(
      makeAdapter(() => Promise.resolve(false)),
      () => emptySource(),
      'custom',
    );
    expect(await service.reachability()).toBe(false);
  });

  it('reachability() resolves undefined for a probe-less adapter', async () => {
    const service = new DatabaseService(makeAdapter(), () => emptySource(), 'custom');
    expect(await service.reachability()).toBeUndefined();
  });

  it('reachability() resolves undefined when the probe never settles — deterministically', async () => {
    const manual = makeManualRuntime();
    const service = new DatabaseService(
      makeAdapter(() => new Promise<boolean>(() => {})),
      () => emptySource(),
      'custom',
      undefined,
      undefined,
      () => 0,
      manual.runtime.setTimeout,
      manual.runtime.clearTimeout,
    );
    const pending = service.reachability();
    manual.advance(2_000);
    manual.fireTimers();
    expect(await pending).toBeUndefined();
  });

  it('reachability() resolves undefined when the probe rejects', async () => {
    const service = new DatabaseService(
      makeAdapter(() => Promise.reject(new Error('driver exploded'))),
      () => emptySource(),
      'custom',
    );
    expect(await service.reachability()).toBeUndefined();
  });

  it('the PLUGIN arms the bound on the INJECTED runtime timers (code-review fix)', async () => {
    // The M51b defect class, caught in review: the plugin constructed the
    // service WITHOUT the timer arms, so the production bound armed on
    // wall-clock globals while the same indicator's two cached probes ran
    // on ctx.runtime — a two-clock mix, and a runtime whose timers are
    // manually advanced (this fake) could not bound the plugin path at
    // all. Discriminator: against a never-settling probe, the bound may
    // only fire from the INJECTED fake's timers — if the bound is on
    // globals, fireTimers() is a no-op and the pending promise never
    // settles, which fails the race below instead of hanging the suite.
    const manual = makeManualRuntime();
    const { ctx, services } = makeContext(manual.runtime);
    await DatabasePlugin({
      type: 'custom',
      adapter: makeAdapter(() => new Promise<boolean>(() => {})),
    }).register(ctx);

    const service = services.get(CAPABILITIES.DATABASE) as {
      reachability(): Promise<boolean | undefined>;
    };
    const pending = service.reachability();

    // Drain microtasks: the probe has been called and the bound armed, so
    // nothing may have settled yet.
    let settled: string | undefined;
    void pending.then(() => {
      settled = 'settled';
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBeUndefined();

    // Fire the INJECTED timer: the bound answers through it.
    manual.advance(2_000);
    manual.fireTimers();
    const result = await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'never-fired'>((resolve) => setTimeout(() => resolve('never-fired'), 250)),
    ]);
    expect(result).toBe('settled');
    expect(await pending).toBeUndefined();
  });
});
