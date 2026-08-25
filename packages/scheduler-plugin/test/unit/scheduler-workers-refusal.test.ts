/**
 * X9-2: `SchedulerPlugin.register()` refuses Cloudflare Workers.
 *
 * The plugin's entire surface is inert there — `every` and `delay` arm timers
 * on an isolate that is evicted between invocations — so registering it could
 * only produce a job that never runs and reports nothing. The refusal follows
 * messaging-plugin's `assertNotCloudflareWorkers` precedent and runs FIRST,
 * before any lock is resolved or connected.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthIndicatorFn, IPluginContext } from '@setu-ts/common';
import { SchedulerPlugin } from '../../src/plugin/scheduler-plugin.ts';
import { SchedulerUnavailableError } from '../../src/errors.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

/**
 * A plugin context whose runtime reports the given platform. Shape-matched to
 * the members `register()` touches, as the sibling scheduler tests do.
 */
function contextOn(platform: () => string): {
  ctx: IPluginContext;
  registered: Map<string, unknown>;
} {
  const runtime = new FakeRuntime();
  const registered = new Map<string, unknown>();
  const ctx = {
    runtime: Object.create(runtime, {
      platform: { value: platform },
    }),
    logger: undefined,
    services: {
      register<T>(token: string, service: T) {
        registered.set(token, service);
      },
    },
    health: {
      register(_name: string, _fn: HealthIndicatorFn) {},
    },
    lifecycle: {
      onClose(_fn: () => Promise<void>) {},
    },
  };
  return { ctx: ctx as unknown as IPluginContext, registered };
}

describe('SchedulerPlugin on Cloudflare Workers (X9-2)', () => {
  it('register() throws SchedulerUnavailableError naming both replacements', async () => {
    const plugin = SchedulerPlugin();
    const { ctx, registered } = contextOn(() => 'cloudflare-workers');

    let failure: unknown;
    try {
      await plugin.register(ctx);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SchedulerUnavailableError);
    expect((failure as Error).message).toContain('WorkersCron');
    expect((failure as Error).message).toContain('[triggers] crons');
    expect((failure as SchedulerUnavailableError).platform).toBe('cloudflare-workers');
    // Nothing was wired: no scheduler capability, no half-registered state.
    expect(registered.size).toBe(0);
  });

  it('the refusal happens BEFORE any lock is resolved or connected', async () => {
    // A redis-configured lock whose client would fail loudly if the plugin
    // got as far as constructing or connecting it — the throw the test sees
    // is the platform refusal, not this one.
    const plugin = SchedulerPlugin({
      distributedLock: {
        enabled: true,
        storage: 'redis',
        client: {
          set() {
            return Promise.reject(new Error('redis must never be touched'));
          },
          quit() {
            return Promise.reject(new Error('redis must never be touched'));
          },
          eval() {
            return Promise.reject(new Error('redis must never be touched'));
          },
        },
      },
    });
    const { ctx } = contextOn(() => 'cloudflare-workers');

    await expect(plugin.register(ctx)).rejects.toBeInstanceOf(SchedulerUnavailableError);
  });

  it("a 'deno' runtime registers normally", async () => {
    const plugin = SchedulerPlugin();
    const { ctx, registered } = contextOn(() => 'deno');

    await plugin.register(ctx);

    expect(registered.has('scheduler')).toBe(true);
  });

  it('is exported from the package barrel', async () => {
    const mod = await import('../../src/index.ts');
    expect(mod.SchedulerUnavailableError).toBe(SchedulerUnavailableError);
  });
});
