/**
 * A handler may return a thenable that is not a native `Promise` (M87 review).
 *
 * `RouteHandler` declares `HandlerResult | Promise<HandlerResult>`, and
 * TypeScript's `Promise<T>` is satisfied STRUCTURALLY — so a promise from
 * another realm (a `vm` context, a worker) or from a userland library type-
 * checks here and is not `instanceof Promise` at runtime. The synchronous
 * request path introduced in M87 has to decide "did this need awaiting?", and
 * an `instanceof` test answers `false` for exactly those values, reporting the
 * handler finished while it was still running: the response is sent with
 * whatever the builder held at that moment, 200, no error anywhere.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';

import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** Minimal plugin providing the mandatory runtime capability. */
function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/** A thenable that settles on a later turn and is NOT `instanceof Promise`. */
function deferredThenable(work: () => void): Promise<never> {
  const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));
  return {
    then(onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) {
      return gate.then(() => {
        work();
        return onOk(undefined);
      }, onErr);
    },
  } as unknown as Promise<never>;
}

describe('handler returning a non-native thenable (M87)', () => {
  it('is awaited, so its response is not truncated', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.router.get('/thenable', {
      handler: (ctx) => deferredThenable(() => ctx.response.json({ finished: true })),
    });
    await app.start();

    const response = await app.inject({ method: 'GET', url: '/thenable' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ finished: true }));
    await app.stop();
  });

  it('propagates a rejection from a non-native thenable to the 500 path', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.router.get('/boom', {
      handler: () =>
        ({
          then(_ok: unknown, onErr?: (reason: unknown) => unknown) {
            return Promise.resolve().then(() => onErr?.(new Error('thenable failed')));
          },
        }) as unknown as Promise<never>,
    });
    await app.start();

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    await app.stop();
  });
});
