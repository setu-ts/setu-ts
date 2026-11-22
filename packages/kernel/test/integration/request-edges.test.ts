/**
 * Request-path behaviours that differed between runtimes or were silent:
 * implicit `HEAD` on `GET` routes, cleanup when the client leaves, a failed
 * response stream logged once, and streamed RPC replies holding the drain.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IGrpcService,
  IHttpAdapter,
  IPlugin,
  IPluginContext,
  RpcReply,
} from '@setu-ts/common';

import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';
import { recordingLogger, withMessage } from '../fixtures/recording-logger.ts';
import type { LogCall } from '../fixtures/recording-logger.ts';

const encoder = new TextEncoder();

/** Lets pending promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A body the test feeds by hand; never ends unless told to. */
function manualStream(onCancel?: () => void): {
  stream: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      onCancel?.();
    },
  });
  return {
    stream,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

/** A runtime plugin over a fake with a manual clock. */
function fakeRuntimeFor(fake: ReturnType<typeof createFakeRuntime>): IPlugin {
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/**
 * A fake runtime whose timers fire at their absolute deadlines on a
 * cumulative clock (the shared fixture compares each timer with one tick).
 * Same shape as `createFakeRuntime()` for `runtime` and `tick`.
 */
function deadlineFake(): ReturnType<typeof createFakeRuntime> & { run(ms: number): Promise<void> } {
  const base = createFakeRuntime();
  let now = 0;
  let next = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const runtime = Object.assign(Object.create(base.runtime) as typeof base.runtime, {
    hrtime: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      next++;
      timers.set(next, { due: now + ms, fn });
      return next;
    },
    clearTimeout: (handle: unknown) => void timers.delete(handle as number),
  });
  /** The earliest timer due by `target`, if any. */
  const earliest = (target: number): [number, { due: number; fn: () => void }] | undefined => {
    let found: [number, { due: number; fn: () => void }] | undefined;
    for (const entry of timers) {
      if (entry[1].due <= target && (found === undefined || entry[1].due < found[1].due)) {
        found = entry;
      }
    }
    return found;
  };
  /**
   * Advances to `now + ms`, firing each timer at its deadline and letting the
   * promise callbacks it starts run before the next, so a timer scheduled by
   * a continuation (the next drain poll) fires within the same advance.
   */
  const run = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (let due = earliest(target); due !== undefined; due = earliest(target)) {
      timers.delete(due[0]);
      now = due[1].due;
      due[1].fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    now = target;
    await flush();
  };
  return { ...base, runtime, tick: (ms) => void run(ms), run };
}

describe('implicit HEAD on GET routes (V13-113)', () => {
  it('answers HEAD from a GET route with its headers and no body', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.router.get('/doc', (ctx) => {
      return ctx.response.header('x-doc', 'yes').json({ hello: 'world' });
    });
    await app.start();
    const get = await app.inject({ method: 'GET', url: '/doc' });
    const head = await app.inject({ method: 'HEAD', url: '/doc' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get('x-doc')).toBe('yes');
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));

    const dispatched = await app.dispatch!(new Request('http://localhost/doc', { method: 'HEAD' }));
    expect(dispatched.status).toBe(200);
    expect(await dispatched.text()).toBe('');
  });

  it('cancels a streamed GET body under HEAD so its cleanup runs', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    let cancelled = false;
    let cleaned = 0;
    app.router.get('/feed', (ctx) => {
      ctx.defer?.(() => {
        cleaned++;
      });
      return ctx.response.stream(
        manualStream(() => {
          cancelled = true;
        }).stream,
      );
    });
    await app.start();
    const head = await app.inject({ method: 'HEAD', url: '/feed' });
    await flush();
    expect(head.body).toBeNull();
    expect(cancelled).toBe(true);
    expect(cleaned).toBe(1);
  });

  it('prefers an explicit HEAD route at equal rank, and a specific GET over a catch-all HEAD', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.router.get('/same', (ctx) => {
      return ctx.response.header('x-from', 'get').text('g');
    });
    app.router.head('/same', (ctx) => {
      return ctx.response.header('x-from', 'head').text('');
    });
    app.router.get('/assets/*', (ctx) => {
      return ctx.response.header('x-from', 'asset').text('a');
    });
    app.router.head('/*', (ctx) => {
      return ctx.response.header('x-from', 'catch-all').text('');
    });
    await app.start();
    expect((await app.inject({ method: 'HEAD', url: '/same' })).headers.get('x-from')).toBe('head');
    expect((await app.inject({ method: 'HEAD', url: '/assets/a.js' })).headers.get('x-from')).toBe(
      'asset',
    );
    expect((await app.inject({ method: 'HEAD', url: '/other' })).headers.get('x-from')).toBe(
      'catch-all',
    );
    // GET is unaffected by HEAD routes.
    expect((await app.inject({ method: 'GET', url: '/same' })).body).toBe('g');
  });
});

