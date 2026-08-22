/**
 * Unit tests for the gRPC handler-error logging wrapper's DEFERRED-failure and
 * broken-logger paths (M70f re-review, findings 3 & 4).
 *
 * The e2e suite proves the wrapper through the real Connect transport for a
 * server-streaming RPC. These unit tests drive the wrapped implementation
 * directly (via the fake runtime's registered implementation) to cover the two
 * paths the e2e fixture cannot reach:
 *
 * - **Finding 3 — bidi / async-iterable failures.** A bidi handler returns an
 *   `AsyncIterable` of responses, the SAME shape a server-streaming handler
 *   returns, so it goes through the wrapper's `isAsyncIterable` branch. The
 *   common failure point is a later `next()` rejection, AFTER invocation has
 *   returned the iterable. The wrapper must log (and rethrow) that failure
 *   while transparently delegating values, `return`, and `throw`.
 * - **Finding 4 — a broken logger.** If the logger's `error()` (or its
 *   resolution) throws, the wrapper must degrade silently and rethrow the
 *   ORIGINAL handler error — the logger failure must not replace it.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildConnectRouter } from '../../src/transports/connect-router-builder.ts';
import {
  createFakeConnectRuntime,
  type FakeConnectRuntime,
  fakeFile,
  fakeService,
} from '../fixtures/fake-connect-runtime.ts';
import type { EmbeddedDescriptors as EmbeddedDescriptorsType } from '../../src/descriptors/embedded-descriptors.ts';
import type { ILogger } from '@setu-ts/common';

const embeddedDescriptors: EmbeddedDescriptorsType = {
  healthBase64: btoa('health-bytes'),
  reflectionBase64: btoa('reflection-bytes'),
};

/** A capturing logger that records `error` calls. */
function makeCapturingLogger() {
  const errors: {
    message: string;
    metadata?: Readonly<Record<string, unknown>> | undefined;
  }[] = [];
  const logger: ILogger = {
    level: 'error',
    fatal(message, metadata) {
      errors.push({ message, metadata });
    },
    error(message, metadata) {
      errors.push({ message, metadata });
    },
    warn() {},
    info() {},
    debug() {},
    trace() {},
    child() {
      return logger;
    },
  };
  return { logger, errors };
}

/**
 * Builds a router with a single app service exposing a server-streaming and a
 * bidi method (both return an `AsyncIterable`), and returns the wrapped
 * implementation the router was handed.
 */
function buildStreamService(
  impl: Record<string, unknown>,
  resolveLogger?: (() => ILogger | undefined) | undefined,
): FakeConnectRuntime {
  const file = fakeFile('example/stream.proto');
  const definition = fakeService(
    'example.Stream',
    ['ServerStream', 'BidiStream'],
    file,
    { ServerStream: 'serverStream', BidiStream: 'bidiStream' },
  );
  const runtime = createFakeConnectRuntime({ services: [definition] });
  buildConnectRouter({
    connectRuntime: runtime,
    basePath: '/grpc',
    reflection: false,
    health: false,
    services: [{ definition, implementation: impl }],
    embeddedDescriptors,
    healthService: undefined,
    resolveLogger,
  });
  return runtime;
}

/** Collects the values of an async iterable until it ends or throws. */
async function drain(
  iterable: AsyncIterable<unknown>,
): Promise<{ values: unknown[]; thrown: unknown }> {
  const values: unknown[] = [];
  let thrown: unknown;
  try {
    for await (const value of iterable) {
      values.push(value);
    }
  } catch (error) {
    thrown = error;
  }
  return { values, thrown };
}

