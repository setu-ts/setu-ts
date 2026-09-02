/**
 * Job registration arms (M86 §3.5) — `SchedulerPlugin({ jobs })` and
 * `SchedulerPlugin({ behaviors })`, each accepting instances or
 * `RegistryFactory` entries, split once at construction with factories
 * resolved in `onInit` under the DECLARED-array index. The `trigger` union
 * dispatches to `cron`/`every`/`delay`; a cron entry without an `expression`
 * is a compile error; and the Cloudflare Workers refusal precedes any entry
 * read.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IIngressBehavior,
  IngressContext,
  IPluginContext,
  IScheduler,
  IServiceRegistry,
  RegistryFactory,
} from '@setu-ts/common';
import { SchedulerPlugin } from '../../src/plugin/scheduler-plugin.ts';
import { SchedulerUnavailableError } from '../../src/errors.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';
// Declared against the BARREL, not the interfaces module: dropping the export
// from `src/index.ts` must fail this file's type-check (the M56 defect class).
import type { SchedulerJobDefinition, SchedulerPluginOptions } from '../../src/index.ts';

/** Interval used by every `every` job under test (grid-aligned fires). */
const TICK_MS = 100;
/** One `every` fire lands within this advance. */
const ONE_FIRE_MS = 200;
/** The earliest minute boundary a `'* * * * *'` cron can reach from start. */
const CRON_FIRE_MS = 45_000;

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly runtime: FakeRuntime;
  /** The `onInit` hooks the plugin registered, in registration order. */
  readonly initHooks: (() => void | Promise<void>)[];
}

function createHarness(platform: 'deno' | 'cloudflare-workers' = 'deno'): Harness {
  const registered = new Map<string, unknown>();
  const initHooks: (() => void | Promise<void>)[] = [];
  const runtime = new FakeRuntime();
  const platformRuntime = platform === 'deno'
    ? runtime
    : Object.create(runtime, { platform: { value: () => platform } });

  const ctx = {
    runtime: platformRuntime,
    logger: undefined,
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => {
        const found = registered.get(token);
        if (found === undefined) {
          throw new Error(`no service for ${token}`);
        }
        return found as T;
      },
      register: <T>(token: string, service: T): void => {
        registered.set(token, service);
      },
    },
    health: {
      register: (_name: string, _check: () => Promise<HealthCheckResult>): void => {},
    },
    lifecycle: {
      onClose: (_hook: () => void | Promise<void>): void => {},
      onInit: (hook: () => void | Promise<void>): void => {
        initHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;

  return { ctx, registered, runtime, initHooks };
}

interface Boot {
  readonly harness: Harness;
  readonly scheduler: IScheduler;
  readonly runtime: FakeRuntime;
}

async function boot(options?: SchedulerPluginOptions): Promise<Boot> {
  const harness = createHarness();
  const plugin = SchedulerPlugin({ ...(options ?? {}) });
  await plugin.register(harness.ctx);
  const service = harness.registered.get('scheduler');
  if (service === undefined) {
    throw new Error('plugin did not register the scheduler service');
  }
  return { harness, scheduler: service as IScheduler, runtime: harness.runtime };
}

/** Runs the plugin's `onInit` hooks, as the kernel does during `start()`. */
async function runInitHooks(harness: Harness): Promise<void> {
  for (const hook of harness.initHooks) {
    await hook();
  }
}

/** A factory that throws — the entry a mixed array must attribute by index. */
function jobFactoryThatThrows(_services: IServiceRegistry): SchedulerJobDefinition {
  throw new Error('registry exploded');
}

/** A behavior factory that throws, for the behaviors-arm label assertion. */
function behaviorFactoryThatThrows(_services: IServiceRegistry): IIngressBehavior {
  throw new Error('behavior exploded');
}

/** A pass-through recorder behaviour. */
function recorder(log: string[], label: string): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      void ctx;
      log.push(label);
      return next();
    },
  };
}