describe('cleanup when the client leaves (V13-200)', () => {
  it('logs an abort at once but keeps the cleanup of a handler that never settles', async () => {
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    let cleaned = 0;
    app.router.get('/hang', (ctx) => {
      ctx.defer?.(() => {
        cleaned++;
      });
      return new Promise<never>(() => {});
    });
    await app.start();
    const client = new AbortController();
    void app.dispatch!(new Request('http://localhost/hang', { signal: client.signal }));
    await flush();
    expect(cleaned).toBe(0);
    client.abort();
    await flush();
    // The handler still holds what it registered (security audit, §3.12 revised).
    expect(cleaned).toBe(0);
    expect(withMessage(calls, 'Request aborted before completion')[0]?.metadata).toMatchObject({
      method: 'GET',
      path: '/hang',
    });
  });

  it('runs the cleanups when the handler settles after the abort, and logs the abort once', async () => {
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.router.get('/late', async (ctx) => {
      ctx.defer?.(() => {
        events.push('cleanup');
      });
      await gate;
      events.push('handler settled');
      return ctx.response.stream(manualStream().stream);
    });
    await app.start();
    const client = new AbortController();
    const served = app.dispatch!(new Request('http://localhost/late', { signal: client.signal }));
    await flush();
    client.abort();
    await flush();
    expect(events).toEqual([]);
    release();
    await served;
    await flush();
    expect(events).toEqual(['handler settled', 'cleanup']);
    expect(withMessage(calls, 'Request aborted before completion')).toHaveLength(1);
  });

  it('runs the cleanup of a stream the client stops reading without cancelling', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    let cleaned = 0;
    let sourceCancelled = false;
    app.router.get('/stream', (ctx) => {
      ctx.defer?.(() => {
        cleaned++;
      });
      const body = manualStream(() => {
        sourceCancelled = true;
      });
      body.push('first');
      return ctx.response.stream(body.stream);
    });
    await app.start();
    const client = new AbortController();
    const response = await app.dispatch!(
      new Request('http://localhost/stream', { signal: client.signal }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    // workerd's shape: the client is gone, the body is never cancelled.
    client.abort();
    await flush();
    expect(cleaned).toBe(1);
    expect(sourceCancelled).toBe(true);
  });

  it('runs a cleanup once when the request aborts after the response settled', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    let cleaned = 0;
    app.router.get('/quick', (ctx) => {
      ctx.defer?.(() => {
        cleaned++;
      });
      return ctx.response.text('ok');
    });
    await app.start();
    const client = new AbortController();
    const response = await app.dispatch!(
      new Request('http://localhost/quick', { signal: client.signal }),
    );
    expect(await response.text()).toBe('ok');
    client.abort();
    await flush();
    expect(cleaned).toBe(1);
  });

  it('keeps the cleanup of a running handler when the signal aborts after an early response (code-review M2)', async () => {
    // Deno's legacy `request.signal` aborts after every successful response.
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    let release!: () => void;
    const handlerDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    app.middleware.add(
      (ctx, next) => {
        void next();
        return Promise.resolve(void ctx.response.status(202).text('accepted'));
      },
      { name: 'early', priority: 1 },
    );
    app.router.get('/work', async (ctx) => {
      ctx.defer?.(() => void order.push('cleanup'));
      await handlerDone;
      order.push('handler done');
      return ctx.response.text('late');
    });
    await app.start();
    const client = new AbortController();
    const response = await app.dispatch!(
      new Request('http://localhost/work', { signal: client.signal }),
    );
    expect(response.status).toBe(202);
    await flush();
    client.abort();
    await flush();
    expect(order).toEqual([]);
    expect(withMessage(calls, 'Request aborted before completion')).toHaveLength(0);
    release();
    await flush();
    expect(order).toEqual(['handler done', 'cleanup']);
  });

  it('logs nothing for an abort of a request that deferred nothing', async () => {
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    app.router.get('/hang', () => new Promise<never>(() => {}));
    await app.start();
    const client = new AbortController();
    void app.dispatch!(new Request('http://localhost/hang', { signal: client.signal }));
    await flush();
    client.abort();
    await flush();
    expect(withMessage(calls, 'Request aborted before completion')).toHaveLength(0);
  });
});

