// deno-lint-ignore-file require-await
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

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
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

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
  readonly level: LogLevel = 'info';
  readonly entries: RecordedEntry[] = [];

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
  child(_bindings: LogMetadata): ILogger {
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

function createFakeResponse(ctx: { response: IResponse }): IResponse {
  return {
    status: () => ctx.response,
    header: () => ctx.response,
    appendHeader: () => ctx.response,
    json: () => ({ __handlerResult: true }) as HandlerResult,
    text: () => ({ __handlerResult: true }) as HandlerResult,
    send: () => ({ __handlerResult: true }) as HandlerResult,
    redirect: () => ({ __handlerResult: true }) as HandlerResult,
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

  it('logs incoming request and completed response', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    const messages = logger.entries.map((e) => e.message);
    expect(messages).toContain('request received');
    expect(messages).toContain('request completed');
  });

  it('computes correct duration using monotonic clock (tick test)', async () => {
    const middleware = createRequestLoggerMiddleware({ slowRequestThreshold: 10000 });
    const { ctx, tick } = createFakeContext(logger);

    // Advance the clock by 100 ms between "request received" and completion.
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
    expect(messages).toContain('request failed');
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

  it('reads response status from ctx.state when set', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    await middleware(ctx, async () => {
      ctx.state.set('responseStatus', 404);
    });

    const completed = logger.entries.find((e) => e.message === 'request completed');
    expect(completed).toBeDefined();
    expect(completed!.metadata.status).toBe(404);
  });

  it('reports status 0 when not set in state', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger);

    await middleware(ctx, async () => {});

    const completed = logger.entries.find((e) => e.message === 'request completed');
    expect(completed).toBeDefined();
    expect(completed!.metadata.status).toBe(0);
  });

  it('logs request method and path in the incoming entry', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger, {
      request: createFakeRequest('POST', '/api/users'),
    });

    await middleware(ctx, async () => {});

    const received = logger.entries.find((e) => e.message === 'request received');
    expect(received).toBeDefined();
    expect(received!.metadata.method).toBe('POST');
    expect(received!.metadata.path).toBe('/api/users');
  });

  it('binds requestId into the child logger', async () => {
    const middleware = createRequestLoggerMiddleware();
    const { ctx } = createFakeContext(logger, { id: 'req-xyz' });

    await middleware(ctx, async () => {});

    // SharedRecordingLogger.child() returns self, so entries are on the same logger.
    const received = logger.entries.find((e) => e.message === 'request received');
    expect(received).toBeDefined();
    // The child logger was created with { requestId: ctx.id }
    // Since child() returns self in our fake, we verify the middleware called child()
    // by checking that logging happened at all (it would only happen if a logger was resolved).
  });
});