/** An `every` definition recording its delivered job names. */
function everyDefinition(
  into: string[],
  name: string,
  intervalMs = TICK_MS,
): SchedulerJobDefinition {
  return {
    trigger: 'every',
    name,
    intervalMs,
    handler: (job) => {
      into.push(job.name);
    },
  };
}

describe('SchedulerPlugin({ jobs }) registration arms', () => {
  it('registers an instance entry at register() timing, with no onInit hook', async () => {
    const delivered: string[] = [];
    const { harness, runtime } = await boot({
      jobs: [everyDefinition(delivered, 'instance-job')],
    });

    // Instance timing: no init hook exists, and the job already answers.
    expect(harness.initHooks).toHaveLength(0);
    await runtime.advance(ONE_FIRE_MS);
    expect(delivered).toEqual(['instance-job']);
  });

  it('the trigger union dispatches to cron, every, and delay', async () => {
    const delivered: string[] = [];
    const { runtime } = await boot({
      jobs: [
        {
          trigger: 'cron',
          name: 'cron-job',
          expression: '* * * * *',
          handler: (job) => {
            delivered.push(job.name);
          },
        },
        everyDefinition(delivered, 'every-job'),
        {
          trigger: 'delay',
          name: 'delay-job',
          delayMs: TICK_MS,
          handler: (job) => {
            delivered.push(job.name);
          },
        },
      ],
    });

    // The every and delay timers fire within this advance.
    await runtime.advance(ONE_FIRE_MS);
    expect(delivered.sort()).toEqual(['delay-job', 'every-job']);

    // The cron job fires at the next minute boundary (the recurring `every`
    // job keeps firing through this advance, so assert containment).
    await runtime.advance(CRON_FIRE_MS);
    expect(delivered).toContain('cron-job');
    expect(delivered).toContain('delay-job');
    expect(delivered).toContain('every-job');
  });

  it('carries data and retry onto the registration, exactly as the imperative call', async () => {
    const payloads: unknown[] = [];
    const { runtime } = await boot({
      jobs: [
        {
          trigger: 'every',
          name: 'payload-job',
          intervalMs: TICK_MS,
          handler: (job) => {
            payloads.push(job.data);
          },
          data: { n: 7 },
        },
      ],
    });

    await runtime.advance(ONE_FIRE_MS);
    expect(payloads).toEqual([{ n: 7 }]);
  });

  it('resolves a RegistryFactory entry in onInit with the application registry', async () => {
    let received: IServiceRegistry | undefined;
    const delivered: string[] = [];
    const factory: RegistryFactory<SchedulerJobDefinition> = (services) => {
      received = services;
      return everyDefinition(delivered, 'factory-job');
    };
    const { harness, runtime } = await boot({ jobs: [factory] });

    // Not registered before onInit — the factory has not run yet.
    await runtime.advance(ONE_FIRE_MS);
    expect(delivered).toEqual([]);

    // Exactly one hook was registered, and it received the registry.
    expect(harness.initHooks).toHaveLength(1);
    await runInitHooks(harness);
    expect(received).toBe(harness.ctx.services);

    await runtime.advance(ONE_FIRE_MS);
    expect(delivered).toEqual(['factory-job']);
  });

  it('registers instance and factory entries alongside an imperative every()', async () => {
    const delivered: string[] = [];
    const { harness, scheduler, runtime } = await boot({
      jobs: [
        everyDefinition(delivered, 'instance-job'),
        (_services): SchedulerJobDefinition => everyDefinition(delivered, 'factory-job'),
      ],
    });
    await runInitHooks(harness);
    await scheduler.every('manual-job', TICK_MS, (job) => {
      delivered.push(job.name);
    });

    await runtime.advance(ONE_FIRE_MS);
    expect(delivered.sort()).toEqual(['factory-job', 'instance-job', 'manual-job']);
  });

  it('rejects onInit naming the DECLARED index when a mixed jobs array has a throwing factory', async () => {
    const delivered: string[] = [];
    const { harness, runtime } = await boot({
      jobs: [
        everyDefinition(delivered, 'instance-job'),
        jobFactoryThatThrows,
      ],
    });

    // Index 0 is an instance and registered before the failure.
    await runtime.advance(ONE_FIRE_MS);
    expect(delivered).toEqual(['instance-job']);

    // The label names index 1 — the DECLARED position, not the 0th factory.
    await expect(runInitHooks(harness)).rejects.toThrow('SchedulerPlugin({ jobs })[1]');
    await expect(runInitHooks(harness)).rejects.toThrow('registry exploded');
  });

  it('a cron entry without an expression is a COMPILE error (self-validating)', () => {
    const definitions: readonly SchedulerJobDefinition[] = [
      // @ts-expect-error — `expression` is REQUIRED on the cron arm: without
      // this check the union would accept a job that silently never fires.
      { trigger: 'cron', name: 'broken', handler: (): void => {} },
    ];
    expect(definitions).toHaveLength(1);
  });
});

