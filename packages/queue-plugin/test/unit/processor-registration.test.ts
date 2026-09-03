/**
 * Processor registration arms (M86 §3.5) — `QueuePlugin({ processors })` and
 * `QueuePlugin({ behaviors })`, each accepting instances or `RegistryFactory`
 * entries, split once at construction with factories resolved in `onInit`
 * under the DECLARED-array index.
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
  IQueue,
  IServiceRegistry,
  RegistryFactory,
} from '@setu-ts/common';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
// Declared against the BARREL, not the interfaces module: dropping the export
// from `src/index.ts` must fail this file's type-check (the M56 defect class).
import type { QueuePluginOptions, QueueProcessorDefinition } from '../../src/index.ts';

/** Poll interval used by every plugin instance under test. */
const POLL_MS = 100;

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly runtime: FakeRuntimeServices;
  /** The `onInit` hooks the plugin registered, in registration order. */
  readonly initHooks: (() => void | Promise<void>)[];
}

function createHarness(): Harness {
  const registered = new Map<string, unknown>();
  const initHooks: (() => void | Promise<void>)[] = [];
  const runtime = new FakeRuntimeServices();

  const ctx = {
    runtime,
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
  readonly queue: IQueue;
  readonly runtime: FakeRuntimeServices;
}

async function boot(options?: QueuePluginOptions): Promise<Boot> {
  const harness = createHarness();
  const plugin = QueuePlugin({
    adapter: 'memory',
    pollIntervalMs: POLL_MS,
    ...(options ?? {}),
  });
  await plugin.register(harness.ctx);
  const service = harness.registered.get('queue');
  if (service === undefined) {
    throw new Error('plugin did not register the queue service');
  }
  return { harness, queue: service as IQueue, runtime: harness.runtime };
}

/** Runs the plugin's `onInit` hooks, as the kernel does during `start()`. */
async function runInitHooks(harness: Harness): Promise<void> {
  for (const hook of harness.initHooks) {
    await hook();
  }
}

/** A factory that throws — the entry a mixed array must attribute by index. */
function processorFactoryThatThrows(_services: IServiceRegistry): QueueProcessorDefinition {
  throw new Error('registry exploded');
}

/** A behavior factory that throws, for the behaviors-arm label assertion. */
function behaviorFactoryThatThrows(_services: IServiceRegistry): IIngressBehavior {
  throw new Error('behavior exploded');
}

/** A pass-through recorder behavior. */
function recorder(log: string[], label: string): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      void ctx;
      log.push(label);
      return next();
    },
  };
}

describe('QueuePlugin({ processors }) registration arms', () => {
  it('registers an instance entry at register() timing, with no onInit hook', async () => {
    const delivered: string[] = [];
    const { harness, queue, runtime } = await boot({
      processors: [
        {
          name: 'email',
          processor: (job) => {
            delivered.push(job.id);
          },
        },
      ],
    });

    // Instance timing: no init hook has run, and the processor already answers.
    expect(harness.initHooks).toHaveLength(0);
    await queue.add('email', {});
    await runtime.advanceMs(POLL_MS * 2);
    expect(delivered).toHaveLength(1);
  });

  it('resolves a RegistryFactory entry in onInit with the application registry', async () => {
    let received: IServiceRegistry | undefined;
    const delivered: string[] = [];
    const factory: RegistryFactory<QueueProcessorDefinition> = (services) => {
      received = services;
      return {
        name: 'factory-job',
        processor: (job) => {
          delivered.push(job.id);
        },
      };
    };
    const { harness, queue, runtime } = await boot({ processors: [factory] });

    // Not registered before onInit — the factory has not run yet.
    await queue.add('factory-job', {});
    await runtime.advanceMs(POLL_MS * 2);
    expect(delivered).toHaveLength(0);

    await runInitHooks(harness);
    expect(received).toBe(harness.ctx.services);

    await runtime.advanceMs(POLL_MS * 2);
    expect(delivered).toHaveLength(1);
  });

  it('registers instance and factory entries alongside an imperative process()', async () => {
    const delivered: string[] = [];
    const record = (job: { name: string }): void => {
      delivered.push(job.name);
    };
    const { harness, queue, runtime } = await boot({
      processors: [
        { name: 'instance-job', processor: record },
        (_services): QueueProcessorDefinition => ({
          name: 'factory-job',
          processor: record,
        }),
      ],
    });
    await runInitHooks(harness);
    queue.process('manual-job', record);

    for (const name of ['instance-job', 'factory-job', 'manual-job']) {
      await queue.add(name, {});
    }
    await runtime.advanceMs(POLL_MS * 2);
    expect(delivered.sort()).toEqual(['factory-job', 'instance-job', 'manual-job']);
  });

  it('rejects onInit naming the DECLARED index when a mixed processors array has a throwing factory', async () => {
    const delivered: string[] = [];
    const { harness, queue, runtime } = await boot({
      processors: [
        {
          name: 'instance-job',
          processor: (job) => {
            delivered.push(job.name);
          },
        },
        processorFactoryThatThrows,
      ],
    });

    // An array containing a FACTORY registers wholly in `onInit`, in declared
    // order, so nothing is registered yet — `process()` is last-wins on a job
    // name and registering instances first reversed the declared order (M86
    // review). The job sits in the queue rather than being delivered.
    await queue.add('instance-job', {});
    await runtime.advanceMs(POLL_MS * 2);
    expect(delivered).toEqual([]);

    // The label names index 1 — the DECLARED position, not the 0th factory.
    await expect(runInitHooks(harness)).rejects.toThrow('QueuePlugin({ processors })[1]');
    await expect(runInitHooks(harness)).rejects.toThrow('registry exploded');
  });
});

