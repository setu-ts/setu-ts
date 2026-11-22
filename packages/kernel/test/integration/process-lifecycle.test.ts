/**
 * What the process says when it stops, fails or is cut off, and the shutdown
 * drain: the fatal-error log, the stop and drain lines, the configurable drain
 * bound, the drain-start hook for the adapter, and a stop during start.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { FatalErrorOrigin, IHttpAdapter, IPlugin, IPluginContext } from '@setu-ts/common';

import { createApplication, StartCancelledError } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { recordingLogger, withMessage } from '../fixtures/recording-logger.ts';
import type { LogCall } from '../fixtures/recording-logger.ts';

type Fake = ReturnType<typeof createFakeRuntime>;

/** A runtime plugin over a fake, with an optional hook into its context. */
function runtimeWith(
  fake: Fake,
  onRegister?: (ctx: IPluginContext) => void,
  adapter: IHttpAdapter = fake.adapter,
): IPlugin {
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, adapter);
      onRegister?.(ctx);
    },
  };
}

/** Lets pending promise callbacks run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Advances the fake clock in drain-poll steps, letting the drain loop run between them. */
async function advance(fake: Fake, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    fake.tick(50);
    await flush();
  }
}

/** A promise with its resolver exposed. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Whether a promise has settled after the queue drains. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await flush();
  return done;
}

describe('fatal-error log (V13-11)', () => {
  it('subscribes once at start, logs a fatal line, and unsubscribes at stop', async () => {
    const fake = createFakeRuntime();
    const handlers: ((error: unknown, origin: FatalErrorOrigin) => void)[] = [];
    let unsubscribed = 0;
    Object.assign(fake.runtime, {
      onFatalError: (handler: (error: unknown, origin: FatalErrorOrigin) => void) => {
        handlers.push(handler);
        return () => {
          unsubscribed++;
        };
      },
    });
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimeWith(fake), recordingLogger(calls)] });
    await app.start();
    expect(handlers).toHaveLength(1);

    handlers[0]!(new Error('boom'), 'unhandledRejection');
    const [line] = withMessage(calls, 'Process failed');
    expect(line?.level).toBe('fatal');
    expect(line?.metadata).toMatchObject({
      origin: 'unhandledRejection',
      error: 'Error: boom',
    });

    const stopping = app.stop();
    await advance(fake, 100);
    await stopping;
    expect(unsubscribed).toBe(1);
  });

  it('unsubscribes after a failed start and is silent without a logger', async () => {
    const fake = createFakeRuntime();
    const handlers: ((error: unknown, origin: FatalErrorOrigin) => void)[] = [];
    let unsubscribed = 0;
    Object.assign(fake.runtime, {
      onFatalError: (handler: (error: unknown, origin: FatalErrorOrigin) => void) => {
        handlers.push(handler);
        return () => {
          unsubscribed++;
        };
      },
    });
    const app = createApplication({
      plugins: [
        runtimeWith(fake, (ctx) => {
          ctx.lifecycle.onInit(() => {
            throw new Error('init failed');
          });
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow('init failed');
    expect(unsubscribed).toBe(1);
    // No logger: the handler is a no-op rather than a throw.
    expect(() => handlers[0]!(new Error('late'), 'uncaughtException')).not.toThrow();
  });
});

describe('stop and drain log lines (V13-13)', () => {
  it('logs stopping, drain finished and stopped', async () => {
    const fake = createFakeRuntime();
    const calls: LogCall[] = [];
    const app = createApplication({ plugins: [runtimeWith(fake), recordingLogger(calls)] });
    await app.start({ port: 4200 });
    const stopping = app.stop();
    await advance(fake, 100);
    await stopping;

    expect(withMessage(calls, 'Server stopping')[0]).toMatchObject({
      level: 'info',
      metadata: { inFlight: 0 },
    });
    expect(withMessage(calls, 'Shutdown drain finished')[0]).toMatchObject({
      level: 'info',
      metadata: { remaining: 0, timedOut: false },
    });
    const [stopped] = withMessage(calls, 'Server stopped');
    expect(stopped?.level).toBe('info');
    expect(typeof stopped?.metadata?.['durationMs']).toBe('number');
    const order = calls.map((call) => call.message);
    expect(order.indexOf('Server stopping')).toBeLessThan(order.indexOf('Shutdown drain finished'));
    expect(order.indexOf('Shutdown drain finished')).toBeLessThan(order.indexOf('Server stopped'));
  });

  it('warns when the drain times out and when a hook fails', async () => {
    const fake = createFakeRuntime();
    const calls: LogCall[] = [];
    const held = deferred();
    const app = createApplication({
      plugins: [
        runtimeWith(fake, (ctx) => {
          ctx.lifecycle.onShutdown(() => {
            throw new Error('shutdown hook failed');
          });
        }),
        recordingLogger(calls),
      ],
    });
    app.router.get('/held', async (ctx) => {
      await held.promise;
      return ctx.response.text('late');
    });
    await app.start({ port: 4201, drainTimeoutMs: 100 });
    void app.inject({ method: 'GET', url: '/held' });
    await flush();

    const stopping = app.stop();
    stopping.catch(() => undefined);
    await advance(fake, 200);
    await expect(stopping).rejects.toThrow('shutdown hook failed');

    expect(withMessage(calls, 'Shutdown drain finished')[0]).toMatchObject({
      level: 'warn',
      metadata: { remaining: 1, timedOut: true },
    });
    expect(withMessage(calls, 'Server stopped')[0]).toMatchObject({
      level: 'warn',
      metadata: { error: 'Error: shutdown hook failed' },
    });
    held.resolve();
  });
});

describe('the drain bound is one setting (V13-26)', () => {
  it('waits up to drainTimeoutMs for an in-flight request', async () => {
    const fake = createFakeRuntime();
    const held = deferred();
    const app = createApplication({ plugins: [runtimeWith(fake)] });
    app.router.get('/held', async (ctx) => {
      await held.promise;
      return ctx.response.text('done');
    });
    await app.start({ port: 4202, drainTimeoutMs: 20_000 });
    const response = app.inject({ method: 'GET', url: '/held' });
    await flush();

    const stopping = app.stop();
    await advance(fake, 15_000);
    expect(await settled(stopping)).toBe(false);
    held.resolve();
    expect((await response).body).toBe('done');
    await advance(fake, 100);
    await stopping;
  });

  it('cuts the drain at 10 s by default', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({ plugins: [runtimeWith(fake)] });
    app.router.get('/held', () => new Promise<never>(() => {}));
    await app.start({ port: 4203 });
    void app.inject({ method: 'GET', url: '/held' });
    await flush();
    const stopping = app.stop();
    await advance(fake, 9_900);
    expect(await settled(stopping)).toBe(false);
    await advance(fake, 200);
    await stopping;
  });

  it.each([-1, 1.5, Number.NaN, 2_147_483_648, '5000'])(
    'refuses drainTimeoutMs %s before any plugin registers',
    async (value) => {
      const fake = createFakeRuntime();
      let registered = false;
      const app = createApplication({
        plugins: [
          runtimeWith(fake, () => {
            registered = true;
          }),
        ],
      });
      await expect(app.start({ drainTimeoutMs: value as number })).rejects.toThrow(TypeError);
      expect(registered).toBe(false);
      // Refused before registration, so the start is retryable.
      await app.start();
      expect(registered).toBe(true);
    },
  );
});

describe('drain start reaches the adapter (V13-23)', () => {
  it('calls beginDrain once, after the stopping hooks', async () => {
    const fake = createFakeRuntime();
    const order: string[] = [];
    const adapter = Object.assign(fake.adapter, {
      beginDrain: () => {
        order.push('beginDrain');
      },
    });
    const app = createApplication({
      plugins: [
        runtimeWith(
          fake,
          (ctx) => {
            ctx.lifecycle.onStopping(() => {
              order.push('stopping');
            });
          },
          adapter,
        ),
      ],
    });
    await app.start({ port: 4204 });
    const stopping = app.stop();
    await advance(fake, 100);
    await stopping;
    expect(order).toEqual(['stopping', 'beginDrain']);
  });

  it('survives a throwing beginDrain and skips it when not listening', async () => {
    const fake = createFakeRuntime();
    const calls: LogCall[] = [];
    let drains = 0;
    const adapter = Object.assign(fake.adapter, {
      beginDrain: () => {
        drains++;
        throw new Error('no sessions');
      },
    });
    const app = createApplication({
      plugins: [runtimeWith(fake, undefined, adapter), recordingLogger(calls)],
    });
    await app.start({ port: 4205 });
    const stopping = app.stop();
    await advance(fake, 100);
    await stopping;
    expect(drains).toBe(1);
    expect(withMessage(calls, 'Beginning the shutdown drain failed')[0]?.level).toBe('warn');

    const notListening = createApplication({ plugins: [runtimeWith(fake, undefined, adapter)] });
    await notListening.start();
    const second = notListening.stop();
    await advance(fake, 100);
    await second;
    expect(drains).toBe(1);
  });
});

describe('a stop during start cancels the start (V13-43)', () => {
  it('rejects start, runs the close hooks, and never listens', async () => {
    const fake = createFakeRuntime();
    const calls: LogCall[] = [];
    const hanging = deferred();
    const ran: string[] = [];
    let signal: AbortSignal | undefined;
    let pluginCtx!: IPluginContext;
    const app = createApplication({
      plugins: [
        runtimeWith(fake, (ctx) => {
          pluginCtx = ctx;
          signal = ctx.signal;
          ctx.lifecycle.onClose(() => {
            ran.push('close');
          });
          ctx.lifecycle.onStopping(() => {
            ran.push('stopping');
          });
          ctx.lifecycle.onShutdown(() => {
            ran.push('shutdown');
          });
          ctx.lifecycle.onInit(() => hanging.promise);
        }),
        recordingLogger(calls),
      ],
    });
    const starting = app.start({ port: 4206 });
    starting.catch(() => undefined);
    await flush();

    await app.stop();
    await expect(starting).rejects.toBeInstanceOf(StartCancelledError);
    expect(ran).toEqual(['close']);
    expect(signal?.aborted).toBe(true);
    expect(withMessage(calls, 'Startup cancelled')[0]?.level).toBe('warn');

    // The abandoned hook finishes later and registers a close hook: it runs at
    // once, and the application still never listens.
    hanging.resolve();
    pluginCtx.lifecycle.onClose(() => {
      ran.push('late close');
    });
    await flush();
    expect(ran).toEqual(['close', 'late close']);
    expect(fake.adapter.listening).toBe(false);
    // A second stop returns at once.
    await app.stop();
  });

  it('closes a server whose listen resolved after the cancellation', async () => {
    const fake = createFakeRuntime();
    const bound = deferred<object>();
    let closed: unknown;
    const adapter: IHttpAdapter = {
      setHandler: () => undefined,
      fetch: () => new Response(null),
      listen: () => bound.promise,
      close: (handle) => {
        closed = handle;
        return Promise.resolve();
      },
    };
    const app = createApplication({ plugins: [runtimeWith(fake, undefined, adapter)] });
    const starting = app.start({ port: 4207 });
    starting.catch(() => undefined);
    await flush();
    await app.stop();
    await expect(starting).rejects.toBeInstanceOf(StartCancelledError);
    const handle = { server: 'late' };
    bound.resolve(handle);
    await flush();
    expect(closed).toBe(handle);
  });

  it('leaves nothing listening over repeated cancelled starts', async () => {
    for (let cycle = 0; cycle < 20; cycle++) {
      const fake = createFakeRuntime();
      const app = createApplication({
        plugins: [
          runtimeWith(fake, (ctx) => {
            ctx.lifecycle.onBootstrap(() => new Promise<never>(() => {}));
          }),
        ],
      });
      const starting = app.start({ port: 4300 + cycle });
      starting.catch(() => undefined);
      await flush();
      await app.stop();
      await expect(starting).rejects.toBeInstanceOf(StartCancelledError);
      expect(fake.adapter.listening).toBe(false);
    }
  });

  it('waits for a start that is already failing without calling it cancelled (code-review L2)', async () => {
    const fake = createFakeRuntime();
    const calls: LogCall[] = [];
    const closing = deferred();
    const app = createApplication({
      plugins: [
        runtimeWith(fake, (ctx) => {
          ctx.lifecycle.onClose(() => closing.promise);
          ctx.lifecycle.onInit(() => {
            throw new Error('init failed');
          });
        }),
        recordingLogger(calls),
      ],
    });
    const starting = app.start({ port: 4209 });
    starting.catch(() => undefined);
    await flush();
    // The failed start is now running its close hooks.
    const stopping = app.stop();
    // stop() waits for the failing start's close hooks.
    expect(await settled(stopping)).toBe(false);
    closing.resolve();
    await expect(starting).rejects.toThrow('init failed');
    await stopping;
    expect(withMessage(calls, 'Startup cancelled')).toHaveLength(0);
  });

  it('cancels a start that a plugin stops synchronously from register() (CodeRabbit)', async () => {
    const fake = createFakeRuntime();
    let stopping: Promise<void> | undefined;
    const app = createApplication({
      plugins: [
        runtimeWith(fake, (ctx) => {
          stopping = ctx.app.stop();
        }),
      ],
    });
    await expect(app.start({ port: 4211 })).rejects.toBeInstanceOf(StartCancelledError);
    await stopping;
    expect(fake.adapter.listening).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    'cancels, and never listens, when stop() lands %i microtask(s) after a bootstrap hook settles (code review)',
    async (depth) => {
      const fake = createFakeRuntime();
      const app = createApplication({
        plugins: [
          runtimeWith(fake, (ctx) => {
            ctx.lifecycle.onBootstrap(() => {
              let chain = Promise.resolve();
              for (let i = 0; i < depth; i++) chain = chain.then(() => undefined);
              void chain.then(() => app.stop());
            });
          }),
        ],
      });
      await expect(app.start({ port: 4213 })).rejects.toBeInstanceOf(StartCancelledError);
      await flush();
      expect(fake.adapter.listening).toBe(false);
    },
  );

  it('runs no further startup hook once the start is cancelled (CodeRabbit)', async () => {
    const fake = createFakeRuntime();
    const first = deferred();
    const ran: string[] = [];
    const app = createApplication({
      plugins: [
        runtimeWith(fake, (ctx) => {
          ctx.lifecycle.onInit(async () => {
            ran.push('init 1');
            await first.promise;
          });
          ctx.lifecycle.onInit(() => {
            ran.push('init 2');
          });
          ctx.lifecycle.onBootstrap(() => {
            ran.push('bootstrap');
          });
        }),
      ],
    });
    const starting = app.start({ port: 4212 });
    starting.catch(() => undefined);
    await flush();
    const stopping = app.stop();
    await expect(starting).rejects.toBeInstanceOf(StartCancelledError);
    await stopping;
    first.resolve();
    await flush();
    expect(ran).toEqual(['init 1']);
  });

  it('cancels a start that stop() reaches in the same turn', async () => {
    const fake = createFakeRuntime();
    const app = createApplication({ plugins: [runtimeWith(fake)] });
    const starting = app.start({ port: 4208 });
    starting.catch(() => undefined);
    const stopping = app.stop();
    await expect(starting).rejects.toBeInstanceOf(StartCancelledError);
    await stopping;
    expect(fake.adapter.listening).toBe(false);
  });
});
