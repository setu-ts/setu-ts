import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { WebSocketConnection } from '../../src/connection/websocket-connection.ts';
import { createFakeTransport } from '../fixtures/fake-runtime.ts';

describe('WebSocketConnection', () => {
  it('exposes its identity and path', () => {
    const conn = new WebSocketConnection('id-1', '/ws/chat', createFakeTransport(), 100);

    expect(conn.id).toBe('id-1');
    expect(conn.path).toBe('/ws/chat');
    expect(conn.isOpen).toBe(true);
    expect(conn.readyState).toBe('open');
    expect(conn.lastSeenAt).toBe(100);
  });

  it('sends text and binary frames through the transport', () => {
    const transport = createFakeTransport();
    const conn = new WebSocketConnection('id-1', '/ws', transport, 0);

    conn.send('hello');
    conn.send(new Uint8Array([1, 2, 3]));

    expect(transport.sent).toEqual(['hello', new Uint8Array([1, 2, 3])]);
  });

  it('serializes payloads with sendJson', () => {
    const transport = createFakeTransport();
    const conn = new WebSocketConnection('id-1', '/ws', transport, 0);

    conn.sendJson({ type: 'greeting', value: 42 });

    expect(transport.sent).toEqual(['{"type":"greeting","value":42}']);
  });

  it('refuses to send once closed', () => {
    const transport = createFakeTransport();
    const conn = new WebSocketConnection('id-1', '/ws', transport, 0);

    conn.close();

    expect(conn.isOpen).toBe(false);
    expect(conn.readyState).toBe('closed');
    expect(() => conn.send('late')).toThrow('is not open');
    expect(() => conn.sendJson({ a: 1 })).toThrow('is not open');
    expect(transport.sent).toEqual([]);
  });

  it('refuses to send when the transport is not open', () => {
    const transport = createFakeTransport();
    transport.setReadyState('connecting');
    const conn = new WebSocketConnection('id-1', '/ws', transport, 0);

    expect(conn.isOpen).toBe(false);
    expect(conn.readyState).toBe('connecting');
    expect(() => conn.send('too early')).toThrow('is not open');
  });

  it('closes idempotently, forwarding code and reason exactly once', () => {
    const transport = createFakeTransport();
    const conn = new WebSocketConnection('id-1', '/ws', transport, 0);

    conn.close(1001, 'going away');
    conn.close(1000, 'again');

    expect(transport.closes).toEqual([{ code: 1001, reason: 'going away' }]);
  });

  it('marks closed without touching the transport when the peer closed first', () => {
    const transport = createFakeTransport();
    const conn = new WebSocketConnection('id-1', '/ws', transport, 0);

    conn.markClosed();

    expect(conn.isOpen).toBe(false);
    expect(conn.readyState).toBe('closed');
    expect(transport.closes).toEqual([]);
  });

  it('advances the idle stamp on touch', () => {
    const conn = new WebSocketConnection('id-1', '/ws', createFakeTransport(), 100);

    conn.touch(950);

    expect(conn.lastSeenAt).toBe(950);
  });

  it('carries per-connection application state', () => {
    const conn = new WebSocketConnection('id-1', '/ws', createFakeTransport(), 0);

    conn.data.set('userId', 'u-7');

    expect(conn.data.get('userId')).toBe('u-7');
    expect(conn.data.size).toBe(1);
  });
});
