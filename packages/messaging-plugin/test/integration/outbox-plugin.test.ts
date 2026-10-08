/**
 * The outbox wired through a REAL kernel application (M107 §3.4, §3.8, §3.11,
 * §3.14): `createApplication` with the real `SchedulerPlugin`, the real
 * memory `DatabasePlugin` and its outbox bridge, and the default in-memory
 * broker (or a recording custom broker where a hang must be controlled).
 *
 * Covers registration, the `verify()` refusal failing `start()`, a scheduled
 * sweep publishing, `relay: { schedule: false }`, the unscheduled refusal,
 * the scheduled purge, the shutdown drain finishing before ANY close hook, the
 * idempotent close path after a failed start, and the indicator and metrics
 * through the real health and metrics plugins.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ILogger,
  IMessageBroker,
  IMetricsService,
  IOutboxStore,
  IPlugin,
  IPluginContext,
  IScheduler,
  IServiceRegistry,
  ScheduledJob,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createDatabaseOutboxStore, DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { createMockPlugin } from '@setu-ts/testing';

import {
  MessagingPlugin,
  OutboxRelayUnscheduledError,
  OutboxStoreVerifyTimeoutError,
} from '../../src/index.ts';
import type { IOutbox, MessagingPluginOptions, OutboxOptions } from '../../src/index.ts';
import { FakeOutboxBroker, FaultStore, orderPlaced } from '../fixtures/outbox.ts';

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Lets timers and dispatch work run before an absence is asserted. */
function settle(ms = 120): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A recording logger honoring the real `ILogger` contract. */
function recordingLogger(): { logger: ILogger; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: ILogger = {
    level: 'info',
    fatal: () => {},
    error: (message) => errors.push(message),
    warn: (message) => warnings.push(message),
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => logger,
  };
  return { logger, warnings, errors };
}

/** The bridge, wrapped so a test can fault or observe it; the wrapper is captured. */
function capturedStore(): {
  entry: (services: IServiceRegistry) => IOutboxStore;
  store: () => FaultStore;
  resolved: () => boolean;
} {
  let store: FaultStore | undefined;
  return {
    entry: (services) => (store = new FaultStore(createDatabaseOutboxStore()(services))),
    store: () => {
      if (store === undefined) throw new Error('the store factory was never resolved');
      return store;
    },
    resolved: () => store !== undefined,
  };
}

/** Builds an app: runtime, scheduler (unless omitted), memory database, messaging. */
function buildApp(opts: {
  outbox: OutboxOptions;
  scheduler?: boolean;
  messaging?: Record<string, unknown>;
  extra?: IPlugin[];
  before?: IPlugin[];
}): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      ...(opts.before ?? []),
      ...(opts.scheduler === false ? [] : [SchedulerPlugin()]),
      DatabasePlugin({ type: 'memory' }),
      MessagingPlugin({ ...opts.messaging, outbox: opts.outbox } as MessagingPluginOptions),
      ...(opts.extra ?? []),
    ],
  });
}

/** Writes one order event in its own transaction. */
function writeOrder(app: IKernelApplication, n: number, token: string = CAPABILITIES.OUTBOX) {
  const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
  const outbox = app.services.get<IOutbox>(token);
  return db.transaction((uow) => outbox.write(uow, orderPlaced, { n }));
}

/** Every stored outbox row. */
function rows(app: IKernelApplication): Promise<Record<string, unknown>[]> {
  return app.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
    .getRepository<Record<string, unknown>, string>('Outbox').findAll({});
}

