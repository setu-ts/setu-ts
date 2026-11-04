import { expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IRequest } from '@setu-ts/common';
import { createRequestContext } from '../../src/context/request-context.ts';
import { runDeferred } from '../../src/context/deferred.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function registryWithRuntime() {
  const registry = new ServiceRegistry();
  registry.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
  return registry;
}

function handle(registry = registryWithRuntime()) {
  return createRequestContext(
    { method: 'GET', url: 'http://test/', path: '/', headers: new Headers() } as IRequest,
    registry,
    createFakeRuntime().runtime,
  );
}

it('allocates a list only on first defer, takes it once, and runs LIFO', () => {
  expect(handle().takeDeferred()).toBeUndefined();
  const h = handle();
  const order: number[] = [];
  h.ctx.defer?.(() => {
    order.push(1);
  });
  h.ctx.defer?.(() => {
    order.push(2);
  });
  const list = h.takeDeferred();
  expect(list).toHaveLength(2);
  expect(h.takeDeferred()).toBeUndefined();
  expect(runDeferred(list!, registryWithRuntime())).toBeUndefined();
  expect(order).toEqual([2, 1]);
  h.ctx.defer?.(() => {
    order.push(3);
  });
  expect(order).toEqual([2, 1, 3]);
});

it('reports synchronous and asynchronous failures once at warn, including late registration', async () => {
  const registry = registryWithRuntime();
  const warn = vi.fn();
  registry.register(CAPABILITIES.LOGGER, { warn } as unknown as ILogger);
  const h = handle(registry);
  h.ctx.defer?.(() => {
    throw new Error('sync');
  });
  h.ctx.defer?.(async () => {
    await Promise.resolve();
    throw 'async';
  });
  await runDeferred(h.takeDeferred()!, registry);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.map((call) => call[1])).toEqual([
    { error: 'Error: async' },
    { error: 'Error: sync' },
  ]);
  h.ctx.defer?.(() => {
    throw new Error('late');
  });
  h.ctx.defer?.(async () => {
    await Promise.resolve();
    throw new Error('late async');
  });
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

it('continues cleanup without a logger and when the logger itself throws', async () => {
  const registry = registryWithRuntime();
  const done = vi.fn();
  expect(
    runDeferred(
      [
        done,
        () => {
          throw new Error('no logger');
        },
      ],
      registry,
    ),
  ).toBeUndefined();
  expect(done).toHaveBeenCalledOnce();
  registry.register(CAPABILITIES.LOGGER, {
    warn: () => {
      throw new Error('logger broken');
    },
  } as unknown as ILogger);
  await runDeferred(
    [
      async () => {},
      () => {
        throw new Error('cleanup failed');
      },
    ],
    registry,
  );
});

for (const routeMiddleware of [false, true]) {
  for (const fails of [false, true]) {
    it(`M131b 3.10 waits for detached handler and shutdown routeMiddleware=${routeMiddleware} fails=${fails}`, async () => {
      const { createApplication } = await import('../../src/index.ts');
      const { RuntimePlugin } = await import('@setu-ts/runtime');
      const { promise, resolve } = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const cleaned = vi.fn();
      const late = vi.fn();
      const app = createApplication({ plugins: [RuntimePlugin()] });
      const early: import('@setu-ts/common').MiddlewareFunction = (ctx, next) => {
        void next().catch(() => {});
        return ctx.response.text('early');
      };
      if (!routeMiddleware) app.middleware.add(early);
      app.router.get('/', {
        ...(routeMiddleware ? { middleware: [early] } : {}),
        handler: async (ctx) => {
          ctx.defer?.(cleaned);
          started.resolve();
          await promise;
          ctx.defer?.(late);
          if (fails) throw new Error('late handler failure');
          return ctx.response.text('late');
        },
      });
      await app.start();
      try {
        const response = await app.inject({ method: 'GET', url: '/' });
        await started.promise;
        expect(response.body).toBe('early');
        expect(cleaned).not.toHaveBeenCalled();
        let stopped = false;
        const stopping = app.stop().then(() => {
          stopped = true;
        });
        await new Promise<void>((done) => setTimeout(done, 25));
        expect(stopped).toBe(false);
        resolve();
        await stopping;
        expect(late).toHaveBeenCalledOnce();
        expect(cleaned).toHaveBeenCalledOnce();
      } finally {
        resolve();
        await app.stop();
      }
    });
  }
}

it('M131b 3.10 waits for handler after an early stream has already ended', async () => {
  const { createApplication } = await import('../../src/index.ts');
  const { RuntimePlugin } = await import('@setu-ts/runtime');
  const gate = Promise.withResolvers<void>();
  const cleaned = vi.fn();
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.middleware.add((ctx, next) => {
    void next().catch(() => {});
    return ctx.response.stream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([65]));
          controller.close();
        },
      }),
    );
  });
  app.router.get('/', async (ctx) => {
    await gate.promise;
    ctx.defer?.(cleaned);
    return ctx.response.text('late');
  });
  await app.start();
  try {
    const response = await app.fetch(new Request('http://test/'));
    expect(await response.text()).toBe('A');
    expect(cleaned).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(cleaned).toHaveBeenCalledOnce());
  } finally {
    gate.resolve();
    await app.stop();
  }
});
