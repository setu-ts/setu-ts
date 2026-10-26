import { expect, it, vi } from 'vitest';
import { CAPABILITIES, ERROR_RESPONDER_STATE_KEY } from '@setu-ts/common';
import type { ILogger, IPlugin, IRequest, IRequestContext, TimerHandle } from '@setu-ts/common';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { ResponseBuilder } from '../../src/context/response.ts';

async function appFor(
  register: (app: ReturnType<typeof createApplication>) => void,
  logger?: ILogger,
) {
  const fake = createFakeRuntime();
  fake.runtime.setTimeout = (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle;
  fake.runtime.clearTimeout = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
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
  return { app, adapter: fake.adapter, runtime: fake.runtime };
}

function request(path = '/'): IRequest {
  return { method: 'GET', url: `http://test${path}`, path, headers: new Headers() } as IRequest;
}

it('M125 fast cleanup: buffered synchronous completion takes no snapshot and releases in-flight once', async () => {
  const cleanups: number[] = [];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, adapter, runtime } = await appFor((app) => {
    app.router.get('/', (ctx) => {
      ctx.defer?.(() => {
        cleanups.push(1);
      });
      ctx.defer?.(() => {
        cleanups.push(2);
      });
      return ctx.response.text('ready');
    });
    app.router.get('/held', (ctx) => {
      ctx.defer?.(() => {
        entered();
        return held;
      });
      return ctx.response.text('held');
    });
  });
  const snapshot = vi.spyOn(ResponseBuilder.prototype, 'snapshot');
  try {
    const first = adapter.handler!(request());
    const second = adapter.handler!(request());
    expect(first).not.toBeInstanceOf(Promise);
    expect(second).not.toBeInstanceOf(Promise);
    expect(cleanups).toEqual([2, 1, 2, 1]);
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
    expect((await first).snapshot().body).toBe('ready');
    // If either request was counted twice, the held request below would not drain.
    const result = adapter.handler!(request('/held'));
    await started;
    const polling = vi.spyOn(runtime, 'setTimeout');
    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => {
      expect(polling).toHaveBeenCalled();
    });
    expect(stopped).toBe(false);
    release();
    await result;
    await stopping;
    expect(polling).toHaveBeenCalledTimes(1);
    polling.mockRestore();
  } finally {
    release();
    snapshot.mockRestore();
    await app.stop();
  }
});

it('M125 response streaming body: exposes the body without creating a snapshot', () => {
  const response = new ResponseBuilder();
  expect(response.streamingBody).toBeUndefined();
  response.text('buffered');
  expect(response.streamingBody).toBeUndefined();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  response.stream(body);
  expect(response.streamingBody).toBe(body);
});

