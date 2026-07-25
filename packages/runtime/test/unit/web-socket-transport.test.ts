import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createWebSocketTransport,
  normalizeFrame,
  toReadyState,
  toTransportError,
  type WebSocketLike,
} from '../../src/adapters/shared/web-socket-transport.ts';

function fakeSocket(readyState = 1): WebSocketLike & {
  sent: (string | Uint8Array)[];
  closes: unknown[];
} {
  const sent: (string | Uint8Array)[] = [];
  const closes: unknown[] = [];
  return {
    readyState,
    send: (data) => {
      sent.push(data);
    },
    close: (code, reason) => {
      closes.push({ code, reason });
    },
    sent,
    closes,
  };
}

describe('toReadyState', () => {
  it('maps every web WebSocket numeric state', () => {
    expect(toReadyState(0)).toBe('connecting');
    expect(toReadyState(1)).toBe('open');
    expect(toReadyState(2)).toBe('closing');
    expect(toReadyState(3)).toBe('closed');
  });

  it('treats an unknown state as closed', () => {
    expect(toReadyState(99)).toBe('closed');
  });
});

describe('normalizeFrame', () => {
  it('passes a text frame through unchanged', () => {
    expect(normalizeFrame('hello')).toBe('hello');
  });

  it('passes a Uint8Array through unchanged', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(normalizeFrame(bytes)).toBe(bytes);
  });

  it('wraps an ArrayBuffer without copying its contents', () => {
    const buffer = new Uint8Array([4, 5, 6]).buffer;

    const frame = normalizeFrame(buffer);

    expect(frame).toBeInstanceOf(Uint8Array);
    expect(Array.from(frame as Uint8Array)).toEqual([4, 5, 6]);
  });

  it('wraps a typed-array view over its own byte range', () => {
    const backing = new Uint8Array([9, 8, 7, 6]);
    const view = new Int8Array(backing.buffer, 1, 2);

    const frame = normalizeFrame(view);

    expect(Array.from(frame as Uint8Array)).toEqual([8, 7]);
  });

  it('stringifies anything else so a handler never gets an unusable value', () => {
    expect(normalizeFrame(42)).toBe('42');
    expect(normalizeFrame(null)).toBe('null');
  });
});

describe('toTransportError', () => {
  it('passes an Error through unchanged', () => {
    const error = new Error('boom');
    expect(toTransportError(error)).toBe(error);
  });

  it('produces a descriptive Error for a non-Error payload', () => {
    const error = toTransportError({ type: 'error' });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('WebSocket transport error');
  });
});

describe('createWebSocketTransport', () => {
  it('forwards sends and closes to the socket', () => {
    const socket = fakeSocket();
    const transport = createWebSocketTransport(socket);

    transport.send('hi');
    transport.close(1000, 'done');

    expect(socket.sent).toEqual(['hi']);
    expect(socket.closes).toEqual([{ code: 1000, reason: 'done' }]);
  });

  it('reports the socket live state rather than one captured at wrap time', () => {
    const socket = fakeSocket(0);
    const transport = createWebSocketTransport(socket);
    expect(transport.readyState).toBe('connecting');

    (socket as { readyState: number }).readyState = 1;

    expect(transport.readyState).toBe('open');
  });
});