describe('MessagingPlugin outbox wiring', () => {
  it('registers IOutbox under CAPABILITIES.OUTBOX and a scheduled sweep publishes a written row', async () => {
    const app = buildApp({
      outbox: { store: createDatabaseOutboxStore(), relay: { intervalMs: 20 } },
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const received: unknown[] = [];
      await broker.subscribe(orderPlaced.topic, (message) => {
        received.push(message);
      });
      const id = await writeOrder(app, 7);
      await waitFor(() => received.length === 1, 'the relayed event');
      expect((received[0] as { id: string; data: { n: number } }).id).toBe(id);
      expect((received[0] as { data: { n: number } }).data.n).toBe(7);
      const [stored] = await rows(app);
      expect(stored!.status).toBe('sent');
      expect(String(stored!.sentBy)).toMatch(/\/scheduled$/);
      // Both jobs are scheduled under their documented names.
      const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
      await expect(scheduler.getNextRun('outbox-relay')).resolves.toBeGreaterThan(0);
      await expect(scheduler.getNextRun('outbox-purge')).resolves.toBeGreaterThan(0);
    } finally {
      await app.stop();
    }
  });

  it('adds no capability, hook or ordering edge without the outbox option', () => {
    const plugin = MessagingPlugin();
    expect(plugin.provides).toEqual([CAPABILITIES.MESSAGING]);
    expect(plugin.optionalDependencies).toEqual(['logger', CAPABILITIES.TELEMETRY]);
    const withOutbox = MessagingPlugin({ outbox: { store: createDatabaseOutboxStore() } });
    expect(withOutbox.provides).toEqual([CAPABILITIES.MESSAGING, CAPABILITIES.OUTBOX]);
    expect(withOutbox.optionalDependencies).toEqual([
      'logger',
      CAPABILITIES.TELEMETRY,
      CAPABILITIES.SCHEDULER,
      CAPABILITIES.METRICS,
    ]);
  });

  it('validates the outbox options when MessagingPlugin(...) is called', () => {
    expect(() =>
      MessagingPlugin({
        outbox: { store: createDatabaseOutboxStore(), relay: { intervalMs: Number.NaN } },
      })
    ).toThrow('outbox: relay.intervalMs must be an integer');
  });

  it('a named instance registers outbox.<name> and names its jobs after it', async () => {
    const app = buildApp({
      outbox: { store: createDatabaseOutboxStore() },
      messaging: { name: 'billing' },
    });
    await app.start();
    try {
      expect(app.services.has('outbox.billing')).toBe(true);
      expect(app.services.has(CAPABILITIES.OUTBOX)).toBe(false);
      const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
      await expect(scheduler.getNextRun('outbox-relay.billing')).resolves.toBeGreaterThan(0);
      await expect(scheduler.getNextRun('outbox-purge.billing')).resolves.toBeGreaterThan(0);
    } finally {
      await app.stop();
    }
  });

  it('a verify() refusal fails start(), and the close path drains and disconnects', async () => {
    const refusal = new Error('the outbox entity is missing or unreadable');
    const store = capturedStore();
    const broker = new RecordingBroker();
    const app = buildApp({
      outbox: {
        store: (services) => {
          const wrapped = store.entry(services) as FaultStore;
          wrapped.faults.verify = () => {
            throw refusal;
          };
          return wrapped;
        },
      },
      messaging: { broker: 'custom', instance: broker },
    });
    await expect(app.start()).rejects.toBe(refusal);
    expect(store.store().count('verify')).toBe(1);
    // verify ran before activation: nothing else reached the store.
    expect(store.store().calls.map((c) => c.method)).toEqual(['verify']);
    expect(broker.events).toContain('disconnect');
  });

  it('a verify() that never settles fails start() with OutboxStoreVerifyTimeoutError', async () => {
    // A database that accepts the connection and never answers. Without the
    // bound, start() would wait on the driver's own timeout — none for `pg`.
    const store = capturedStore();
    const broker = new RecordingBroker();
    const app = buildApp({
      outbox: {
        store: (services) => {
          const wrapped = store.entry(services) as FaultStore;
          wrapped.faults.verify = () => new Promise<void>(() => {});
          return wrapped;
        },
        relay: { storeTimeoutMs: 50 },
      },
      messaging: { broker: 'custom', instance: broker },
    });
    const refusal = await app.start().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OutboxStoreVerifyTimeoutError);
    expect((refusal as OutboxStoreVerifyTimeoutError).timeoutMs).toBe(50);
    expect((refusal as Error).message).toContain('relay.storeTimeoutMs');
    // Nothing past verify reached the store, and the close path still ran.
    expect(store.store().calls.map((c) => c.method)).toEqual(['verify']);
    expect(broker.events).toContain('disconnect');
  });

  it('with no scheduler, start() rejects OutboxRelayUnscheduledError before any store I/O', async () => {
    const store = capturedStore();
    const app = buildApp({ outbox: { store: store.entry }, scheduler: false });
    await expect(app.start()).rejects.toBeInstanceOf(OutboxRelayUnscheduledError);
    // The factory was never resolved: the refusal precedes store resolution.
    expect(store.resolved()).toBe(false);
  });

  it('relay: { schedule: false } needs no scheduler and sweeps only when asked', async () => {
    const app = buildApp({
      outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false } },
      scheduler: false,
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const received: unknown[] = [];
      await broker.subscribe(orderPlaced.topic, (message) => {
        received.push(message);
      });
      await writeOrder(app, 1);
      await settle();
      expect(received).toEqual([]);
      const result = await app.services.get<IOutbox>(CAPABILITIES.OUTBOX).sweep();
      expect(result.published).toBe(1);
      await waitFor(() => received.length === 1, 'the swept event');
    } finally {
      await app.stop();
    }
  });

  it('schedules the purge job on purgeIntervalMs, which deletes settled rows', async () => {
    const app = buildApp({
      outbox: {
        store: createDatabaseOutboxStore(),
        relay: { intervalMs: 20 },
        retainSentMs: 1,
        purgeIntervalMs: 30,
      },
    });
    await app.start();
    try {
      await writeOrder(app, 1);
      let remaining = 1;
      const started = performance.now();
      while (remaining > 0 && performance.now() - started < 5_000) {
        await settle(20);
        remaining = (await rows(app)).length;
      }
      expect(remaining).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('the onShutdown drain finishes the in-flight sweep before ANY close hook runs', async () => {
    const order: string[] = [];
    const store = capturedStore();
    const broker = new RecordingBroker(order);
    let release!: () => void;
    broker.behaviour = () =>
      new Promise<void>((resolve) => {
        release = () => {
          order.push('publish-settled');
          resolve();
        };
      });
    const app = buildApp({
      outbox: { store: store.entry, relay: { intervalMs: 20 } },
      messaging: { broker: 'custom', instance: broker },
      // Registered BEFORE MessagingPlugin, so its close hook runs before the
      // broker's — the position DatabasePlugin's disconnect takes.
      before: [closeRecorder('earlier-close', order)],
    });
    await app.start();
    const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
    const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
    await writeOrder(app, 1);
    await waitFor(() => broker.calls.length === 1, 'the scheduled publish');
    store.store().faults.markSent = () => {
      order.push('markSent');
    };
    // Written while the sweep is held, after its page was read: still pending
    // when the drain ends, so a dispatch after stop would have work to do.
    await writeOrder(app, 2);
    const stopping = app.stop();
    await settle(50);
    // Still draining: no close hook has run while the publish is held.
    expect(order).toEqual([]);
    release();
    await stopping;
    expect(order).toEqual(['publish-settled', 'markSent', 'earlier-close', 'disconnect']);
    // The relay job is gone, and dispatch after stop does nothing.
    await expect(scheduler.getNextRun('outbox-relay')).rejects.toThrow();
    await expect(scheduler.getNextRun('outbox-purge')).rejects.toThrow();
    outbox.dispatch();
    await settle();
    expect(broker.calls.length).toBe(1);
  });

  it('a publish rejected after the drain began records no attempt', async () => {
    const store = capturedStore();
    const broker = new RecordingBroker();
    let fail!: () => void;
    broker.behaviour = () =>
      new Promise<void>((_, reject) => {
        fail = () => reject(new Error('broker shutting down'));
      });
    const app = buildApp({
      outbox: { store: store.entry, relay: { intervalMs: 20 } },
      messaging: { broker: 'custom', instance: broker },
    });
    await app.start();
    await writeOrder(app, 1);
    await waitFor(() => broker.calls.length === 1, 'the scheduled publish');
    const stopping = app.stop();
    await settle(30);
    fail();
    await stopping;
    // The sweep settled inside the drain (the publish was observed failing)
    // and wrote nothing: no attempt, no status change.
    expect(broker.calls.length).toBe(1);
    expect(store.store().count('markFailure')).toBe(0);
    expect(store.store().count('markSent')).toBe(0);
  });

  it('a later plugin failing onInit runs the idempotent close path: jobs removed, no warning', async () => {
    const { logger, warnings } = recordingLogger();
    const broker = new RecordingBroker();
    const failure = new Error('later plugin failed');
    const app = buildApp({
      outbox: { store: createDatabaseOutboxStore(), relay: { intervalMs: 1_000 } },
      messaging: { broker: 'custom', instance: broker },
      before: [createMockPlugin({ name: 'logger', service: logger })],
      extra: [failingOnInit(failure)],
    });
    let scheduler: IScheduler | undefined;
    const capture: IPlugin = {
      name: 'capture-scheduler',
      version: '0.0.0',
      optionalDependencies: [CAPABILITIES.SCHEDULER],
      register(ctx: IPluginContext) {
        scheduler = ctx.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
      },
    };
    app.register(capture);
    await expect(app.start()).rejects.toBe(failure);
    await expect(scheduler!.getNextRun('outbox-relay')).rejects.toThrow();
    await expect(scheduler!.getNextRun('outbox-purge')).rejects.toThrow();
    expect(broker.events).toContain('disconnect');
    expect(warnings).toEqual([]);
  });

  it('on a normal stop both hooks run the one drain: each job is removed once, no warning', async () => {
    const { logger, warnings } = recordingLogger();
    const app = buildApp({
      outbox: { store: createDatabaseOutboxStore() },
      before: [createMockPlugin({ name: 'logger', service: logger })],
    });
    await app.start();
    await app.stop();
    expect(warnings).toEqual([]);
  });

  it('registers the outbox indicator, read through the real /health endpoint', async () => {
    const healthApp = () =>
      buildApp({
        outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false } },
        scheduler: false,
        extra: [HealthPlugin()],
      });
    const readOutbox = async (app: IKernelApplication) => {
      const body = (await (await app.fetch(new Request('http://localhost/health'))).json()) as {
        checks: Record<string, { status: string; data?: Record<string, unknown> }>;
      };
      return body.checks['outbox'];
    };
    const healthy = healthApp();
    await healthy.start();
    try {
      expect((await readOutbox(healthy))?.status).toBe('up');
    } finally {
      await healthy.stop();
    }
    const degraded = healthApp();
    await degraded.start();
    try {
      const id = await writeOrder(degraded, 1);
      await degraded.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
        .getRepository<Record<string, unknown>, string>('Outbox').update(id, { status: 'failed' });
      const check = await readOutbox(degraded);
      expect(check?.status).toBe('degraded');
      expect(check?.data?.['reasons']).toEqual(['failed-rows']);
    } finally {
      await degraded.stop();
    }
  });

  it('pushes the published counter to the real metrics plugin, labelled by instance and topic', async () => {
    const app = buildApp({
      outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false } },
      scheduler: false,
      before: [MetricsPlugin()],
    });
    await app.start();
    try {
      await writeOrder(app, 1);
      await app.services.get<IOutbox>(CAPABILITIES.OUTBOX).sweep();
      const text = await (await app.fetch(new Request('http://localhost/metrics'))).text();
      expect(text).toContain(
        `outbox_published_total{outbox="outbox",topic="${orderPlaced.topic}"} 1`,
      );
    } finally {
      await app.stop();
    }
  });
});

