/**
 * Unit tests for SseConnection — stream lifecycle, heartbeat, cleanup, backpressure.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HandlerResult } from '@hono-enterprise/common';
import { SseConnection } from '../../src/connection/sse-connection.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import type {
  IRequestContext,
  IResponse,
  IRuntimeServices,
  ResponseSnapshot,
} from '@hono-enterprise/common';

describe('SseConnection', () => {
  let runtime: IRuntimeServices;
  let ctx: ReturnType<typeof createFakeContext>;
  let onClosedCalled = 0;

  beforeEach(() => {
    runtime = createFakeRuntime({ uuidPrefix: 'conn' });
    onClosedCalled = 0;
  });

  function makeConnection(
    heartbeatMs?: number,
    retryMs?: number,
    customSignal?: AbortController,
  ): { conn: SseConnection; controller: AbortController } {
    const ac = customSignal ?? new AbortController();
    ctx = createFakeContext({ signal: ac.signal, runtime });
    const conn = new SseConnection(ctx, runtime, heartbeatMs, retryMs, () => {
      onClosedCalled++;
    });
    return { conn, controller: ac };
  }

  // ---------------------------------------------------------------------------
  // Core tests
  // ---------------------------------------------------------------------------

  it('should have an id and lastEventId', () => {
    const { conn } = makeConnection();
    expect(conn.id).toMatch(/^conn-/);
    expect(conn.lastEventId).toBeNull();
  });

  it('should capture last-event-id header', () => {
    const ctxWithHeader = createFakeContext({
      runtime,
      headers: { 'last-event-id': 'abc123' },
    });
    const conn = new SseConnection(ctxWithHeader, runtime, undefined, undefined, () => {
      onClosedCalled++;
    });
    expect(conn.lastEventId).toBe('abc123');
  });

  it('should be open initially', () => {
    const { conn } = makeConnection();
    expect(conn.isOpen).toBe(true);
  });

  it('should enqueue a message frame', () => {
    const { conn } = makeConnection();
    expect(() => conn.send({ data: 'hello' })).not.toThrow();
  });

  it('should enqueue a comment', () => {
    const { conn } = makeConnection();
    expect(() => conn.comment('heartbeat')).not.toThrow();
  });

  it('should close and flip isOpen to false', () => {
    const { conn } = makeConnection();
    expect(conn.isOpen).toBe(true);
    conn.close();
    expect(conn.isOpen).toBe(false);
  });

  it('should be idempotent on close', () => {
    const { conn } = makeConnection();
    conn.close();
    conn.close();
    expect(onClosedCalled).toBe(1);
  });

  it('should not send after close', () => {
    const { conn } = makeConnection();
    conn.close();
    expect(() => conn.send({ data: 'after close' })).not.toThrow();
  });

  it('should not comment after close', () => {
    const { conn } = makeConnection();
    conn.close();
    expect(() => conn.comment('after close')).not.toThrow();
  });

  it('should invoke onClosed when aborted via signal', async () => {
    const { conn, controller } = makeConnection();
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.isOpen).toBe(false);
    expect(onClosedCalled).toBe(1);
  });

  it('should create a heartbeat interval when heartbeatMs is set', () => {
    const { conn } = makeConnection(100);
    expect(conn.isOpen).toBe(true);
    conn.close();
  });

  it('should not create a heartbeat interval when heartbeatMs is omitted', () => {
    const { conn } = makeConnection(undefined);
    expect(conn.isOpen).toBe(true);
    conn.close();
  });

  it('should set result to a HandlerResult', () => {
    const { conn } = makeConnection();
    expect(conn.result).toBeDefined();
    expect(conn.result.__handlerResult).toBe(true);
  });

  it('should handle multiple sends before close', () => {
    const { conn } = makeConnection();
    expect(() => conn.send({ data: 'first' })).not.toThrow();
    expect(() => conn.send({ data: 'second' })).not.toThrow();
    expect(() => conn.send({ event: 'tick', data: { n: 1 } })).not.toThrow();
    expect(conn.isOpen).toBe(true);
    conn.close();
    expect(conn.isOpen).toBe(false);
  });

  it('should handle multiple comments before close', () => {
    const { conn } = makeConnection();
    expect(() => conn.comment('hb1')).not.toThrow();
    expect(() => conn.comment('hb2')).not.toThrow();
    conn.close();
    expect(conn.isOpen).toBe(false);
  });

  it('should handle mixed send/comment operations', () => {
    const { conn } = makeConnection();
    conn.send({ data: 'hello' });
    conn.comment('heartbeat');
    conn.send({ event: 'tick', data: { n: 1 } });
    conn.close();
    expect(conn.isOpen).toBe(false);
  });

  it('should reject send/close when controller is null after cleanup', () => {
    const { conn } = makeConnection();
    conn.close();
    expect(() => conn.send({ data: 'after' })).not.toThrow();
    expect(() => conn.comment('after')).not.toThrow();
    conn.close();
    expect(onClosedCalled).toBe(1);
  });

  it('should pass SseConnection checks via instanceof', () => {
    const { conn } = makeConnection();
    expect(conn).toBeInstanceOf(SseConnection);
    conn.close();
  });

  // ---------------------------------------------------------------------------
  // Backpressure and controller-cleanup branches (coverage)
  // ---------------------------------------------------------------------------

  it('should fire heartbeat comment and clear on close', async () => {
    const { conn } = makeConnection(50);
    await new Promise((r) => setTimeout(r, 80));
    expect(conn.isOpen).toBe(true);
    conn.close();
    expect(conn.isOpen).toBe(false);
    expect(onClosedCalled).toBe(1);
  });

  /**
   * Intercepts all ReadableStream constructions so that each underlyingSource.start()
   * callback is also forwarded to `onStart`, giving us access to every captured
   * ReadableStreamDefaultController.
   */
  function withControlledStreams(
    onStart: (ctrl: ReadableStreamDefaultController<Uint8Array>) => void,
  ): () => void {
    const OriginalRS = globalThis.ReadableStream;
    const subscriptions: Array<() => void> = [];

    // deno-lint-ignore no-explicit-any
    class InterceptedRS<T = any> extends OriginalRS<T> {
      constructor(
        underlyingSource?: { start?(ctrl: ReadableStreamDefaultController<T>): void },
        // deno-lint-ignore no-explicit-any
        ...args: any[]
      ) {
        const origUnderlying = { ...(underlyingSource ?? {}) };
        const origStart = origUnderlying.start;
        // deno-lint-ignore no-explicit-any
        origUnderlying.start = (ctrl: any) => {
          if (origStart) origStart(ctrl);
          onStart(ctrl as ReadableStreamDefaultController<Uint8Array>);
        };
        super(origUnderlying as never, ...(args as [never?]));
      }
    }

    // deno-lint-ignore no-explicit-any -- globalThis replacement
    globalThis.ReadableStream = InterceptedRS as any;

    return () => {
      // deno-lint-ignore no-explicit-any
      globalThis.ReadableStream = OriginalRS as any;
      for (const sub of subscriptions) sub();
    };
  }

  it('should backpressure-close when desiredSize exceeds backlog cap', () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const teardown = withControlledStreams((ctrl) => controllers.push(ctrl));

    try {
      const ac = new AbortController();
      const resp: IResponse = {
        header(_name: string, _value: string) {
          return this;
        },
        appendHeader(_name: string, _value: string) {
          return this;
        },
        status(_code: number) {
          return this;
        },
        json(_data?: unknown) {
          return { __handlerResult: true };
        },
        text(_body?: string) {
          return { __handlerResult: true };
        },
        send(_body?: Uint8Array) {
          return { __handlerResult: true };
        },
        redirect(_url?: string, _status?: number) {
          return { __handlerResult: true };
        },
        stream(_body: ReadableStream<Uint8Array>): HandlerResult {
          return { __handlerResult: true };
        },
        snapshot(): ResponseSnapshot {
          return { streaming: false, body: null } as ResponseSnapshot;
        },
      };

      const baseCtx = createFakeContext({
        signal: ac.signal,
        runtime,
      }) as unknown as IRequestContext;
      const finalCtx: IRequestContext = {
        ...baseCtx,
        response: resp as unknown as IResponse,
      };

      const conn = new SseConnection(finalCtx, runtime, undefined, undefined, () => {
        onClosedCalled++;
      });

      expect(controllers.length).toBeGreaterThan(0);
      const ctrl = controllers[0];
      Object.defineProperty(ctrl, 'desiredSize', {
        value: -(1024 * 1024 + 100), // less than -1 MiB
        writable: true,
        enumerable: true,
        configurable: true,
      });

      conn.send({ data: 'test' });
      expect(conn.isOpen).toBe(false);
      expect(onClosedCalled).toBe(1);
    } finally {
      teardown();
    }
  });

  it('should swallow controller.enqueue exceptions without crashing', () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const teardown = withControlledStreams((ctrl) => controllers.push(ctrl));

    try {
      const ac = new AbortController();
      const resp: IResponse = {
        header(_name: string, _value: string) {
          return this;
        },
        appendHeader(_name: string, _value: string) {
          return this;
        },
        status(_code: number) {
          return this;
        },
        json(_data?: unknown) {
          return { __handlerResult: true };
        },
        text(_body?: string) {
          return { __handlerResult: true };
        },
        send(_body?: Uint8Array) {
          return { __handlerResult: true };
        },
        redirect(_url?: string, _status?: number) {
          return { __handlerResult: true };
        },
        stream(_body: ReadableStream<Uint8Array>): HandlerResult {
          return { __handlerResult: true };
        },
        snapshot(): ResponseSnapshot {
          return { streaming: false, body: null } as ResponseSnapshot;
        },
      };

      const baseCtx = createFakeContext({
        signal: ac.signal,
        runtime,
      }) as unknown as IRequestContext;
      const finalCtx: IRequestContext = {
        ...baseCtx,
        response: resp as unknown as IResponse,
      };

      const conn = new SseConnection(finalCtx, runtime, undefined, undefined, () => {
        onClosedCalled++;
      });

      expect(controllers.length).toBeGreaterThan(0);
      const ctrl = controllers[0];
      Object.defineProperty(ctrl, 'enqueue', {
        value(_chunk: Uint8Array) {
          throw new Error('queue full');
        },
        writable: true,
        enumerable: true,
        configurable: true,
      });

      expect(() => conn.send({ data: 'test' })).not.toThrow();
      expect(conn.isOpen).toBe(false);
      expect(onClosedCalled).toBe(1);
    } finally {
      teardown();
    }
  });
});