it.each([
  'buffered',
  'sync-failure',
  'async-failure',
  'responder-failure',
  'end',
  'error',
  'cancel',
] as const)('bounds asynchronous deferred cleanup on %s and releases shutdown', async (mode) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const warn = vi.fn();
  const logger = { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as ILogger;
  const next = vi.fn();
  let rejectExpired!: (error: Error) => void;
  const expired = new Promise<void>((_resolve, reject) => {
    rejectExpired = reject;
  });
  let releaseInside!: () => void;
  const inside = new Promise<void>((resolve) => {
    releaseInside = resolve;
  });
  const { app, adapter, runtime } = await appFor((app) => {
    app.router.get('/inside', (ctx) => {
      ctx.defer?.(() => inside);
      return ctx.response.text('inside');
    });
    app.router.get('/', (ctx) => {
      ctx.defer?.(next);
      // Two independent bounds prove the timeout is per callback, not per list.
      ctx.defer?.(() => expired);
      ctx.defer?.(() => new Promise<void>(() => {}));
      if (mode === 'sync-failure' || mode === 'async-failure') {
        if (mode === 'sync-failure') throw new Error('handler failed');
        return Promise.reject(new Error('handler failed'));
      }
      if (mode === 'responder-failure') {
        ctx.state.set(ERROR_RESPONDER_STATE_KEY, {
          respond(): void {
            throw new Error('responder failed');
          },
        });
        throw new Error('handler failed');
      }
      if (mode === 'end' || mode === 'error' || mode === 'cancel') {
        return ctx.response.stream(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (mode === 'error') controller.error(new Error('source failed'));
              else if (mode === 'end') controller.close();
            },
          }),
        );
      }
      return ctx.response.status(201).text('unchanged');
    });
  }, logger);
  try {
    // Positive control: settling within the bound is awaited and clears its timer.
    let insideReturned = false;
    const insideResult = Promise.resolve(adapter.handler!(request('/inside'))).then((response) => {
      insideReturned = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(insideReturned).toBe(false);
    releaseInside();
    expect((await insideResult).snapshot().body).toBe('inside');
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();

    const timer = vi.spyOn(runtime, 'setTimeout');
    let completed = false;
    let outcome: unknown;
    let completion: Promise<void>;
    if (mode === 'responder-failure') {
      expect(() => adapter.handler!(request())).toThrow('responder failed');
      completion = Promise.resolve();
    } else {
      const response = adapter.handler!(request());
      if (mode === 'end' || mode === 'error' || mode === 'cancel') {
        const snapshot = (await response).snapshot();
        if (!snapshot.streaming) throw new Error('expected stream');
        const reader = snapshot.body.getReader();
        completion = (mode === 'cancel' ? reader.cancel() : reader.read()).then(
          (value) => {
            completed = true;
            outcome = value;
          },
          (error: unknown) => {
            completed = true;
            outcome = error;
          },
        );
      } else {
        completion = Promise.resolve(response).then((value) => {
          completed = true;
          outcome = value.snapshot();
        });
      }
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(completed).toBe(false);
    expect(next).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(next).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();

    // Start draining after the second callback starts: it must release within 5 s.
    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(stopped).toBe(false);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(51);
    expect(next).toHaveBeenCalledOnce();
    expect(stopped).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call).toEqual([
        'Deferred request cleanup failed',
        { error: expect.stringMatching(/timeout.*5000|5000.*timeout/i) },
      ]);
    }
    await completion;
    await stopping;
    if (mode === 'buffered') expect(outcome).toMatchObject({ status: 201, body: 'unchanged' });
    if (mode === 'sync-failure' || mode === 'async-failure')
      expect(outcome).toMatchObject({ status: 500 });
    if (mode === 'end') expect(outcome).toMatchObject({ done: true });
    if (mode === 'error') expect(outcome).toEqual(new Error('source failed'));
    rejectExpired(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    releaseInside();
    const stopping = app.stop();
    await vi.advanceTimersByTimeAsync(10_050);
    await stopping;
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

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

it.each(['end', 'error', 'cancel', 'cancel-error', 'cancel-pending', 'end-sync'] as const)(
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
        const pendingRead = mode === 'cancel-pending' ? reader.read() : undefined;
        if (pendingRead !== undefined) {
          await vi.waitFor(() => {
            expect(pulls).toBe(2);
          });
        }
        if (mode === 'cancel-error') await expect(reader.cancel(reason)).rejects.toBe(reason);
        else await reader.cancel(reason);
        if (pendingRead !== undefined) expect((await pendingRead).done).toBe(true);
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

it('cancels an unread streaming body when inject() refuses it, so cleanup runs and stop() does not stall', async () => {
  const cleaned: string[] = [];
  let sourceCancelled = false;
  const { app } = await appFor((app) => {
    app.router.get('/stream', (ctx) => {
      ctx.defer?.(() => {
        cleaned.push('cleanup');
      });
      return ctx.response.stream(
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            controller.enqueue(new TextEncoder().encode('chunk'));
          },
          cancel(): void {
            sourceCancelled = true;
          },
        }),
      );
    });
  });
  await expect(app.inject({ method: 'GET', url: '/stream' })).rejects.toThrow(
    /cannot read a streaming response body/,
  );
  expect(cleaned).toEqual(['cleanup']);
  expect(sourceCancelled).toBe(true);
  // A leaked in-flight count would hold stop() until its 10 s drain deadline.
  const stopped = app.stop().then(() => 'stopped');
  const timeout = new Promise((resolve) => setTimeout(() => resolve('stalled'), 2000));
  await expect(Promise.race([stopped, timeout])).resolves.toBe('stopped');
});

it('still reports the streaming refusal from inject() when cancelling the body fails', async () => {
  const cleaned: string[] = [];
  const { app } = await appFor((app) => {
    app.router.get('/stream', (ctx) => {
      ctx.defer?.(() => {
        cleaned.push('cleanup');
      });
      return ctx.response.stream(
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            controller.enqueue(new TextEncoder().encode('chunk'));
          },
          cancel(): void {
            throw new Error('source refused cancel');
          },
        }),
      );
    });
  });
  await expect(app.inject({ method: 'GET', url: '/stream' })).rejects.toThrow(
    /cannot read a streaming response body/,
  );
  expect(cleaned).toEqual(['cleanup']);
  await app.stop();
});
