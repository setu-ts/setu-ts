/* eslint-disable require-await */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  HandlerResult,
  ILogger,
  IRequest,
  IRequestContext,
  IResponse,
  IRuntimeServices,
  IServiceRegistry,
  LogLevel,
  LogMetadata,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { createRequestLoggerMiddleware } from '../../src/middleware/request-logger.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

interface RecordedEntry {
  level: LogLevel;
  message: string;
  metadata: LogMetadata;
}

/**
 * Recording logger whose `child()` records into the same shared entries
 * array, so the test can inspect what the middleware logged via the child.
 */
class SharedRecordingLogger implements ILogger {
  readonly level: LogLevel;
  readonly entries: RecordedEntry[] = [];
  readonly children: LogMetadata[] = [];

  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  fatal(message: string, metadata?: LogMetadata): void {
    this.entries.push({ level: 'fatal', message, metadata: metadata ?? {} });
  }
  error(message: string, metadata?: LogMetadata): void {
    this.entries.push({ level: 'error', message, metadata: metadata ?? {} });
  }
  warn(message: string, metadata?: LogMetadata): void {
    this.entries.push({ level: 'warn', message, metadata: metadata ?? {} });
  }
  info(message: string, metadata?: LogMetadata): void {
    this.entries.push({ level: 'info', message, metadata: metadata ?? {} });
  }
  debug(message: string, metadata?: LogMetadata): void {
    this.entries.push({ level: 'debug', message, metadata: metadata ?? {} });
  }
  trace(message: string, metadata?: LogMetadata): void {
    this.entries.push({ level: 'trace', message, metadata: metadata ?? {} });
  }
  child(bindings: LogMetadata): ILogger {
    this.children.push(bindings);
    return this;
  }
}

/**
 * Minimal fake service registry that returns a stored logger and runtime.
 */
function createFakeRegistry(logger?: ILogger, runtime?: IRuntimeServices): IServiceRegistry {
  const services = new Map<string, unknown>();
  if (logger) {
    services.set(CAPABILITIES.LOGGER, logger);
  }
  if (runtime) {
    services.set(CAPABILITIES.RUNTIME, runtime);
  }
  return {
    register<T extends object>(token: string, service: T): void {
      services.set(token, service);
    },
    registerFactory<T extends object>(_token: string, _factory: () => T): void {},
    get<T extends object>(token: string): T {
      return services.get(token) as T;
    },
    getAll<T extends object>(_token: string): readonly T[] {
      return [];
    },
    has(token: string): boolean {
      return services.has(token);
    },
    unregister(_token: string): boolean {
      return false;
    },
  };
}

/**
 * Minimal fake request for the middleware.
 */
function createFakeRequest(method: string, path: string): IRequest {
  return {
    method: method as IRequest['method'],
    url: `http://localhost${path}`,
    path,
    headers: new Headers(),
    json<T>(): Promise<T> {
      return Promise.resolve({} as T);
    },
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array(0)),
  };
}

/**
 * Fake response that RECORDS what was written, like the kernel's real
 * `ResponseBuilder`. It previously ignored `status()` and hard-coded
 * `snapshot().status` to 200, which would have made the middleware's status
 * logging untestable (and hid that it logged a constant 0).
 */
function createFakeResponse(ctx: { response: IResponse }): IResponse {
  let status = 200;
  const headers = new Headers();
  let body: string | null = null;
  return {
    status: (code: number) => {
      status = code;
      return ctx.response;
    },
    header: (name: string, value: string) => {
      headers.set(name, value);
      return ctx.response;
    },
    appendHeader: (name: string, value: string) => {
      headers.append(name, value);
      return ctx.response;
    },
    json: <T>(b: T) => {
      body = JSON.stringify(b);
      headers.set('content-type', 'application/json; charset=utf-8');
      return { __handlerResult: true } as HandlerResult;
    },
    text: (b: string) => {
      body = b;
      return { __handlerResult: true } as HandlerResult;
    },
    html: (b: string) => {
      body = b;
      return { __handlerResult: true } as HandlerResult;
    },
    send: () => ({ __handlerResult: true }) as HandlerResult,
    redirect: () => ({ __handlerResult: true }) as HandlerResult,
    stream: () => ({ __handlerResult: true }) as HandlerResult,
    snapshot: () => ({
      streaming: false,
      status,
      headers,
      body,
    }),
  };
}

/**
 * Minimal fake request context wired with a fake runtime so the middleware
 * can compute duration from the SAME monotonic clock the kernel uses.
 */