describe('gRPC handler wrapper — async-iterable (server-streaming / bidi) failures', () => {
  it('logs and rethrows a server-streaming failure after the first yielded item', async () => {
    const { logger, errors } = makeCapturingLogger();
    const runtime = buildStreamService(
      {
        serverStream: async function* (_req: unknown) {
          yield { message: 'first' };
          throw new Error('stream failed after first item');
        },
      },
      () => logger,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const { values, thrown } = await drain(
      (wrapped.serverStream as (r: unknown) => AsyncIterable<unknown>)({}),
    );

    // The first item is transparently delegated...
    expect(values).toEqual([{ message: 'first' }]);
    // ...and the deferred failure is rethrown so the masked wire response is unchanged.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('stream failed after first item');
    // ...and it is logged, naming the procedure and the real message.
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('gRPC handler failed');
    expect(errors[0].metadata?.procedure).toBe('example.Stream/serverStream');
    expect(errors[0].metadata?.message).toBe('stream failed after first item');
  });

  it('logs and rethrows a bidi failure after the first yielded item', async () => {
    // A bidi handler returns an AsyncIterable of responses — the same shape the
    // wrapper's isAsyncIterable branch handles — so its deferred failure is
    // logged exactly like a server-streaming one.
    const { logger, errors } = makeCapturingLogger();
    const runtime = buildStreamService(
      {
        bidiStream: async function* (_req: unknown) {
          yield { response: 'first' };
          throw new Error('bidi failed after first item');
        },
      },
      () => logger,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const { values, thrown } = await drain(
      (wrapped.bidiStream as (r: unknown) => AsyncIterable<unknown>)({}),
    );

    expect(values).toEqual([{ response: 'first' }]);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('bidi failed after first item');
    expect(errors).toHaveLength(1);
    expect(errors[0].metadata?.procedure).toBe('example.Stream/bidiStream');
    expect(errors[0].metadata?.message).toBe('bidi failed after first item');
  });

  it('delegates cancellation (return) to the underlying iterator', async () => {
    // The wrapper must preserve iterator-return so the handler's cleanup runs.
    let returned = false;
    const { logger } = makeCapturingLogger();
    const runtime = buildStreamService(
      {
        serverStream: async function* (_req: unknown) {
          try {
            yield { message: 'first' };
            yield { message: 'second' };
          } finally {
            returned = true;
          }
        },
      },
      () => logger,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const iterable = (wrapped.serverStream as (r: unknown) => AsyncIterable<unknown>)({});
    const it = iterable[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toEqual({ message: 'first' });
    // Cancel mid-stream: the underlying generator's finally must run.
    await it.return?.();
    expect(returned).toBe(true);
  });

  it('logs and rethrows a synchronous iterator-acquisition failure', () => {
    // A handler whose async iterable's `iterator()` factory throws synchronously
    // (e.g. a cursor that fails to open) is a handler failure just like a
    // `next()` rejection. Before the round-2 fix the wrapper acquired the
    // iterator outside the try, so the failure escaped unlogged. Now it is
    // routed through the same protected reporting path.
    const { logger, errors } = makeCapturingLogger();
    const acquireError = new Error('iterator factory failed');
    const runtime = buildStreamService(
      {
        serverStream: () => {
          // A custom async iterable whose iterator factory throws.
          return {
            [Symbol.asyncIterator]() {
              throw acquireError;
            },
          };
        },
      },
      () => logger,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const iterable = (wrapped.serverStream as (r: unknown) => AsyncIterable<unknown>)({});
    let thrown: unknown;
    try {
      iterable[Symbol.asyncIterator]();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(acquireError);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('gRPC handler failed');
    expect(errors[0].metadata?.procedure).toBe('example.Stream/serverStream');
    expect(errors[0].metadata?.message).toBe('iterator factory failed');
  });

  it('logs and rethrows a rejected delegated return (cleanup failure after cancellation)', async () => {
    // A handler whose cleanup REJECTS after the client cancels (a rejected
    // `return`) is a handler failure. Before the round-2 fix the wrapper
    // delegated `return` verbatim, so the rejection escaped unlogged. Now it is
    // routed through the same protected reporting path and the ORIGINAL error
    // propagates.
    const { logger, errors } = makeCapturingLogger();
    const cleanupError = new Error('cleanup rejected');
    const runtime = buildStreamService(
      {
        serverStream: () => {
          return {
            [Symbol.asyncIterator]() {
              let done = false;
              return {
                async next() {
                  await Promise.resolve();
                  if (done) {
                    return { value: undefined, done: true };
                  }
                  done = true;
                  return { value: { message: 'first' }, done: false };
                },
                // A cleanup that rejects when the consumer cancels.
                async return() {
                  await Promise.resolve();
                  throw cleanupError;
                },
              };
            },
          };
        },
      },
      () => logger,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const iterable = (wrapped.serverStream as (r: unknown) => AsyncIterable<unknown>)({});
    const it = iterable[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toEqual({ message: 'first' });
    let thrown: unknown;
    try {
      await it.return?.();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(cleanupError);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('gRPC handler failed');
    expect(errors[0].metadata?.procedure).toBe('example.Stream/serverStream');
    expect(errors[0].metadata?.message).toBe('cleanup rejected');
  });

  it('logs and rethrows a rejected delegated throw', async () => {
    // A consumer that pushes an error into the iterator via `throw` and the
    // underlying iterator's `throw` REJECTS is a handler failure. Before the
    // round-2 fix the wrapper delegated `throw` verbatim, so the rejection
    // escaped unlogged. Now it is routed through the same protected reporting
    // path and the ORIGINAL error propagates.
    const { logger, errors } = makeCapturingLogger();
    const pushError = new Error('consumer pushed an error');
    const rejectError = new Error('iterator throw rejected');
    const runtime = buildStreamService(
      {
        serverStream: () => {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  await Promise.resolve();
                  return { value: { message: 'first' }, done: false };
                },
                // A `throw` that rejects with its own error.
                async throw() {
                  await Promise.resolve();
                  throw rejectError;
                },
              };
            },
          };
        },
      },
      () => logger,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const iterable = (wrapped.serverStream as (r: unknown) => AsyncIterable<unknown>)({});
    const it = iterable[Symbol.asyncIterator]();
    await it.next();
    let thrown: unknown;
    try {
      await it.throw?.(pushError);
    } catch (error) {
      thrown = error;
    }

    // The underlying iterator's rejection is the one that propagates.
    expect(thrown).toBe(rejectError);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('gRPC handler failed');
    expect(errors[0].metadata?.procedure).toBe('example.Stream/serverStream');
    expect(errors[0].metadata?.message).toBe('iterator throw rejected');
  });
});

describe('gRPC handler wrapper — a broken logger does not replace the handler error', () => {
  it('rethrows the original error when the logger throws on a synchronous handler failure', () => {
    const broken: ILogger = {
      level: 'error',
      fatal() {},
      error() {
        throw new Error('logger failed');
      },
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return broken;
      },
    };
    const handlerError = new Error('handler failed');
    const runtime = buildStreamService(
      {
        // A synchronous throw (unary-shaped) exercises the sync path.
        serverStream: () => {
          throw handlerError;
        },
      },
      () => broken,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    let thrown: unknown;
    try {
      (wrapped.serverStream as (r: unknown) => unknown)({});
    } catch (error) {
      thrown = error;
    }
    // The ORIGINAL handler error is observed, not the logger's failure.
    expect(thrown).toBe(handlerError);
  });

  it('rethrows the original error when the logger throws on a thenable rejection', async () => {
    const broken: ILogger = {
      level: 'error',
      fatal() {},
      error() {
        throw new Error('logger failed');
      },
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return broken;
      },
    };
    const handlerError = new Error('handler failed');
    const runtime = buildStreamService(
      {
        // A unary Promise rejection exercises the thenable path.
        serverStream: () => Promise.reject(handlerError),
      },
      () => broken,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const result = (wrapped.serverStream as (r: unknown) => Promise<unknown>)({});
    let thrown: unknown;
    try {
      await result;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(handlerError);
  });

  it('rethrows the original error when the logger throws on an iteration failure', async () => {
    const broken: ILogger = {
      level: 'error',
      fatal() {},
      error() {
        throw new Error('logger failed');
      },
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child() {
        return broken;
      },
    };
    const handlerError = new Error('stream failed after first item');
    const runtime = buildStreamService(
      {
        serverStream: async function* (_req: unknown) {
          yield { message: 'first' };
          throw handlerError;
        },
      },
      () => broken,
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    const { values, thrown } = await drain(
      (wrapped.serverStream as (r: unknown) => AsyncIterable<unknown>)({}),
    );
    expect(values).toEqual([{ message: 'first' }]);
    expect(thrown).toBe(handlerError);
  });

  it('rethrows the original error when logger resolution itself throws', () => {
    const handlerError = new Error('handler failed');
    const runtime = buildStreamService(
      {
        serverStream: () => {
          throw handlerError;
        },
      },
      () => {
        throw new Error('logger resolution failed');
      },
    );
    const wrapped = runtime.registered[0].implementation as Record<string, unknown>;
    let thrown: unknown;
    try {
      (wrapped.serverStream as (r: unknown) => unknown)({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(handlerError);
  });
});