describe('QueuePlugin({ behaviors }) registration arms', () => {
  it('rejects onInit naming the DECLARED index when a mixed behaviors array has a throwing factory', async () => {
    const { harness } = await boot({
      behaviors: [recorder([], 'instance'), behaviorFactoryThatThrows],
    });

    await expect(runInitHooks(harness)).rejects.toThrow('QueuePlugin({ behaviors })[1]');
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
    const { harness, queue, runtime } = await boot({ behaviors: [behavior] });
    queue.process('echo', () => {});

    // Instances need no resolution, so no lifecycle hook is registered at all.
    expect(harness.initHooks).toHaveLength(0);

    await queue.add('echo', {});
    await runtime.advanceMs(POLL_MS * 2);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.kind).toBe('queue');
    expect(envelopes[0]?.name).toBe('echo');
  });

  it('preserves declared behavior order when a factory precedes an instance', async () => {
    const order: string[] = [];
    const { harness, queue, runtime } = await boot({
      behaviors: [
        (_services): IIngressBehavior => recorder(order, 'factory'),
        recorder(order, 'instance'),
      ],
    });
    queue.process('echo', () => {});
    await runInitHooks(harness);

    await queue.add('echo', {});
    await runtime.advanceMs(POLL_MS * 2);

    expect(order).toEqual(['factory', 'instance']);
  });
});

describe('QueuePlugin behaviour-chain startup gate', () => {
  it('holds a job reserved before onInit until the factory chain is final', async () => {
    // Registering a processor arms the poll loop, so a job already sitting in
    // a durable queue can be reserved before `onInit` resolves the factory
    // behaviours. Without the gate it would run through a PARTIAL chain,
    // skipping exactly the behaviours that needed a resolved capability.
    const seen: string[] = [];
    const delivered: string[] = [];
    const { harness, queue, runtime } = await boot({
      behaviors: [
        {
          handle: (_ctx, next) => {
            seen.push('instance');
            return next();
          },
        },
        (): IIngressBehavior => ({
          handle: (_ctx, next) => {
            seen.push('factory');
            return next();
          },
        }),
      ],
      processors: [
        {
          name: 'gated',
          processor: (job) => {
            delivered.push(job.name);
          },
        },
      ],
    });

    await queue.add('gated', {});
    await runtime.advanceMs(POLL_MS * 2);

    // Held: the chain is not final yet.
    expect(delivered).toEqual([]);
    expect(seen).toEqual([]);

    await runInitHooks(harness);
    await runtime.advanceMs(POLL_MS * 2);

    expect(delivered).toEqual(['gated']);
    expect(seen).toEqual(['instance', 'factory']);
  });

  it('fails held work when onInit fails, rather than running a partial chain', async () => {
    // The gate is never OPENED when `start()` fails — running through a
    // partial chain is the outcome it prevents — but it is REJECTED, so held
    // work fails into the queue's own retry path instead of hanging forever.
    const delivered: string[] = [];
    const { harness, queue, runtime } = await boot({
      behaviors: [behaviorFactoryThatThrows],
      processors: [
        {
          name: 'gated',
          processor: (job) => {
            delivered.push(job.name);
          },
        },
      ],
    });

    await queue.add('gated', {});
    await expect(runInitHooks(harness)).rejects.toThrow('QueuePlugin({ behaviors })[0]');
    await runtime.advanceMs(POLL_MS * 4);

    expect(delivered).toEqual([]);
  });
});
