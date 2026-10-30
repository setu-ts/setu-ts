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
