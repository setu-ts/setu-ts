/**
 * Unit tests for SseService — open, channel, connectionCount, onClosed.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRealtimeBackplane } from '@setu-ts/common';
import { SseService } from '../../src/services/sse-service.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('SseService', () => {
  it('should return 0 connections initially', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    expect(service.connectionCount).toBe(0);
  });

  it('should increment connectionCount on open', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    const ctx = createFakeContext({ runtime });
    const conn = service.open(ctx);
    void conn;
    expect(service.connectionCount).toBe(1);
  });

  it('should decrement connectionCount on close', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    const ctx = createFakeContext({ runtime });
    const conn = service.open(ctx);
    expect(service.connectionCount).toBe(1);
    conn.close();
    expect(service.connectionCount).toBe(0);
  });

  it('should return a connection with isOpen true', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    const ctx = createFakeContext({ runtime });
    const conn = service.open(ctx);
    expect(conn.isOpen).toBe(true);
  });

  it('should expose lastEventId from header', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    const ctx = createFakeContext({
      runtime,
      headers: { 'last-event-id': 'evt-42' },
    });
    const conn = service.open(ctx);
    expect(conn.lastEventId).toBe('evt-42');
  });

  it('should have null lastEventId when header absent', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    const ctx = createFakeContext({ runtime });
    const conn = service.open(ctx);
    expect(conn.lastEventId).toBeNull();
  });

  it('should get-or-create a channel', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    const ch1 = service.channel('room');
    const ch2 = service.channel('room');
    expect(ch1).toBe(ch2);
  });

  it('should have a connectionCount of 0 after all connections close', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const service = new SseService({}, runtime);
    const ctx = createFakeContext({ runtime });
    service.open(ctx);
    expect(service.connectionCount).toBe(1);
    // Close via closeAll simulates shutdown.
    service.closeAll();
    expect(service.connectionCount).toBe(0);
  });
});

describe('SseService opening the backplane transport on first connection', () => {
  /** A backplane recording connects, optionally failing the first attempt. */
  function recordingBackplane(failFirst = false): IRealtimeBackplane & {
    readonly connects: number[];
  } {
    const connects: number[] = [];
    let attempts = 0;
    return {
      connects,
      origin: 'node-a',
      connect: (): Promise<void> => {
        attempts++;
        connects.push(attempts);
        return failFirst && attempts === 1
          ? Promise.reject(new Error('transport unreachable'))
          : Promise.resolve();
      },
      publish: (): Promise<void> => Promise.resolve(),
      subscribe: (): Promise<() => void> => Promise.resolve(() => {}),
      close: (): Promise<void> => Promise.resolve(),
    } as unknown as IRealtimeBackplane & { readonly connects: number[] };
  }

  it('opens the transport when the first client connects', () => {
    // Without this a listen-only replica never opens a transport and receives
    // nothing: `subscribe()` registers a handler, it does not open a transport.
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const backplane = recordingBackplane();
    const service = new SseService({}, runtime, backplane);

    service.open(createFakeContext({ runtime }));

    expect(backplane.connects).toEqual([1]);
  });

  it('opens once across many connections', () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const backplane = recordingBackplane();
    const service = new SseService({}, runtime, backplane);

    service.open(createFakeContext({ runtime }));
    service.open(createFakeContext({ runtime }));

    expect(backplane.connects).toEqual([1]);
  });

  it('retries on a later connection after a failed open, and reports it', async () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const warnings: string[] = [];
    const logger = { warn: (message: string): void => void warnings.push(message) };
    const backplane = recordingBackplane(true);
    const service = new SseService(
      {},
      runtime,
      backplane,
      logger as unknown as undefined,
    );

    service.open(createFakeContext({ runtime }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnings[0]).toContain('backplane connect failed');
    service.open(createFakeContext({ runtime }));
    expect(backplane.connects).toEqual([1, 2]);
  });

  it('reports a non-Error rejection without losing the value', async () => {
    const runtime = createFakeRuntime({ uuidPrefix: 'svc' });
    const warnings: unknown[] = [];
    const logger = {
      warn: (_message: string, meta?: unknown): void => void warnings.push(meta),
    };
    const backplane = {
      origin: 'node-a',
      connect: (): Promise<void> => Promise.reject('transport gone'),
      publish: (): Promise<void> => Promise.resolve(),
      subscribe: (): Promise<() => void> => Promise.resolve(() => {}),
      close: (): Promise<void> => Promise.resolve(),
    } as unknown as IRealtimeBackplane;
    const service = new SseService({}, runtime, backplane, logger as unknown as undefined);

    service.open(createFakeContext({ runtime }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnings[0]).toMatchObject({ error: 'transport gone' });
  });
});
