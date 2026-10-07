/** Behavioral tests for the actual production Worker startup seam. @module */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createWorkerHandler } from '../apps/cloudflare/worker.ts';

const env = { EXAMPLE_KV: { put: () => Promise.resolve() } };

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeApp(
  start: () => Promise<void>,
  onFetch: () => void,
): IKernelApplication {
  return {
    router: {} as IKernelApplication['router'],
    middleware: {} as IKernelApplication['middleware'],
    services: {} as IKernelApplication['services'],
    register: () => fakeApp(start, onFetch),
    unregister: () => false,
    hasPlugin: () => false,
    start,
    stop: () => Promise.resolve(),
    fetch: () => {
      onFetch();
      return Promise.resolve(new Response('ok'));
    },
    inject: () => Promise.reject(new Error('not used')),
  };
}

describe('production Worker startup behavior', () => {
  it('blocks fetch and shares one startup across concurrent cold requests', async () => {
    const gate = deferred();
    let starts = 0;
    let fetches = 0;
    const handler = createWorkerHandler(() =>
      fakeApp(() => {
        starts += 1;
        return gate.promise;
      }, () => fetches += 1)
    );

    const first = handler.fetch(new Request('https://example.test/1'), env);
    const second = handler.fetch(new Request('https://example.test/2'), env);
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(fetches).toBe(0);

    gate.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(fetches).toBe(2);
  });

  it('shares a failed startup with concurrent callers without fetching', async () => {
    const gate = deferred();
    const failure = new Error('startup failed');
    let starts = 0;
    let fetches = 0;
    const handler = createWorkerHandler(() =>
      fakeApp(() => {
        starts += 1;
        return gate.promise;
      }, () => fetches += 1)
    );

    const first = handler.fetch(new Request('https://example.test/1'), env);
    const second = handler.fetch(new Request('https://example.test/2'), env);
    gate.reject(failure);

    expect(await first.catch((error: unknown) => error)).toBe(failure);
    expect(await second.catch((error: unknown) => error)).toBe(failure);
    expect(starts).toBe(1);
    expect(fetches).toBe(0);
  });

  it('retries startup on the next request after a failure', async () => {
    // One isolate serves many invocations, so caching the rejection would leave
    // it answering errors for its whole life (M70l X9-8).
    let starts = 0;
    let fetches = 0;
    const handler = createWorkerHandler(() =>
      fakeApp(() => {
        starts += 1;
        return starts === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
      }, () => fetches += 1)
    );

    const failed = await handler.fetch(
      new Request('https://example.test/1'),
      env,
    ).catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(fetches).toBe(0);

    expect(
      (await handler.fetch(new Request('https://example.test/2'), env)).status,
    ).toBe(200);
    expect(
      (await handler.fetch(new Request('https://example.test/3'), env)).status,
    ).toBe(200);
    expect(starts).toBe(2);
    expect(fetches).toBe(2);
  });
});