describe('SchedulerPlugin({ behaviors }) registration arms', () => {
  it('rejects onInit naming the DECLARED index when a mixed behaviors array has a throwing factory', async () => {
    const { harness } = await boot({
      behaviors: [recorder([], 'instance'), behaviorFactoryThatThrows],
    });

    await expect(runInitHooks(harness)).rejects.toThrow('SchedulerPlugin({ behaviors })[1]');
    await expect(runInitHooks(harness)).rejects.toThrow('behavior exploded');
  });

  it('hands behavior instances to the chain at register() with no onInit hook', async () => {
    const envelopes: IngressContext[] = [];
    const behavior: IIngressBehavior = {
      handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
        envelopes.push(ctx);
        return next();
      },
    };
    const { harness, scheduler, runtime } = await boot({ behaviors: [behavior] });
    await scheduler.every('echo', TICK_MS, () => {});

    // Instances need no resolution, so no lifecycle hook is registered at all.
    expect(harness.initHooks).toHaveLength(0);

    await runtime.advance(ONE_FIRE_MS);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.kind).toBe('scheduler');
    expect(envelopes[0]?.name).toBe('echo');
  });

  it('appends factory-resolved behaviors to the chain in onInit, after the instances', async () => {
    const order: string[] = [];
    const { harness, scheduler, runtime } = await boot({
      behaviors: [
        recorder(order, 'instance'),
        (_services): IIngressBehavior => recorder(order, 'factory'),
      ],
    });
    await scheduler.every('echo', TICK_MS, () => {});
    await runInitHooks(harness);

    await runtime.advance(ONE_FIRE_MS);

    expect(order).toEqual(['instance', 'factory']);
  });
});

describe('SchedulerPlugin Workers refusal precedes any entry read (M86 §4.1)', () => {
  it('refuses registration before reading any jobs or behaviors entry', async () => {
    const harness = createHarness('cloudflare-workers');
    let jobsFactoryRan = false;
    let behaviorsFactoryRan = false;

    const plugin = SchedulerPlugin({
      jobs: [
        (_services): SchedulerJobDefinition => {
          jobsFactoryRan = true;
          return everyDefinition([], 'never');
        },
      ],
      behaviors: [
        (_services): IIngressBehavior => {
          behaviorsFactoryRan = true;
          return recorder([], 'never');
        },
      ],
    });

    let failure: unknown;
    try {
      await plugin.register(harness.ctx);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SchedulerUnavailableError);
    // No entry was read: neither factory ran, nothing registered, and no
    // `onInit` hook exists that could touch a factory entry later.
    expect(jobsFactoryRan).toBe(false);
    expect(behaviorsFactoryRan).toBe(false);
    expect(harness.registered.size).toBe(0);
    expect(harness.initHooks).toHaveLength(0);
  });
});
