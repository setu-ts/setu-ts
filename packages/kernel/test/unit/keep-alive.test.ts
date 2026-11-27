/**
 * Cleanup that outlives the handed-back response is handed to the runtime's
 * `waitUntil` (V13-200), so a platform that ends the invocation with its
 * response (Cloudflare Workers) does not cut it off.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, ERROR_RESPONDER_STATE_KEY } from '@setu-ts/common';
import type { IRequest, IRuntimeServices } from '@setu-ts/common';

import { createRequestContext } from '../../src/context/request-context.ts';
import { keepAlive, wrapDeferredStream } from '../../src/context/deferred.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/**
 * The fake runtime with a `waitUntil` member, layered over it rather than
 * spread (spreading would read the fake's throwing `subtle` getter).
 */
function withWaitUntil(waitUntil: (promise: Promise<unknown>) => void): IRuntimeServices {
  const runtime = Object.create(createFakeRuntime().runtime) as IRuntimeServices;
  Object.defineProperty(runtime, 'waitUntil', { value: waitUntil });
  return runtime;
}

/** A registry whose runtime records every promise handed to `waitUntil`. */
function recording(): { registry: ServiceRegistry; held: Promise<unknown>[] } {
  const held: Promise<unknown>[] = [];
  const runtime = withWaitUntil((promise) => {
    held.push(promise);
  });
  const registry = new ServiceRegistry();
  registry.register(CAPABILITIES.RUNTIME, runtime);
  return { registry, held };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('keepAlive', () => {
  it('hands the promise to waitUntil, as one that never rejects', async () => {
    const { registry, held } = recording();
    keepAlive(registry, Promise.reject(new Error('cleanup failed')));
    expect(held).toHaveLength(1);
    await expect(held[0]).resolves.toBeUndefined();
  });

  it('does nothing without a runtime, or with a runtime that has no waitUntil', () => {
    expect(() => keepAlive(new ServiceRegistry(), Promise.resolve())).not.toThrow();
    const registry = new ServiceRegistry();
    registry.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
    expect(() => keepAlive(registry, Promise.resolve())).not.toThrow();
  });

  it('loses only the extension when waitUntil throws', () => {
    const registry = new ServiceRegistry();
    registry.register(
      CAPABILITIES.RUNTIME,
      withWaitUntil(() => {
        throw new Error('no request context');
      }),
    );
    expect(() => keepAlive(registry, Promise.resolve())).not.toThrow();
  });
});

describe('the cleanup paths that outlive the response', () => {
  it('(a) still runs a late asynchronous ctx.defer when waitUntil throws', async () => {
    const registry = new ServiceRegistry();
    registry.register(
      CAPABILITIES.RUNTIME,
      withWaitUntil(() => {
        throw new Error('no request context');
      }),
    );
    const h = createRequestContext(
      { method: 'GET', url: 'http://t/', path: '/', headers: new Headers() } as IRequest,
      registry,
      createFakeRuntime().runtime,
    );
    h.takeDeferred();
    const ran = vi.fn();
    h.ctx.defer?.(async () => {
      await Promise.resolve();
      ran();
    });
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
  });

  it('(a) a late asynchronous ctx.defer is kept alive once', async () => {
    const { registry, held } = recording();
    const h = createRequestContext(
      { method: 'GET', url: 'http://t/', path: '/', headers: new Headers() } as IRequest,
      registry,
      createFakeRuntime().runtime,
    );
    h.takeDeferred();
    const ran = vi.fn();
    h.ctx.defer?.(async () => {
      await Promise.resolve();
      ran();
    });
    h.ctx.defer?.(() => {
      ran();
    });
    expect(held).toHaveLength(1);
    await held[0];
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('(b) an abort hands the cancel-then-cleanup chain over at the abort, once', async () => {
    const { registry, held } = recording();
    const order: string[] = [];
    const client = new AbortController();
    wrapDeferredStream(
      new ReadableStream<Uint8Array>({
        cancel() {
          order.push('cancelled');
        },
      }),
      [
        async () => {
          await Promise.resolve();
          order.push('first cleanup');
        },
        async () => {
          await Promise.resolve();
          order.push('second cleanup');
        },
      ],
      registry,
      () => order.push('complete'),
      client.signal,
    );
    expect(held).toEqual([]);
    client.abort();
    expect(held).toHaveLength(1);
    await held[0];
    expect(order).toEqual(['cancelled', 'second cleanup', 'first cleanup', 'complete']);
    await settle();
    expect(held).toHaveLength(1);
  });

  it('(b) a stream that ends normally hands its asynchronous cleanup over, once', async () => {
    const { registry, held } = recording();
    const order: string[] = [];
    const body = wrapDeferredStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      [
        async () => {
          await Promise.resolve();
          order.push('cleanup');
        },
      ],
      registry,
      () => order.push('complete'),
    );

    await new Response(body).arrayBuffer();
    await settle();

    expect(held).toHaveLength(1);
    await held[0];
    expect(order).toEqual(['cleanup', 'complete']);
  });

  it('(b) a consumer cancel hands the asynchronous cleanup over, once', async () => {
    const { registry, held } = recording();
    const order: string[] = [];
    const body = wrapDeferredStream(
      new ReadableStream<Uint8Array>({ pull() {} }),
      [
        async () => {
          await Promise.resolve();
          order.push('cleanup');
        },
      ],
      registry,
      () => order.push('complete'),
    );

    await body.cancel();
    await settle();

    expect(held).toHaveLength(1);
    await held[0];
    expect(order).toEqual(['cleanup', 'complete']);
  });

  it('(c) a handler still running after an early response is kept alive with its cleanups', async () => {
    const { createApplication } = await import('../../src/index.ts');
    const { RuntimePlugin } = await import('@setu-ts/runtime');
    const held: Promise<unknown>[] = [];
    const gate = Promise.withResolvers<void>();
    const cleaned = vi.fn();
    const app = createApplication({
      plugins: [
        RuntimePlugin({
          platform: 'cloudflare-workers',
          waitUntil: (promise) => {
            held.push(promise);
          },
        }),
      ],
    });
    app.middleware.add((ctx, next) => {
      void next().catch(() => {});
      return ctx.response.text('early');
    });
    app.router.get('/', async (ctx) => {
      ctx.defer?.(cleaned);
      await gate.promise;
      return ctx.response.text('late');
    });
    await app.start();
    try {
      const response = await app.fetch(new Request('http://test/'));
      expect(await response.text()).toBe('early');
      expect(held).toHaveLength(1);
      expect(cleaned).not.toHaveBeenCalled();
      gate.resolve();
      await held[0];
      expect(cleaned).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await app.stop();
    }
  });

  it('(c) streamed: the handler drain is handed over when the early stream ends', async () => {
    const { createApplication } = await import('../../src/index.ts');
    const { RuntimePlugin } = await import('@setu-ts/runtime');
    const held: Promise<unknown>[] = [];
    const gate = Promise.withResolvers<void>();
    const cleaned = vi.fn();
    const app = createApplication({
      plugins: [
        RuntimePlugin({
          platform: 'cloudflare-workers',
          waitUntil: (promise) => {
            held.push(promise);
          },
        }),
      ],
    });
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
      await vi.waitFor(() => expect(held).toHaveLength(1));
      gate.resolve();
      await held[0];
      expect(cleaned).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await app.stop();
    }
  });

  it('keeps the asynchronous cleanup of a request whose error responder threw alive', async () => {
    const { createApplication } = await import('../../src/index.ts');
    const { RuntimePlugin } = await import('@setu-ts/runtime');
    const held: Promise<unknown>[] = [];
    const cleaned = vi.fn();
    const app = createApplication({
      plugins: [
        RuntimePlugin({
          platform: 'cloudflare-workers',
          waitUntil: (promise) => {
            held.push(promise);
          },
        }),
      ],
    });
    app.router.get('/', (ctx) => {
      ctx.defer?.(async () => {
        await Promise.resolve();
        cleaned();
      });
      ctx.state.set(ERROR_RESPONDER_STATE_KEY, {
        respond(): void {
          throw new Error('responder failed');
        },
      });
      throw new Error('handler failed');
    });
    await app.start();
    try {
      await app.fetch(new Request('http://test/')).catch(() => undefined);
      expect(held).toHaveLength(1);
      await held[0];
      expect(cleaned).toHaveBeenCalledOnce();
    } finally {
      await app.stop();
    }
  });
});