describe('resources a running handler holds when its client leaves (security audit)', () => {
  it('never admits more handlers than a limit released through defer', async () => {
    const LIMIT = 2;
    let running = 0;
    let active = 0;
    let maxActive = 0;
    const limiter: IPlugin = {
      name: 'limiter',
      version: '1.0.0',
      register(ctx: IPluginContext) {
        ctx.middleware.add((c, next) => {
          if (running >= LIMIT) return c.response.status(503).text('busy');
          running++;
          c.defer?.(() => {
            running--;
          });
          return next();
        });
      },
    };
    const app = createApplication({ plugins: [runtimePlugin(), limiter] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.router.get('/work', async (ctx) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return ctx.response.text('done');
    });
    await app.start();
    const served: Promise<Response>[] = [];
    try {
      // Two handlers admitted and held on the gate; their clients leave.
      for (let i = 0; i < LIMIT; i++) {
        const client = new AbortController();
        served.push(app.dispatch!(new Request('http://localhost/work', { signal: client.signal })));
        await flush();
        client.abort();
        await flush();
      }
      // The slots are still held by running handlers: the next request is
      // refused. Not awaited, so a limiter that admitted it would fail the
      // assertions below instead of hanging on the gate (CodeRabbit).
      let third: Response | undefined;
      served.push(
        app.dispatch!(new Request('http://localhost/work')).then((response) => (third = response)),
      );
      await flush();
      expect(third?.status).toBe(503);
      expect(active).toBe(LIMIT);
      expect(maxActive).toBeLessThanOrEqual(LIMIT);
    } finally {
      release();
      await Promise.all(served);
      expect(running).toBe(0);
      await app.stop();
    }
  });
});

describe('abort handling on the remaining settle paths (CodeRabbit)', () => {
  it('cancels an early streamed response source when its client leaves, handler still running', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    let cancelled = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const early: IPlugin = {
      name: 'early',
      version: '1.0.0',
      register(ctx: IPluginContext) {
        ctx.middleware.add((c, next) => {
          void next();
          return c.response.stream(manualStream(() => void cancelled++).stream);
        });
      },
    };
    app.register(early);
    app.router.get('/work', async (ctx) => {
      await gate;
      return ctx.response.text('late');
    });
    await app.start();
    const client = new AbortController();
    await app.dispatch!(new Request('http://localhost/work', { signal: client.signal }));
    client.abort();
    await flush();
    expect(cancelled).toBe(1);
    release();
    await flush();
    await app.stop();
  });

  it('reports an already-aborted request whose synchronous handler settles in the same turn', async () => {
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    app.router.get('/quick', (ctx) => {
      ctx.defer?.(() => {});
      return ctx.response.text('ok');
    });
    await app.start();
    const client = new AbortController();
    client.abort();
    await app.dispatch!(new Request('http://localhost/quick', { signal: client.signal }));
    await flush();
    expect(withMessage(calls, 'Request aborted before completion')).toHaveLength(1);
    await app.stop();
  });

  it('reports a client that leaves while a buffered response waits for its asynchronous cleanup', async () => {
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    let finishCleanup!: () => void;
    app.router.get('/slow-cleanup', (ctx) => {
      ctx.defer?.(
        () =>
          new Promise<void>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      return ctx.response.text('ok');
    });
    await app.start();
    const client = new AbortController();
    const served = app.dispatch!(
      new Request('http://localhost/slow-cleanup', { signal: client.signal }),
    );
    await flush();
    client.abort();
    await flush();
    expect(withMessage(calls, 'Request aborted before completion')).toHaveLength(1);
    finishCleanup();
    await served;
    await app.stop();
  });

  it('logs the status the client received when an early stream fails after the handler changed it', async () => {
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failSource!: () => void;
    const early: IPlugin = {
      name: 'early-202',
      version: '1.0.0',
      register(ctx: IPluginContext) {
        ctx.middleware.add((c, next) => {
          void next();
          return c.response.status(202).stream(
            new ReadableStream<Uint8Array>({
              start(controller) {
                failSource = () => controller.error(new Error('source failed'));
              },
            }),
          );
        });
      },
    };
    app.register(early);
    app.router.get('/accepted', async (ctx) => {
      await gate;
      return ctx.response.status(500).text('late');
    });
    await app.start();
    const response = await app.dispatch!(new Request('http://localhost/accepted'));
    expect(response.status).toBe(202);
    const reading = response
      .body!.getReader()
      .read()
      .catch(() => undefined);
    release();
    await flush();
    failSource();
    await reading;
    await flush();
    expect(withMessage(calls, 'Response stream failed')[0]?.metadata).toMatchObject({
      status: 202,
    });
    await app.stop();
  });

  it('hands app.fetch() a HEAD answer with no body, cancelling a discarded stream', async () => {
    let cancelled = 0;
    const adapter: IPlugin = {
      name: 'stream-adapter',
      version: '1.0.0',
      provides: [CAPABILITIES.HTTP_ADAPTER],
      register(ctx: IPluginContext) {
        ctx.services.register(CAPABILITIES.HTTP_ADAPTER, {
          setHandler: () => {},
          listen: () => Promise.resolve({}),
          close: () => Promise.resolve(),
          fetch: () =>
            Promise.resolve(
              new Response(manualStream(() => void cancelled++).stream, {
                status: 200,
                headers: { 'content-length': '5', 'x-kept': 'yes' },
              }),
            ),
        } as unknown as IHttpAdapter);
      },
    };
    const app = createApplication({ plugins: [runtimePlugin(), adapter] });
    await app.start();
    const head = await app.fetch(new Request('http://localhost/doc', { method: 'HEAD' }));
    await flush();
    expect(head.status).toBe(200);
    expect(head.headers.get('x-kept')).toBe('yes');
    expect(head.body).toBeNull();
    expect(cancelled).toBe(1);
    const get = await app.fetch(new Request('http://localhost/doc'));
    expect(get.body).not.toBeNull();
    await get.body!.cancel();
    await app.stop();
  });
});

describe('round-2 review (CodeRabbit)', () => {
  it('returns an inject() HEAD answer even when the source cancel() never settles', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.router.get('/stuck', (ctx) =>
      ctx.response.stream(
        new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) }),
      ),
    );
    await app.start();
    const head = await app.inject({ method: 'HEAD', url: '/stuck' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBeNull();
  });

  it('treats a lowercase inject() head like HEAD', async () => {
    const app = createApplication({ plugins: [runtimePlugin()] });
    app.router.get('/doc', (ctx) => ctx.response.header('x-doc', 'yes').text('body'));
    await app.start();
    const head = await app.inject({ method: 'head' as never, url: '/doc' });
    expect(head.statusCode).toBe(200);
    expect(head.headers.get('x-doc')).toBe('yes');
    expect(head.body).toBeNull();
    await app.stop();
  });

  it('cancels a plain stream when its client leaves, without holding the drain', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({ plugins: [fakeRuntimeFor(fake)] });
    let cancelled = 0;
    app.router.get('/events', (ctx) =>
      ctx.response.stream(manualStream(() => void cancelled++).stream),
    );
    await app.start({ drainTimeoutMs: 1_000 });
    const client = new AbortController();
    await app.dispatch!(new Request('http://localhost/events', { signal: client.signal }));
    client.abort();
    await flush();
    expect(cancelled).toBe(1);
    let stopped = false;
    void app.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(true);
  });

  it('warns once for an early stream whose source cancel() stalls past 30 s', async () => {
    const fake = createFakeRuntime();
    const calls: LogCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const early: IPlugin = {
      name: 'early-stalled',
      version: '1.0.0',
      register(ctx: IPluginContext) {
        ctx.middleware.add((c, next) => {
          void next();
          return c.response.stream(
            new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) }),
          );
        });
      },
    };
    const app = createApplication({
      plugins: [fakeRuntimeFor(fake), recordingLogger(calls), early],
    });
    app.router.get('/work', async (ctx) => {
      await gate;
      return ctx.response.text('late');
    });
    await app.start({ drainTimeoutMs: 50 });
    const client = new AbortController();
    await app.dispatch!(new Request('http://localhost/work', { signal: client.signal }));
    client.abort();
    release();
    await flush();
    fake.tick(30_000);
    await flush();
    expect(
      withMessage(
        calls,
        'Request cleanup still waiting for the response stream to stop; its resources are still held',
      ),
    ).toHaveLength(1);
  });
});

