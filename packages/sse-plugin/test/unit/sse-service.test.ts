/**
 * Unit tests for SseService — open, channel, connectionCount, onClosed.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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
