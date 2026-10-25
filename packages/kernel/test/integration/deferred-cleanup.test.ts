import { expect, it, vi } from 'vitest';
import { CAPABILITIES, ERROR_RESPONDER_STATE_KEY } from '@setu-ts/common';
import type { ILogger, IPlugin, IRequest, IRequestContext, TimerHandle } from '@setu-ts/common';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

async function appFor(
  register: (app: ReturnType<typeof createApplication>) => void,
  logger?: ILogger,
) {
  const fake = createFakeRuntime();
  fake.runtime.setTimeout = (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle;
  const plugin: IPlugin = {
    name: 'runtime-test',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME, CAPABILITIES.HTTP_ADAPTER],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, fake.adapter);
      if (logger !== undefined) ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
  const app = createApplication({ plugins: [plugin] });
  register(app);
  await app.start();
  return { app, adapter: fake.adapter };
}

function request(path = '/'): IRequest {
  return { method: 'GET', url: `http://test${path}`, path, headers: new Headers() } as IRequest;
}

it('keeps captured handler results synchronous without defer and with synchronous cleanups', async () => {
  const order: number[] = [];
  const { app, adapter } = await appFor((app) => {
    app.router.get('/', (ctx) => ctx.response.text('plain'));
    app.router.get('/cleanup', (ctx) => {
      ctx.defer?.(() => {
        order.push(1);
      });
      ctx.defer?.(() => {
        order.push(2);
      });
      return ctx.response.text('clean');
    });
  });
  try {
    expect(adapter.handler?.(request())).not.toBeInstanceOf(Promise);
    expect(adapter.handler?.(request('/cleanup'))).not.toBeInstanceOf(Promise);
    expect(order).toEqual([2, 1]);
  } finally {
    await app.stop();
  }
});

it('awaits async buffered cleanup before return and before shutdown drains', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, adapter } = await appFor((app) => {
    app.router.get('/', (ctx) => {
      ctx.defer?.(async () => {
        entered();
        await gate;
      });
      return ctx.response.text('ok');
    });
  });
  const result = adapter.handler!(request());
  expect(result).toBeInstanceOf(Promise);
  await started;
  let returned = false;
  void Promise.resolve(result).then(() => {
    returned = true;
  });
  let stopped = false;
  const stopping = app.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  expect(stopped).toBe(false);
  release();
  expect((await result).snapshot().body).toBe('ok');
  await stopping;
  expect(stopped).toBe(true);
});

it('cleans up async success and sync/async handler failures after the response is final', async () => {
  const statuses: number[] = [];
  const { app } = await appFor((app) => {
    for (const mode of ['sync-fail', 'async-fail', 'async-ok']) {
      app.router.get(`/${mode}`, (ctx) => {
        ctx.defer?.(() =>
          Promise.resolve().then(() => {
            statuses.push(ctx.response.snapshot().status);
          }),
        );
        if (mode === 'sync-fail') throw new Error('sync');
        return Promise.resolve().then(() => {
          if (mode === 'async-fail') throw new Error('async');
          return ctx.response.text('ok');
        });
      });
    }
  });
  try {
    for (const path of ['sync-fail', 'async-fail', 'async-ok']) {
      const result = await app.inject({ method: 'GET', url: `/${path}` });
      expect(result.statusCode).toBe(path === 'async-ok' ? 200 : 500);
    }
    expect(statuses).toEqual([500, 500, 200]);
  } finally {
    await app.stop();
  }
});

it('reports failed cleanup at warn once and preserves the response and late registrations', async () => {
  const warn = vi.fn();
  const logger = { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as ILogger;
  let context!: IRequestContext;
  const { app } = await appFor((app) => {
    app.router.get('/', (ctx) => {
      context = ctx;
      ctx.defer?.(() => {
        throw new Error('cleanup boom');
      });
      return ctx.response.status(201).text('unchanged');
    });
  }, logger);
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(201);
    expect(response.body).toBe('unchanged');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toEqual({ error: 'Error: cleanup boom' });
    const late = vi.fn();
    context.defer?.(late);
    expect(late).toHaveBeenCalledOnce();
  } finally {
    await app.stop();
  }
});

it.each(['end', 'error', 'cancel', 'cancel-error', 'end-sync'] as const)(
  'settles streaming cleanup once on %s and forwards bytes/cancellation',
  async (mode) => {
    const dispose = vi.fn(() => (mode === 'end-sync' ? undefined : Promise.resolve()));
    const cancel = vi.fn((reason: unknown) => {
      if (mode === 'cancel-error') throw reason;
    });
    const bytes = new Uint8Array(131072).fill(41);
    let pulls = 0;
    const { app, adapter } = await appFor((app) => {
      app.router.get('/', (ctx) => {
        ctx.defer?.(dispose);
        return ctx.response.stream(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++;
                if (pulls === 1) controller.enqueue(bytes);
                else if (mode === 'error') controller.error(new Error('source failed'));
                else if (mode === 'end' || mode === 'end-sync') controller.close();
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        );
      });
    });
    try {
      const result = adapter.handler!(request());
      expect(result).not.toBeInstanceOf(Promise);
      const snapshot = (await result).snapshot();
      expect(snapshot.streaming).toBe(true);
      if (!snapshot.streaming) throw new Error('expected stream');
      expect(dispose).not.toHaveBeenCalled();
      expect(pulls).toBe(0);
      const reader = snapshot.body.getReader();
      expect((await reader.read()).value).toEqual(bytes);
      expect(dispose).not.toHaveBeenCalled();
      if (mode === 'end' || mode === 'end-sync') expect((await reader.read()).done).toBe(true);
      else if (mode === 'error') await expect(reader.read()).rejects.toThrow('source failed');
      else {
        const reason = new Error('cancelled');
        if (mode === 'cancel-error') await expect(reader.cancel(reason)).rejects.toBe(reason);
        else await reader.cancel(reason);
        expect(cancel).toHaveBeenCalledWith(reason);
      }
      expect(dispose).toHaveBeenCalledOnce();
      await reader.cancel().catch(() => {});
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await app.stop();
    }
  },
);

it('releases the request when the error responder itself throws, so stop() does not stall', async () => {
  const cleaned: string[] = [];
  const { app, adapter } = await appFor((app) => {
    app.router.get('/broken-responder', (ctx) => {
      ctx.defer?.(() => {
        cleaned.push('cleanup');
      });
      ctx.state.set(ERROR_RESPONDER_STATE_KEY, {
        respond(): void {
          throw new Error('responder broke');
        },
      });
      throw new Error('handler failed');
    });
  });
  // The responder's throw still surfaces to the caller, as it did before M125.
  expect(() => adapter.handler?.(request('/broken-responder'))).toThrow('responder broke');
  expect(cleaned).toEqual(['cleanup']);
  // A leaked in-flight count would hold stop() until its 10 s drain deadline.
  const stopped = app.stop().then(() => 'stopped');
  const timeout = new Promise((resolve) => setTimeout(() => resolve('stalled'), 2000));
  await expect(Promise.race([stopped, timeout])).resolves.toBe('stopped');
});