describe('a failed response stream (V13-256)', () => {
  it('logs the failure once against the request and still errors the body', async () => {
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), recordingLogger(calls)] });
    app.router.get('/broken', (ctx) => {
      let sent = false;
      return ctx.response.stream(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode('a'));
              return;
            }
            controller.error(new Error('source failed'));
          },
        }),
      );
    });
    await app.start();
    const response = await app.dispatch!(new Request('http://localhost/broken'));
    await expect(response.text()).rejects.toThrow('source failed');
    const lines = withMessage(calls, 'Response stream failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      metadata: { method: 'GET', path: '/broken', status: 200, error: 'Error: source failed' },
    });
    expect(typeof lines[0]?.metadata?.['requestId']).toBe('string');
  });
});

describe('streamed RPC replies hold the drain (V13-23)', () => {
  /** A gRPC double answering every call with the given streamed body. */
  function grpcReplying(body: ReadableStream<Uint8Array>): IPlugin {
    const service = {
      available: true,
      addService: () => undefined,
      claims: () => true,
      handleRequest: () => Promise.resolve(new Response(null)),
      handleRpc: (): Promise<RpcReply> =>
        Promise.resolve({ status: 200, headers: new Headers(), body }),
    } as unknown as IGrpcService;
    return {
      name: 'fake-grpc',
      version: '1.0.0',
      provides: [CAPABILITIES.GRPC],
      register(ctx: IPluginContext) {
        ctx.services.register(CAPABILITIES.GRPC, service);
      },
    };
  }

  /** A runtime plugin over a fake with a manual clock. */
  function fakeRuntime(fake: ReturnType<typeof createFakeRuntime>): IPlugin {
    return {
      name: 'fake-runtime',
      version: '1.0.0',
      provides: [CAPABILITIES.RUNTIME],
      register(ctx: IPluginContext) {
        ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
      },
    };
  }

  async function stopsWithin(
    fake: ReturnType<typeof createFakeRuntime>,
    stopping: Promise<void>,
  ): Promise<boolean> {
    let done = false;
    void stopping.then(() => {
      done = true;
    });
    for (let i = 0; i < 4; i++) {
      fake.tick(50);
      await flush();
    }
    return done;
  }

  /** A one-chunk source whose cancel() settles only when released (never, unless told). */
  function heldCancel(): { stream: ReadableStream<Uint8Array>; release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event'));
      },
      cancel: () => held,
    });
    return { stream, release };
  }

  /** Ticks the fake clock by `ms` and lets callbacks run. */
  async function advance(fake: ReturnType<typeof createFakeRuntime>, ms: number): Promise<void> {
    fake.tick(ms);
    await flush();
  }

  it('keeps stop() waiting until a streamed RPC reply ends', async () => {
    const fake = createFakeRuntime();
    const body = manualStream();
    body.push('message');
    const app = createApplication({ plugins: [fakeRuntime(fake), grpcReplying(body.stream)] });
    await app.start();
    const response = await app.dispatch!(
      new Request('http://localhost/pkg.Svc/Watch', { method: 'POST' }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    const stopping = app.stop();
    expect(await stopsWithin(fake, stopping)).toBe(false);
    body.close();
    await reader.read();
    expect(await stopsWithin(fake, stopping)).toBe(true);
  });

  it.each([false, true])(
    'holds stop() while a streamed RPC reply source cancel() is pending, until it settles or the drain bound (released: %s)',
    async (released) => {
      const fake = deadlineFake();
      let cleaned = 0;
      const deferring: IPlugin = {
        name: 'deferring',
        version: '1.0.0',
        register(ctx: IPluginContext) {
          ctx.middleware.add((c, next) => {
            c.defer?.(() => {
              cleaned++;
            });
            return next();
          });
        },
      };
      const source = heldCancel();
      const app = createApplication({
        plugins: [fakeRuntime(fake), grpcReplying(source.stream), deferring],
      });
      await app.start({ drainTimeoutMs: 1_000 });
      const client = new AbortController();
      const response = await app.dispatch!(
        new Request('http://localhost/pkg.Svc/Watch', { method: 'POST', signal: client.signal }),
      );
      await response.body!.getReader().read();
      client.abort();
      await flush();
      let stopped = false;
      void app.stop().then(() => {
        stopped = true;
      });
      await fake.run(25);
      // Still in the drain: the request's cleanups wait for the source.
      expect(stopped).toBe(false);
      if (released) {
        source.release();
        await flush();
        await flush();
        expect(cleaned).toBe(1);
        // The drain's next poll (every 50 ms) sees the request gone.
        await fake.run(50);
        expect(stopped).toBe(true);
        return;
      }
      await fake.run(50);
      await fake.run(900);
      // Still held 25 ms before the 1 000 ms bound, on a clock whose timers
      // fire at their absolute deadlines (CodeRabbit).
      expect(stopped).toBe(false);
      await fake.run(25);
      // The drain bound ends the wait exactly at 1 000 ms; the cleanups stay
      // with the source.
      expect(stopped).toBe(true);
      expect(cleaned).toBe(0);
    },
  );

  it.each([false, true])(
    'holds stop() while a plain streamed route source cancel() is pending, until it settles or the drain bound (released: %s)',
    async (released) => {
      const fake = deadlineFake();
      let cleaned = 0;
      const source = heldCancel();
      const app = createApplication({ plugins: [fakeRuntime(fake)] });
      app.router.get('/stuck', (ctx) => {
        ctx.defer?.(() => {
          cleaned++;
        });
        return ctx.response.stream(source.stream);
      });
      await app.start({ drainTimeoutMs: 1_000 });
      const client = new AbortController();
      const response = await app.dispatch!(
        new Request('http://localhost/stuck', { signal: client.signal }),
      );
      await response.body!.getReader().read();
      client.abort();
      await flush();
      let stopped = false;
      void app.stop().then(() => {
        stopped = true;
      });
      await fake.run(25);
      expect(stopped).toBe(false);
      if (released) {
        source.release();
        await flush();
        await flush();
        expect(cleaned).toBe(1);
        // The drain's next poll (every 50 ms) sees the request gone.
        await fake.run(50);
        expect(stopped).toBe(true);
        return;
      }
      await fake.run(50);
      await fake.run(900);
      expect(stopped).toBe(false);
      await fake.run(25);
      expect(stopped).toBe(true);
      expect(cleaned).toBe(0);
    },
  );

  /** An app on the fake clock with a stuck streamed route, its client already gone. */
  async function stuckAfterAbort(withLogger: boolean): Promise<{
    fake: ReturnType<typeof createFakeRuntime>;
    calls: LogCall[];
    app: ReturnType<typeof createApplication>;
    timers: { mock: { calls: unknown[][] } };
  }> {
    const fake = createFakeRuntime();
    const timers = vi.spyOn(fake.runtime, 'setTimeout');
    const calls: LogCall[] = [];
    const app = createApplication({
      plugins: [fakeRuntime(fake), ...(withLogger ? [recordingLogger(calls)] : [])],
    });
    app.router.get('/stuck', (ctx) => {
      ctx.defer?.(() => {});
      return ctx.response.stream(heldCancel().stream);
    });
    await app.start({ drainTimeoutMs: 50 });
    const client = new AbortController();
    const response = await app.dispatch!(
      new Request('http://localhost/stuck?token=secret', {
        signal: client.signal,
        headers: { authorization: 'Bearer secret' },
      }),
    );
    await response.body!.getReader().read();
    client.abort();
    await flush();
    return { fake, calls, app, timers };
  }

  const STALL =
    'Request cleanup still waiting for the response stream to stop; its resources are still held';

  it('warns once, with only the request id, method, path and wait, when a stream stays stuck 30 s', async () => {
    const { fake, calls, app } = await stuckAfterAbort(true);
    await advance(fake, 30_000);
    await advance(fake, 30_000);
    const stalls = withMessage(calls, STALL);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.level).toBe('warn');
    expect(Object.keys(stalls[0]!.metadata ?? {}).sort()).toEqual([
      'method',
      'path',
      'requestId',
      'waitedMs',
    ]);
    expect(stalls[0]!.metadata).toMatchObject({ method: 'GET', path: '/stuck', waitedMs: 30_000 });
    expect(JSON.stringify(stalls[0])).not.toContain('secret');
    void app.stop();
    await advance(fake, 1_000);
  });

  it('sets no stall timer when no logger is registered', async () => {
    const { fake, timers, app } = await stuckAfterAbort(false);
    expect(timers.mock.calls.some((call) => call[1] === 30_000)).toBe(false);
    void app.stop();
    await advance(fake, 1_000);
  });

  it('sets no stall timer for an abort that comes after stop()', async () => {
    const fake = createFakeRuntime();
    const timers = vi.spyOn(fake.runtime, 'setTimeout');
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [fakeRuntime(fake), recordingLogger(calls)] });
    app.router.get('/stuck', (ctx) => {
      ctx.defer?.(() => {});
      return ctx.response.stream(heldCancel().stream);
    });
    await app.start({ drainTimeoutMs: 50 });
    const client = new AbortController();
    const response = await app.dispatch!(
      new Request('http://localhost/stuck', { signal: client.signal }),
    );
    await response.body!.getReader().read();
    let stopped = false;
    void app.stop().then(() => {
      stopped = true;
    });
    await advance(fake, 50);
    expect(stopped).toBe(true);
    // The client leaves only after the application stopped.
    client.abort();
    await flush();
    await advance(fake, 30_000);
    expect(timers.mock.calls.some((call) => call[1] === 30_000)).toBe(false);
    expect(withMessage(calls, STALL)).toHaveLength(0);
  });

  it('clears a pending stall timer at stop()', async () => {
    const { fake, calls, app } = await stuckAfterAbort(true);
    let stopped = false;
    void app.stop().then(() => {
      stopped = true;
    });
    await advance(fake, 50);
    expect(stopped).toBe(true);
    await advance(fake, 30_000);
    expect(withMessage(calls, STALL)).toHaveLength(0);
  });

  it('does not hold the drain for a plain streamed route', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({ plugins: [fakeRuntime(fake)] });
    const body = manualStream();
    app.router.get('/events', (ctx) => {
      return ctx.response.stream(body.stream);
    });
    await app.start();
    await app.dispatch!(new Request('http://localhost/events'));
    expect(await stopsWithin(fake, app.stop())).toBe(true);
  });
});