function createFakeContext(
  logger: ILogger | undefined,
  overrides?: Partial<IRequestContext>,
): {
  ctx: IRequestContext;
  registry: IServiceRegistry;
  runtime: IRuntimeServices;
  tick: (ms: number) => void;
} {
  const { runtime, tick } = createFakeRuntime();
  const registry = createFakeRegistry(logger, runtime);
  const state = new Map<string, unknown>();
  const ctx = {} as IRequestContext;
  const response = createFakeResponse(ctx);
  Object.assign(ctx, {
    id: 'req-1',
    request: createFakeRequest('GET', '/users'),
    response,
    services: registry,
    params: {},
    query: {},
    state,
    // startTime comes from runtime.hrtime() — the SAME monotonic clock
    // the middleware uses to compute duration.
    startTime: runtime.hrtime(),
    ...overrides,
  });
  return { ctx, registry, runtime, tick };
}

describe('createRequestLoggerMiddleware', () => {
  let logger: SharedRecordingLogger;

  beforeEach(() => {
    logger = new SharedRecordingLogger();
  });

  it('logs one self-contained completed response at info', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'request completed',
        metadata: { method: 'GET', path: '/users', status: 200, duration: 0 },
      },
    ]);
  });

  it('computes correct duration using monotonic clock (tick test)', async () => {
    const middleware = createRequestLoggerMiddleware({ slowRequestThreshold: 10000 });
    const { ctx, tick } = createFakeContext(logger);

    // Advance the monotonic clock 100 ms from the context's start reading.
    tick(100);

    await middleware(ctx, async () => {});

    const completed = logger.entries.find((e) => e.message === 'request completed');
    expect(completed).toBeDefined();
    expect(completed!.metadata.duration).toBe(100);
  });

  it('logs slow requests when duration exceeds threshold', async () => {
    const middleware = createRequestLoggerMiddleware({ slowRequestThreshold: 0 });
    const { ctx, tick } = createFakeContext(logger);

    // Advance clock so duration is > 0.
    tick(100);

    await middleware(ctx, async () => {});

    const messages = logger.entries.map((e) => e.message);
    expect(messages).toContain('slow request');
  });

  it('does not log slow request when duration is under threshold', async () => {
    const middleware = createRequestLoggerMiddleware({ slowRequestThreshold: 10000 });
    const { ctx } = createFakeContext(logger);

    await middleware(ctx, async () => {});

    const messages = logger.entries.map((e) => e.message);
    expect(messages).not.toContain('slow request');
  });

  it('logs errors thrown by downstream middleware', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    await expect(
      middleware(ctx, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const messages = logger.entries.map((e) => e.message);
    expect(messages).not.toContain('request failed');
    expect(logger.entries.find((e) => e.message === 'request completed')?.metadata.status).toBe(
      500,
    );
  });

  it('skips logging for excluded paths', async () => {
    const middleware = createRequestLoggerMiddleware({ excludePaths: ['/health'] });
    const { ctx } = createFakeContext(logger, {
      request: createFakeRequest('GET', '/health'),
    });

    await middleware(ctx, async () => {});

    expect(logger.entries.length).toBe(0);
  });

  it('still calls next() for excluded paths', async () => {
    const middleware = createRequestLoggerMiddleware({ excludePaths: ['/health'] });
    const { ctx } = createFakeContext(logger, {
      request: createFakeRequest('GET', '/health'),
    });

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it('falls back to a no-op logger when none is registered', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(undefined);

    // Should not throw
    await middleware(ctx, async () => {});
  });

  it('logs the real response status the handler produced', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    // Previously this read a `'responseStatus'` state key that nothing in the
    // framework ever set, so every entry logged `status: 0`. It now reads
    // `ctx.response.snapshot().status`.
    await middleware(ctx, async () => {
      ctx.response.status(404).json({ error: 'Not Found' });
    });

    const completed = logger.entries.find((e) => e.message === 'request completed');
    expect(completed).toBeDefined();
    expect(completed!.metadata.status).toBe(404);
  });

  it('logs the default 200 status when the handler sets none', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    await middleware(ctx, async () => {});

    const completed = logger.entries.find((e) => e.message === 'request completed');
    expect(completed).toBeDefined();
    expect(completed!.metadata.status).toBe(200);
  });

  it('logs request method and path in the completion entry', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger, {
      request: createFakeRequest('POST', '/api/users'),
    });

    await middleware(ctx, async () => {});

    const completed = logger.entries.find((e) => e.message === 'request completed');
    expect(completed).toBeDefined();
    expect(completed!.metadata.method).toBe('POST');
    expect(completed!.metadata.path).toBe('/api/users');
  });

  it('binds requestId into the child logger', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger, { id: 'req-xyz' });

    await middleware(ctx, async () => {});

    expect(logger.children).toEqual([{ requestId: 'req-xyz' }]);
    expect(logger.entries.map((entry) => entry.message)).toEqual(['request completed']);
  });

  it('logs a non-Error throw as its string form, with no stack', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    await expect(
      middleware(ctx, () => {
        // A thrown non-Error (a string, a rejected value from a library) must
        // still be logged, and must not claim a stack it does not have.
        throw 'boom';
      }),
    ).rejects.toBe('boom');

    expect(logger.entries.some((e) => e.message === 'request failed')).toBe(false);
    expect(logger.entries.find((e) => e.message === 'request completed')?.metadata.status).toBe(
      500,
    );
  });
});

