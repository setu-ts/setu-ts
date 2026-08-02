/**
 * `ctx.signal` and its never-aborting fallback.
 *
 * The fallback used to be a single module-scope `AbortController`, which made
 * every application fail to boot on Cloudflare Workers: workerd refuses
 * `new AbortController()` in global scope, because the controller is bound to
 * an I/O context. The "constructed per request" case below is the regression
 * guard — it fails against a shared module-scope sentinel.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest } from '@hono-enterprise/common';

import { createRequestContext } from '../../src/context/request-context.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A minimal request, optionally carrying its own abort signal. */
function request(signal?: AbortSignal): IRequest {
  return {
    method: 'GET',
    url: 'https://example.test/things?page=2',
    path: '/things',
    headers: new Headers(),
    ...(signal === undefined ? {} : { signal }),
    json: <T>(): Promise<T> => Promise.resolve({} as T),
    text: (): Promise<string> => Promise.resolve(''),
    bytes: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  } as unknown as IRequest;
}

/** Builds a context the way the kernel's dispatch path does. */
function contextFor(signal?: AbortSignal) {
  const { runtime } = createFakeRuntime();
  return createRequestContext(request(signal), new ServiceRegistry(), runtime).ctx;
}

describe('createRequestContext — signal', () => {
  it("uses the request's own signal when it carries one", () => {
    const controller = new AbortController();
    expect(contextFor(controller.signal).signal).toBe(controller.signal);
  });

  it('propagates an abort from the request signal', () => {
    const controller = new AbortController();
    const ctx = contextFor(controller.signal);

    expect(ctx.signal.aborted).toBe(false);
    controller.abort();
    expect(ctx.signal.aborted).toBe(true);
  });

  it('falls back to a live, non-aborting signal when the request has none', () => {
    const ctx = contextFor();

    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
    // Handlers add abort listeners unconditionally, so the fallback has to be a
    // real signal rather than a null-ish stand-in.
    expect(() => ctx.signal.addEventListener('abort', () => {})).not.toThrow();
  });

  it('constructs the fallback PER REQUEST, never once at module scope', () => {
    // The regression guard. A module-scope `new AbortController()` — which is
    // what this used to be — is a "Disallowed operation called within global
    // scope" on workerd and stopped every application booting there. Two
    // contexts sharing one signal instance is the observable symptom.
    const first = contextFor();
    const second = contextFor();

    expect(first.signal).not.toBe(second.signal);
  });

  it('never shares a fallback with a request that brought its own signal', () => {
    const controller = new AbortController();

    expect(contextFor().signal).not.toBe(contextFor(controller.signal).signal);
  });
});

describe('createRequestContext — the rest of the context', () => {
  it('parses query parameters off the request URL', () => {
    expect(contextFor().query).toEqual({ page: '2' });
  });

  it('starts with empty params, and setParams installs the matched ones', () => {
    const { runtime } = createFakeRuntime();
    const handle = createRequestContext(request(), new ServiceRegistry(), runtime);

    expect(handle.ctx.params).toEqual({});
    handle.setParams({ id: '7' });
    expect(handle.ctx.params).toEqual({ id: '7' });
  });

  it('takes startTime from the MONOTONIC clock, never the wall clock', () => {
    // hrtime() and now() are deliberately far apart in the fixture, so a
    // context reading the wrong one is obvious rather than plausible.
    const { runtime } = createFakeRuntime();
    const ctx = createRequestContext(request(), new ServiceRegistry(), runtime).ctx;

    expect(ctx.startTime).toBe(runtime.hrtime());
    expect(ctx.startTime).not.toBe(runtime.now());
  });

  it('gives each request a child registry, not the application one', () => {
    const registry = new ServiceRegistry();
    registry.register('shared', { value: 1 });
    const { runtime } = createFakeRuntime();

    const ctx = createRequestContext(request(), registry, runtime).ctx;

    // Inherited...
    expect(ctx.services.has('shared')).toBe(true);
    // ...but a per-request registration does not leak back to the application.
    ctx.services.register('per-request', { value: 2 });
    expect(registry.has('per-request')).toBe(false);
  });
});
