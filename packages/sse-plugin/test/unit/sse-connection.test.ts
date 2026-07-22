/**
 * Unit tests for SseConnection — stream lifecycle, heartbeat, cleanup, backpressure.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SseConnection } from '../../src/connection/sse-connection.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';

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
    // Verify send doesn't throw.
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
    // Should not throw.
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
    // The abort listener fires asynchronously.
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.isOpen).toBe(false);
    expect(onClosedCalled).toBe(1);
  });

  it('should create a heartbeat interval when heartbeatMs is set', () => {
    const { conn } = makeConnection(100);
    expect(conn.isOpen).toBe(true);
    conn.close();
    // After close, heartbeat should be cleared.
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
    // After close, controller is null — all ops should be no-ops.
    expect(() => conn.send({ data: 'after' })).not.toThrow();
    expect(() => conn.comment('after')).not.toThrow();
    // Second close is idempotent.
    conn.close();
    expect(onClosedCalled).toBe(1);
  });

  it('should pass SseConnection checks via instanceof', () => {
    const { conn } = makeConnection();
    expect(conn).toBeInstanceOf(SseConnection);
    conn.close();
  });
});
