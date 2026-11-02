import { describe, it, expect, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { MiddlewareFunction, RouteHandler } from '@setu-ts/common';
import { createApplication } from '../../src/index.ts';
import { DispatchedRequest } from '../../src/application/dispatched-request.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function appWithRuntime(events: string[] = []) {
  return createApplication({
    plugins: [
      {
        name: 'runtime',
        version: '1',
        provides: [CAPABILITIES.RUNTIME],
        register(ctx) {
          ctx.services.register(CAPABILITIES.RUNTIME, createFakeRuntime().runtime);
          ctx.lifecycle.onRequest(() => {
            events.push('request');
          });
          ctx.lifecycle.onResponse(() => {
            events.push('response');
          });
          ctx.middleware.add(async (c, next) => {
            events.push('global');
            expect(c.state.size).toBe(0);
            await next();
          });
        },
      },
    ],
  });
}

describe('dispatch', () => {
  it.each([
    ['/files/:name', 404, false],
    ['/files/export', 200, true],
    [undefined, 200, true],
  ] as const)(
    'pins the registered pattern %s after global middleware, before route middleware',
    async (route, status, runs) => {
      const events: string[] = [];
      const app = appWithRuntime(events);
      const middleware = vi.fn<MiddlewareFunction>(async (_ctx, next) => {
        await next();
      });
      const sibling = vi.fn<RouteHandler>((ctx) => ctx.response.json({ exported: true }));
      const dynamic = vi.fn<RouteHandler>((ctx) => ctx.response.json({ name: ctx.params.name }));
      app.router.get('/files/:name', dynamic);
      app.router.get('/files/export', { middleware: [middleware], handler: sibling });
      await app.start();
      try {
        const response = await app.dispatch!(
          new Request('http://test/files/export'),
          route === undefined ? {} : { route },
        );
        expect(response.status).toBe(status);
        if (runs) expect(await response.json()).toEqual({ exported: true });
        else expect(await response.json()).toEqual({ error: 'Not Found' });
        expect(middleware).toHaveBeenCalledTimes(runs ? 1 : 0);
        expect(sibling).toHaveBeenCalledTimes(runs ? 1 : 0);
        expect(dynamic).not.toHaveBeenCalled();
        expect(events).toEqual(['request', 'global', 'response']);
        if (route === '/files/:name') {
          const matched = await app.dispatch!(new Request('http://test/files/plain'), { route });
          expect(matched.status).toBe(200);
          expect(await matched.json()).toEqual({ name: 'plain' });
          expect(dynamic).toHaveBeenCalledOnce();
        }
      } finally {
        await app.stop();
      }
    },
  );
  it('runs fresh contexts, hooks and middleware without an adapter and carries ip, raw and signal', async () => {
    const events: string[] = [];
    const app = appWithRuntime(events);
    const abort = new AbortController();
    const raw = new Request('http://test/item', { signal: abort.signal });
    app.router.get('/item', {
      middleware: [
        async (ctx, next) => {
          events.push('route');
          ctx.state.set('seen', true);
          await next();
        },
      ],
      handler(ctx) {
        expect(ctx.request.raw).toBe(raw);
        expect(ctx.signal).toBe(raw.signal);
        return ctx.response.json({ ip: ctx.request.ip ?? null });
      },
    });
    await app.start();
    try {
      expect(await (await app.dispatch!(raw, { ip: '192.0.2.1' })).json()).toEqual({
        ip: '192.0.2.1',
      });
      expect(events).toEqual(['request', 'global', 'route', 'response']);
      expect(await (await app.dispatch!(raw)).json()).toEqual({ ip: null });
    } finally {
      await app.stop();
    }
  });
  it('preserves streamed request/response bodies and runs deferred cleanup after consumption', async () => {
    const app = appWithRuntime();
    const cleanup = vi.fn();
    app.router.post('/stream', async (ctx) => {
      expect(await ctx.request.text()).toBe('hello');
      ctx.defer?.(cleanup);
      return ctx.response.stream(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('world'));
            controller.close();
          },
        }),
      );
    });
    await app.start();
    try {
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        duplex: 'half',
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('hello'));
            c.close();
          },
        }),
      };
      const response = await app.dispatch!(new Request('http://test/stream', init));
      expect(cleanup).not.toHaveBeenCalled();
      expect(await response.text()).toBe('world');
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await app.stop();
    }
  });
  it('short circuits downstream and answers 503 while stopping', async () => {
    const app = appWithRuntime();
    const handler = vi.fn((ctx) => ctx.response.text('bad'));
    app.router.get('/blocked', {
      middleware: [
        (ctx) => {
          ctx.response.status(403).text('no');
        },
      ],
      handler,
    });
    await app.start();
    expect((await app.dispatch!(new Request('http://test/blocked'))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    await app.stop();
    expect((await app.dispatch!(new Request('http://test/blocked'))).status).toBe(503);
  });
  it('memoizes bytes and form parsing and guards request identity', async () => {
    const raw = new Request('http://test/form', {
      method: 'POST',
      body: 'name=A',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const request = new DispatchedRequest(raw);
    expect(await request.bytes()).toBe(await request.bytes());
    expect(await request.text()).toBe('name=A');
    expect(request.formData()).toBe(request.formData());
    await request.formData();
    request.user = { id: 'one', roles: [] };
    expect(() => {
      request.user = { id: 'two', roles: [] };
    }).toThrow();
    expect(
      await new DispatchedRequest(
        new Request('http://test/', { method: 'POST', body: '{"a":1}' }),
      ).json(),
    ).toEqual({ a: 1 });
    await expect(
      new DispatchedRequest(new Request('http://test/', { method: 'POST', body: 'bad' })).json(),
    ).rejects.toThrow();
  });
});

it.each([204, 205, 304])(
  'drops a body at status %i and cancels a discarded stream',
  async (status) => {
    const app = appWithRuntime();
    const cleanup = vi.fn();
    const cancel = vi.fn();
    app.router.get('/bytes', (ctx) => ctx.response.status(status).send(new Uint8Array([1])));
    app.router.get('/stream', (ctx) => {
      ctx.defer?.(cleanup);
      return ctx.response.status(status).stream(new ReadableStream({ cancel }));
    });
    await app.start();
    try {
      expect((await app.dispatch!(new Request('http://test/bytes'))).body).toBeNull();
      expect((await app.dispatch!(new Request('http://test/stream'))).body).toBeNull();
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await app.stop();
    }
  },
);
it('returns binary snapshots as native response bytes', async () => {
  const app = appWithRuntime();
  app.router.get('/bytes', (ctx) => ctx.response.send(new Uint8Array([65, 66])));
  await app.start();
  try {
    expect(await (await app.dispatch!(new Request('http://test/bytes'))).text()).toBe('AB');
  } finally {
    await app.stop();
  }
});