describe('D6 request log contract', () => {
  for (const outcome of ['200', '404', 'throw'] as const) {
    it(`emits exactly one info entry with all four fields for ${outcome}`, async () => {
      const logger = new SharedRecordingLogger();
      const { ctx, tick } = createFakeContext(logger, {
        request: createFakeRequest('POST', '/contract'),
      });
      const middleware = createRequestLoggerMiddleware();
      const failure = new Error('downstream');
      const operation = middleware(ctx, async () => {
        tick(25);
        if (outcome === 'throw') throw failure;
        if (outcome === '404') ctx.response.status(404);
      });
      if (outcome === 'throw') await expect(operation).rejects.toBe(failure);
      else await operation;
      expect(logger.entries).toEqual([
        {
          level: 'info',
          message: 'request completed',
          metadata: {
            method: 'POST',
            path: '/contract',
            status: outcome === 'throw' ? 500 : Number(outcome),
            duration: 25,
          },
        },
      ]);
      expect(logger.children).toEqual([{ requestId: 'req-1' }]);
    });
  }

  for (const level of ['debug', 'trace'] as const) {
    it(`emits debug arrival then info completion at ${level}`, async () => {
      const logger = new SharedRecordingLogger(level);
      const { ctx, tick } = createFakeContext(logger);
      await createRequestLoggerMiddleware()(ctx, async () => {
        tick(12);
      });
      expect(logger.entries).toEqual([
        {
          level: 'debug',
          message: 'request received',
          metadata: { method: 'GET', path: '/users' },
        },
        {
          level: 'info',
          message: 'request completed',
          metadata: { method: 'GET', path: '/users', status: 200, duration: 12 },
        },
      ]);
      expect(logger.children).toHaveLength(1);
    });
  }

  for (const level of ['info', 'warn', 'error', 'fatal'] as const) {
    it(`does not build arrival metadata when the exposed child level is ${level}`, async () => {
      const logger = new SharedRecordingLogger(level);
      const { ctx } = createFakeContext(logger);
      let downstream = false;
      let earlyMethodReads = 0;
      let methodReads = 0;
      Object.defineProperty(ctx.request, 'method', {
        get() {
          methodReads++;
          if (!downstream) earlyMethodReads++;
          return 'GET';
        },
      });
      await createRequestLoggerMiddleware()(ctx, async () => {
        downstream = true;
      });
      expect(earlyMethodReads).toBe(0);
      expect(methodReads).toBe(1);
      expect(logger.entries.map((entry) => entry.message)).toEqual(['request completed']);
    });
  }

  for (const mode of ['missing', 'unknown', 'throwing'] as const) {
    it(`delegates debug filtering when the level is ${mode}`, async () => {
      const logger = new SharedRecordingLogger();
      Object.defineProperty(logger, 'level', {
        get() {
          if (mode === 'throwing') throw new Error('unreadable level');
          return mode === 'unknown' ? 'application-level' : undefined;
        },
      });
      const { ctx } = createFakeContext(logger);
      await createRequestLoggerMiddleware()(ctx, async () => {});
      expect(logger.entries.map((entry) => [entry.level, entry.message])).toEqual([
        ['debug', 'request received'],
        ['info', 'request completed'],
      ]);
    });
  }

  it('uses the child logger exposed level for the arrival decision', async () => {
    for (const [parentLevel, childLevel] of [
      ['info', 'debug'],
      ['debug', 'info'],
    ] as const) {
      const parent = new SharedRecordingLogger(parentLevel);
      const child = new SharedRecordingLogger(childLevel);
      parent.child = (bindings) => {
        parent.children.push(bindings);
        return child;
      };
      const { ctx } = createFakeContext(parent);
      await createRequestLoggerMiddleware()(ctx, async () => {});
      expect(child.entries.map((entry) => [entry.level, entry.message])).toEqual(
        childLevel === 'debug'
          ? [
              ['debug', 'request received'],
              ['info', 'request completed'],
            ]
          : [['info', 'request completed']],
      );
      expect(parent.children).toEqual([{ requestId: 'req-1' }]);
    }
  });

  it('keeps the slow warning beside one complete info record', async () => {
    const logger = new SharedRecordingLogger();
    const { ctx, tick } = createFakeContext(logger);
    await createRequestLoggerMiddleware({ slowRequestThreshold: 10 })(ctx, async () => {
      tick(11);
    });
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'request completed',
        metadata: { method: 'GET', path: '/users', status: 200, duration: 11 },
      },
      {
        level: 'warn',
        message: 'slow request',
        metadata: { method: 'GET', path: '/users', duration: 11, threshold: 10 },
      },
    ]);
  });
});
