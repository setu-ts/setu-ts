/** Behavior tests for the WebSocket realtime client. */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IClientTiming } from '../../src/http/contracts.ts';
import { createRealtimeClient } from '../../src/realtime/realtime-client.ts';
import type { IWebSocketTransport } from '../../src/realtime/websocket-contracts.ts';

const immediateTiming: IClientTiming = { now: () => 0, sleep: () => Promise.resolve() };

class FakeSocket implements IWebSocketTransport {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe('createRealtimeClient', () => {
  it('filters and replies to the server heartbeat without dispatching it', () => {
    const socket = new FakeSocket();
    const received: unknown[] = [];
    createRealtimeClient({
      url: 'wss://example.test/events',
      webSocket: () => socket,
      onMessage: (message) => received.push(message.data),
    });
    socket.open();

    socket.receive('ping');
    socket.receive('{"score":2}');

    expect(socket.sent).toEqual(['ping']);
    expect(received).toEqual([{ score: 2 }]);
  });

  it('rejoins the configured room after an unrequested close', async () => {
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    createRealtimeClient({
      url: 'wss://example.test/live?tab=scoreboard',
      room: 'game-7',
      timing: immediateTiming,
      reconnect: { maxAttempts: 1, delayMs: 0 },
      webSocket: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: () => {},
    });
    sockets[0]?.open();
    sockets[0]?.close();
    await Promise.resolve();
    await Promise.resolve();

    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get('room')).toBe('game-7');
    expect(new URL(urls[1]!).searchParams.get('tab')).toBe('scoreboard');
  });

  it('serializes object messages and rejects sends before open', () => {
    const socket = new FakeSocket();
    const client = createRealtimeClient<{ readonly ignored: boolean }, { readonly id: number }>({
      url: 'wss://example.test/live',
      webSocket: () => socket,
      onMessage: () => {},
    });

    expect(() => client.send({ id: 1 })).toThrow('not connected');
    socket.open();
    client.send({ id: 1 });
    expect(socket.sent).toEqual(['{"id":1}']);

    const stringSocket = new FakeSocket();
    const stringClient = createRealtimeClient<unknown, string>({
      url: 'wss://example.test/live',
      webSocket: () => stringSocket,
      onMessage: () => {},
    });
    stringSocket.open();
    stringClient.send('{"id":2}');
    expect(stringSocket.sent).toEqual(['{"id":2}']);
  });

  it('does not reconnect after an explicit close', async () => {
    let calls = 0;
    const socket = new FakeSocket();
    const client = createRealtimeClient({
      url: 'wss://example.test/live',
      timing: immediateTiming,
      webSocket: () => {
        calls++;
        return socket;
      },
      onMessage: () => {},
    });
    socket.open();
    client.close();
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(client.state).toBe('closed');
  });

  it('reports malformed messages and socket errors without dispatching them', () => {
    const socket = new FakeSocket();
    const errors: unknown[] = [];
    const received: unknown[] = [];
    createRealtimeClient({
      url: 'wss://example.test/live',
      webSocket: () => socket,
      onMessage: (message) => received.push(message.data),
      onError: (error) => errors.push(error),
    });
    socket.open();
    socket.receive('not-json');
    socket.onmessage?.({ data: new Uint8Array([1]) } as MessageEvent);
    socket.onerror?.(new Event('error'));

    expect(received).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it('uses custom parsing and reconnects after a factory failure', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const client = createRealtimeClient<number>({
      url: 'wss://example.test/live',
      timing: immediateTiming,
      reconnect: { maxAttempts: 1, delayMs: 0 },
      webSocket: () => {
        calls++;
        if (calls === 1) throw new Error('unavailable');
        const socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket;
      },
      parse: (data) => Number(data),
      onMessage: () => {},
      onError: (error) => errors.push(error),
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    expect(client.state).toBe('open');
    client.close();

    const socket = new FakeSocket();
    const parsed: number[] = [];
    createRealtimeClient<number>({
      url: 'wss://example.test/live',
      webSocket: () => socket,
      parse: (data) => Number(data),
      onMessage: (message) => parsed.push(message.data),
    });
    socket.open();
    socket.receive('42');
    expect(parsed).toEqual([42]);
  });

  it('validates reconnect policies and closes after the final close', async () => {
    for (
      const reconnect of [
        { maxAttempts: -1 },
        { maxAttempts: 0.5 },
        { delayMs: -1 },
        { maxDelayMs: -1 },
      ]
    ) {
      expect(() =>
        createRealtimeClient({
          url: 'wss://example.test/live',
          reconnect,
          onMessage: () => {},
        })
      ).toThrow();
    }

    const socket = new FakeSocket();
    const client = createRealtimeClient({
      url: 'wss://example.test/live',
      timing: immediateTiming,
      reconnect: { maxAttempts: 0 },
      webSocket: () => socket,
      onMessage: () => {},
    });
    socket.open();
    socket.close();
    await Promise.resolve();

    expect(client.state).toBe('closed');
  });

  it('uses the global WebSocket fallback', () => {
    const originalWebSocket = globalThis.WebSocket;
    const socket = new FakeSocket();
    function WebSocketStub(_url: string): IWebSocketTransport {
      return socket;
    }
    globalThis.WebSocket = WebSocketStub as unknown as typeof WebSocket;
    try {
      const client = createRealtimeClient({
        url: 'wss://example.test/live',
        onMessage: () => {},
      });
      socket.open();
      expect(client.state).toBe('open');
      client.close();
      client.close();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
