/**
 * Integration tests for the `onStopping` lifecycle phase.
 *
 * The load-bearing property is ordering: an `onStopping` hook runs while the
 * application is still serving normally, BEFORE it starts refusing requests
 * with a 503. That is what makes it usable for deregistering from a service
 * registry, which is the whole reason the phase exists.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IPlugin, IPluginContext } from '@hono-enterprise/common';

import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A runtime plugin that also lets the test register lifecycle hooks. */
function runtimePluginWith(
  fake: ReturnType<typeof createFakeRuntime>,
  onRegister?: (ctx: IPluginContext) => void,
): IPlugin {
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, fake.adapter);
      onRegister?.(ctx);
    },
  };
}

describe('Application — onStopping', () => {
  it('runs the hook before the application starts refusing requests', async () => {
    const fake = createFakeRuntime();
    let statusDuringHook: number | null = null;

    // Referenced inside the hook, which only runs at stop() — long after this
    // binding is initialized.
    const app: ReturnType<typeof createApplication> = createApplication({
      plugins: [
        runtimePluginWith(fake, (ctx) => {
          ctx.lifecycle.onStopping(async () => {
            // Still serving: this request must NOT get the shutting-down 503.
            const response = await app.inject({
              method: 'GET',
              url: 'http://localhost/anything',
            });
            statusDuringHook = response.statusCode;
          });
        }),
      ],
    });

    await app.start({ port: 4100 });
    const stopping = app.stop();
    fake.tick(20_000);
    await stopping;

    expect(statusDuringHook).not.toBe(503);
  });

  it('runs stopping hooks before shutdown and close hooks', async () => {
    const fake = createFakeRuntime();
    const order: string[] = [];

    const app = createApplication({
      plugins: [
        runtimePluginWith(fake, (ctx) => {
          ctx.lifecycle.onStopping(() => {
            order.push('stopping');
          });
          ctx.lifecycle.onShutdown(() => {
            order.push('shutdown');
          });
          ctx.lifecycle.onClose(() => {
            order.push('close');
          });
        }),
      ],
    });

    await app.start({ port: 4101 });
    const stopping = app.stop();
    fake.tick(20_000);
    await stopping;

    expect(order).toEqual(['stopping', 'shutdown', 'close']);
  });

  it('a request arriving during the drain window still gets a 503', async () => {
    // The pre-existing guarantee, re-pinned: adding the phase must not move
    // when #stopping flips for an application that registers no hook.
    const fake = createFakeRuntime();
    const app = createApplication({ plugins: [runtimePluginWith(fake)] });

    await app.start({ port: 4102 });
    const stopping = app.stop();
    const response = await app.inject({ method: 'GET', url: 'http://localhost/anything' });
    expect(response.statusCode).toBe(503);

    fake.tick(20_000);
    await stopping;
  });

  it('a rejecting stopping hook surfaces from stop()', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({
      plugins: [
        runtimePluginWith(fake, (ctx) => {
          ctx.lifecycle.onStopping(() => Promise.reject(new Error('deregistration exploded')));
        }),
      ],
    });

    await app.start({ port: 4103 });
    await expect(app.stop()).rejects.toThrow('deregistration exploded');
  });

  it('stop() before start() never runs stopping hooks', async () => {
    const fake = createFakeRuntime();
    let ran = false;
    const app = createApplication({
      plugins: [
        runtimePluginWith(fake, (ctx) => {
          ctx.lifecycle.onStopping(() => {
            ran = true;
          });
        }),
      ],
    });

    await app.stop();
    expect(ran).toBe(false);
  });

  it('a second stop() does not re-run the stopping hooks', async () => {
    const fake = createFakeRuntime();
    let runs = 0;
    const app = createApplication({
      plugins: [
        runtimePluginWith(fake, (ctx) => {
          ctx.lifecycle.onStopping(() => {
            runs++;
          });
        }),
      ],
    });

    await app.start({ port: 4104 });
    const first = app.stop();
    const second = app.stop();
    fake.tick(20_000);
    await Promise.all([first, second]);

    expect(runs).toBe(1);
  });
});
