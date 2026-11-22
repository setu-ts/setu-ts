/**
 * The request context's abort watcher (V13-200, code-review M2): pending
 * cleanups run once on the request's own signal, only while the response has
 * not been handed back.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRequest, IRequestContext } from '@setu-ts/common';

import { createRequestContext } from '../../src/context/request-context.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A context over a request with the given signal, recording abort reports. */
function contextWith(signal?: AbortSignal): {
  handle: ReturnType<typeof createRequestContext>;
  aborts: IRequestContext[];
} {
  const registry = new ServiceRegistry();
  registry.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
  const aborts: IRequestContext[] = [];
  const request = {
    method: 'GET',
    url: 'http://test/',
    path: '/',
    headers: new Headers(),
    ...(signal === undefined ? {} : { signal }),
  } as IRequest;
  const handle = createRequestContext(
    request,
    registry,
    createFakeRuntime().runtime,
    (ctx) => void aborts.push(ctx),
  );
  return { handle, aborts };
}

describe('request context abort watcher', () => {
  it('runs pending cleanups once when the request signal aborts', () => {
    const client = new AbortController();
    const { handle, aborts } = contextWith(client.signal);
    let cleaned = 0;
    handle.ctx.defer?.(() => void cleaned++);
    handle.ctx.defer?.(() => void cleaned++);
    client.abort();
    client.abort();
    expect(cleaned).toBe(2);
    expect(aborts).toHaveLength(1);
    expect(handle.takeDeferred()).toBeUndefined();
  });

  it('runs them in a microtask for a signal that was already aborted', async () => {
    const client = new AbortController();
    client.abort();
    const { handle, aborts } = contextWith(client.signal);
    let cleaned = 0;
    handle.ctx.defer?.(() => void cleaned++);
    expect(cleaned).toBe(0);
    await Promise.resolve();
    expect(cleaned).toBe(1);
    expect(aborts).toHaveLength(1);
  });

  it('stays disarmed for a first defer made after the response was handed back', async () => {
    const client = new AbortController();
    const { handle, aborts } = contextWith(client.signal);
    handle.disarmAbort();
    client.abort();
    let cleaned = 0;
    handle.ctx.defer?.(() => void cleaned++);
    await Promise.resolve();
    await Promise.resolve();
    expect(cleaned).toBe(0);
    expect(aborts).toHaveLength(0);
  });

  it('ignores an abort once disarmed, and an already-aborted signal disarmed before its microtask', async () => {
    const client = new AbortController();
    const { handle, aborts } = contextWith(client.signal);
    let cleaned = 0;
    handle.ctx.defer?.(() => void cleaned++);
    handle.disarmAbort();
    handle.disarmAbort();
    client.abort();
    expect(cleaned).toBe(0);

    const early = new AbortController();
    early.abort();
    const pre = contextWith(early.signal);
    pre.handle.ctx.defer?.(() => void cleaned++);
    pre.handle.disarmAbort();
    await Promise.resolve();
    expect(cleaned).toBe(0);
    expect(aborts).toHaveLength(0);
    expect(pre.aborts).toHaveLength(0);
  });

  it('watches nothing for a request without a signal', () => {
    const { handle, aborts } = contextWith();
    handle.ctx.defer?.(() => {});
    handle.disarmAbort();
    expect(aborts).toHaveLength(0);
    expect(handle.takeDeferred()).toHaveLength(1);
  });
});
