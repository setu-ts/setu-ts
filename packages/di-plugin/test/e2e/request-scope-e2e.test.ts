import { expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IContainer, IHttpAdapter, IPlugin, IRequest, IResponse } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ContainerClosedError, DiPlugin } from '../../src/index.ts';

function harness() {
  let handler!: (request: IRequest) => IResponse | Promise<IResponse>;
  const capture: IPlugin = {
    name: 'capture-adapter',
    version: '1.0.0',
    dependencies: [CAPABILITIES.RUNTIME],
    register(ctx) {
      const adapter = ctx.services.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      const install = adapter.setHandler.bind(adapter);
      adapter.setHandler = (fn) => {
        handler = fn;
        install(fn);
      };
    },
  };
  const app = createApplication({ plugins: [RuntimePlugin(), DiPlugin(), capture] });
  const request = (path: string): IResponse | Promise<IResponse> =>
    handler({ method: 'GET', url: `http://test${path}`, path, headers: new Headers() } as IRequest);
  return { app, request };
}

it('keeps DI unused and synchronously disposed request scopes on the synchronous adapter path', async () => {
  const { app, request } = harness();
  const dispose = vi.fn();
  app.register({
    name: 'providers',
    version: '1.0.0',
    dependencies: [CAPABILITIES.DI_CONTAINER],
    register(ctx) {
      ctx.container!.register('request', { useFactory: () => ({}) }, { scope: 'scoped', dispose });
    },
  });
  app.router.get('/unused', (ctx) => ctx.response.text('unused'));
  app.router.get('/used', (ctx) => {
    ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER).forRequest(ctx).resolve('request');
    return ctx.response.text('used');
  });
  await app.start();
  try {
    const unused = request('/unused');
    const used = request('/used');
    expect(unused).not.toBeInstanceOf(Promise);
    expect(used).not.toBeInstanceOf(Promise);
    expect((await used).snapshot().body).toBe('used');
    expect(dispose).toHaveBeenCalledOnce();
    expect(() =>
      app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER).register('late', { useValue: 1 }),
    ).toThrow(ContainerClosedError);
  } finally {
    await app.stop();
  }
});

it('isolates concurrent requests, disposes thrown handlers, and keeps streamed services live through the last byte', async () => {
  const { app, request } = harness();
  let sequence = 0;
  const disposed: number[] = [];
  app.register({
    name: 'providers',
    version: '1.0.0',
    dependencies: [CAPABILITIES.DI_CONTAINER],
    register(ctx) {
      ctx.container!.register(
        'request',
        { useFactory: () => ({ id: ++sequence }) },
        {
          scope: 'scoped',
          dispose: (service) => {
            disposed.push(service.id);
          },
        },
      );
    },
  });
  const active: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let both!: () => void;
  const started = new Promise<void>((resolve) => {
    both = resolve;
  });
  app.router.get('/concurrent', async (ctx) => {
    const container = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
    const scope = container.forRequest(ctx);
    const value = scope.resolve<{ id: number }>('request');
    active.push(value.id);
    if (active.length === 2) both();
    await gate;
    expect(scope.resolve('request')).toBe(value);
    return ctx.response.json(value);
  });
  app.router.get('/throw', (ctx) => {
    ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER).forRequest(ctx).resolve('request');
    throw new Error('handler failed');
  });
  app.router.get('/stream', (ctx) => {
    const service = ctx.services
      .get<IContainer>(CAPABILITIES.DI_CONTAINER)
      .forRequest(ctx)
      .resolve<{ id: number }>('request');
    let sent = false;
    return ctx.response.stream(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            expect(disposed).not.toContain(service.id);
            if (sent) controller.close();
            else {
              sent = true;
              controller.enqueue(new Uint8Array(262144).fill(service.id));
            }
          },
        },
        { highWaterMark: 0 },
      ),
    );
  });
  await app.start();
  try {
    const first = app.inject({ method: 'GET', url: '/concurrent' });
    const second = app.inject({ method: 'GET', url: '/concurrent' });
    await started;
    expect(new Set(active).size).toBe(2);
    expect(disposed).toEqual([]);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.json<{ id: number }>().id)).toEqual(active);
    expect(disposed).toEqual(active);
    expect((await app.inject({ method: 'GET', url: '/throw' })).statusCode).toBe(500);
    expect(disposed).toContain(3);
    const snapshot = (await request('/stream')).snapshot();
    if (!snapshot.streaming) throw new Error('stream expected');
    expect(disposed).not.toContain(4);
    const reader = snapshot.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array(262144).fill(4));
    expect(disposed).not.toContain(4);
    expect((await reader.read()).done).toBe(true);
    expect(disposed).toEqual([1, 2, 3, 4]);
  } finally {
    release();
    await app.stop();
  }
});

it('fails startup for a captive graph naming both tokens', async () => {
  const { app } = harness();
  app.register({
    name: 'bad-graph',
    version: '1.0.0',
    dependencies: [CAPABILITIES.DI_CONTAINER],
    register(ctx) {
      ctx.container!.register('RequestUnit', { useValue: {} }, { scope: 'scoped' });
      ctx.container!.register('SingletonService', {
        useFactory: () => ({}),
        inject: ['RequestUnit'],
      });
    },
  });
  await expect(app.start()).rejects.toThrow(/captive: SingletonService → RequestUnit/);
});