describe('MessagingPlugin outbox wiring — scheduler, tenancy and reporting seams', () => {
  it('schedules the relay and purge handlers onto sweep() and purge() of the outbox', async () => {
    const scheduler = new RecordingScheduler();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        createMockPlugin({ name: CAPABILITIES.SCHEDULER, service: scheduler }),
        DatabasePlugin({ type: 'memory' }),
        MessagingPlugin({
          outbox: {
            store: createDatabaseOutboxStore(),
            relay: { intervalMs: 250 },
            purgeIntervalMs: 4_000,
            retainSentMs: 0,
          },
        }),
      ],
    });
    await app.start();
    try {
      expect([...scheduler.jobs.keys()]).toEqual(['outbox-relay', 'outbox-purge']);
      expect(scheduler.jobs.get('outbox-relay')!.intervalMs).toBe(250);
      expect(scheduler.jobs.get('outbox-purge')!.intervalMs).toBe(4_000);
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const received: unknown[] = [];
      await broker.subscribe(orderPlaced.topic, (message) => {
        received.push(message);
      });
      await writeOrder(app, 1);
      await scheduler.fire('outbox-relay');
      await waitFor(() => received.length === 1, 'the event the relay job published');
      // retainSentMs: 0 deletes at mark-sent; the purge job runs the purge.
      await scheduler.fire('outbox-purge');
      expect(await rows(app)).toEqual([]);
    } finally {
      await app.stop();
    }
    expect(scheduler.removed).toEqual(['outbox-relay', 'outbox-purge']);
  });

  it('reports a job the scheduler refuses to remove, and still completes the drain', async () => {
    const { logger, warnings } = recordingLogger();
    const scheduler = new RecordingScheduler();
    scheduler.removeFails = true;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        createMockPlugin({ name: 'logger', service: logger }),
        createMockPlugin({ name: CAPABILITIES.SCHEDULER, service: scheduler }),
        DatabasePlugin({ type: 'memory' }),
        MessagingPlugin({ outbox: { store: createDatabaseOutboxStore() } }),
      ],
    });
    await app.start();
    const outbox = app.services.get<IOutbox & { readonly closing: boolean }>(
      CAPABILITIES.OUTBOX,
    );
    await app.stop();
    expect(outbox.closing).toBe(true);
    expect(warnings).toEqual([
      'outbox: could not remove a scheduled job while draining',
      'outbox: could not remove a scheduled job while draining',
    ]);
  });

  it('a start that fails before the outbox is built runs a drain that does nothing', async () => {
    const { logger, warnings } = recordingLogger();
    const broker = new RecordingBroker();
    const refused = new Error('broker unreachable');
    broker.connect = () => Promise.reject(refused);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        createMockPlugin({ name: 'logger', service: logger }),
        SchedulerPlugin(),
        DatabasePlugin({ type: 'memory' }),
        MessagingPlugin({
          broker: 'custom',
          instance: broker,
          outbox: { store: createDatabaseOutboxStore() },
        }),
      ],
    });
    await expect(app.start()).rejects.toBe(refused);
    expect(warnings).toEqual([]);
  });

  it('resolves per-tenant stores, verifies each, and routes a write by tenant', async () => {
    const tenantA = capturedStore();
    const tenantB = capturedStore();
    const app = buildApp({
      outbox: {
        stores: { 'tenant-a': tenantA.entry, 'tenant-b': tenantB.entry },
        relay: { schedule: false },
      },
      scheduler: false,
    });
    await app.start();
    try {
      expect(tenantA.store().count('verify')).toBe(1);
      expect(tenantB.store().count('verify')).toBe(1);
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const outbox = app.services.get<IOutbox>(CAPABILITIES.OUTBOX);
      await db.transaction((uow) =>
        outbox.write(uow, orderPlaced, { n: 1 }, { tenantId: 'tenant-b' })
      );
      expect(tenantA.store().count('append')).toBe(0);
      expect(tenantB.store().count('append')).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('names a throwing per-tenant store factory by its index, never the tenant id', async () => {
    const app = buildApp({
      outbox: {
        stores: {
          'tenant-a': createDatabaseOutboxStore(),
          'secret-tenant': () => {
            throw new Error('factory broke');
          },
        },
        relay: { schedule: false },
      },
      scheduler: false,
    });
    const error = await app.start().then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toContain('MessagingPlugin({ outbox: { stores } })[1]');
    expect(error?.message.includes('secret-tenant')).toBe(false);
  });

  it('reports a failing metrics write through the logger, read at call time', async () => {
    const { logger, warnings } = recordingLogger();
    const app = buildApp({
      outbox: { store: createDatabaseOutboxStore(), relay: { schedule: false } },
      scheduler: false,
      before: [
        createMockPlugin({ name: 'logger', service: logger }),
        createMockPlugin({ name: CAPABILITIES.METRICS, service: refusingMetrics() }),
      ],
    });
    await app.start();
    try {
      await writeOrder(app, 1);
      const result = await app.services.get<IOutbox>(CAPABILITIES.OUTBOX).sweep();
      expect(result.published).toBe(1);
      expect(warnings).toEqual(['outbox metrics write failed']);
    } finally {
      await app.stop();
    }
  });

  it('logs a dispatched sweep that fails through the plugin logger', async () => {
    const { logger, errors } = recordingLogger();
    const app = buildApp({
      outbox: {
        store: createDatabaseOutboxStore(),
        relay: { schedule: false },
        background: () => {
          throw new Error('background hook broke');
        },
      },
      scheduler: false,
      before: [createMockPlugin({ name: 'logger', service: logger })],
    });
    await app.start();
    try {
      app.services.get<IOutbox>(CAPABILITIES.OUTBOX).dispatch();
      expect(errors).toEqual(['outbox: a dispatched sweep failed']);
      await settle(30);
    } finally {
      await app.stop();
    }
  });
});

/** A scheduler recording `every`/`remove`, whose jobs fire only when a test asks. */
class RecordingScheduler implements IScheduler {
  readonly jobs = new Map<string, { intervalMs: number; handler: () => void | Promise<void> }>();
  readonly removed: string[] = [];
  removeFails = false;

  every<T>(
    name: string,
    intervalMs: number,
    handler: (job: ScheduledJob<T>) => void | Promise<void>,
  ): Promise<void> {
    const job = { name } as ScheduledJob<T>;
    this.jobs.set(name, { intervalMs, handler: () => handler(job) });
    return Promise.resolve();
  }

  /** Runs one job's handler, as a fire would. */
  async fire(name: string): Promise<void> {
    await this.jobs.get(name)!.handler();
  }

  remove(name: string): Promise<void> {
    if (this.removeFails) return Promise.reject(new Error(`cannot remove ${name}`));
    this.removed.push(name);
    return Promise.resolve();
  }

  cron(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }
  delay(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }
  pause(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }
  resume(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }
  getNextRun(): Promise<number> {
    return Promise.reject(new Error('not used'));
  }
}

/** A metrics service whose every instrument write throws. */
function refusingMetrics(): IMetricsService {
  const refuse = (): never => {
    throw new Error('metrics backend refused');
  };
  const instrument = { inc: refuse, set: refuse, dec: refuse, observe: refuse };
  return {
    counter: () => instrument,
    gauge: () => instrument,
    histogram: () => instrument,
    summary: () => instrument,
    render: () => '',
  } as unknown as IMetricsService;
}

/** A custom broker recording publishes and lifecycle events. */
class RecordingBroker extends FakeOutboxBroker {
  readonly events: string[];

  constructor(events: string[] = []) {
    super();
    this.events = events;
  }

  override disconnect(): Promise<void> {
    this.events.push('disconnect');
    return Promise.resolve();
  }
}

/** A plugin whose close hook records a marker. */
function closeRecorder(marker: string, order: string[]): IPlugin {
  return {
    name: `close-recorder-${marker}`,
    version: '0.0.0',
    register(ctx: IPluginContext) {
      ctx.lifecycle.onClose(() => {
        order.push(marker);
      });
    },
  };
}

/** A plugin ordered after the outbox whose `onInit` fails. */
function failingOnInit(error: Error): IPlugin {
  return {
    name: 'failing-on-init',
    version: '0.0.0',
    optionalDependencies: [CAPABILITIES.OUTBOX],
    register(ctx: IPluginContext) {
      ctx.lifecycle.onInit(() => {
        throw error;
      });
    },
  };
}
