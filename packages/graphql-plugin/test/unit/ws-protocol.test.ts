/**
 * Tests for transports/ws/ws-protocol.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CLOSE_DUPLICATE_SUBSCRIBE,
  CLOSE_FORBIDDEN,
  CLOSE_INIT_TIMEOUT,
  CLOSE_INVALID_MESSAGE,
  CLOSE_NORMAL,
  CLOSE_SUBSCRIBE_BEFORE_ACK,
  CLOSE_TOO_MANY_INITS,
  decodeFrame,
  encodeFrame,
  GQL_COMPLETE,
  GQL_CONNECTION_ACK,
  GQL_CONNECTION_INIT,
  GQL_ERROR,
  GQL_NEXT,
  GQL_PING,
  GQL_PONG,
  GQL_SUBSCRIBE,
  GRAPHQL_TRANSPORT_WS,
} from '../../src/transports/ws/ws-protocol.ts';

describe('protocol constants', () => {
  it('GRAPHQL_TRANSPORT_WS is correct subprotocol', () => {
    expect(GRAPHQL_TRANSPORT_WS).toBe('graphql-transport-ws');
  });

  it('message types are correct', () => {
    expect(GQL_CONNECTION_INIT).toBe('connection_init');
    expect(GQL_CONNECTION_ACK).toBe('connection_ack');
    expect(GQL_PING).toBe('ping');
    expect(GQL_PONG).toBe('pong');
    expect(GQL_SUBSCRIBE).toBe('subscribe');
    expect(GQL_NEXT).toBe('next');
    expect(GQL_ERROR).toBe('error');
    expect(GQL_COMPLETE).toBe('complete');
  });

  it('close codes are correct', () => {
    expect(CLOSE_NORMAL).toBe(1000);
    expect(CLOSE_INVALID_MESSAGE).toBe(4400);
    expect(CLOSE_SUBSCRIBE_BEFORE_ACK).toBe(4401);
    expect(CLOSE_FORBIDDEN).toBe(4403);
    expect(CLOSE_INIT_TIMEOUT).toBe(4408);
    expect(CLOSE_DUPLICATE_SUBSCRIBE).toBe(4409);
    expect(CLOSE_TOO_MANY_INITS).toBe(4429);
  });
});

describe('encodeFrame', () => {
  it('encodes frame with type only', () => {
    const result = encodeFrame({ type: GQL_PING });
    expect(JSON.parse(result)).toEqual({ type: 'ping' });
  });

  it('encodes frame with type and id', () => {
    const result = encodeFrame({ type: GQL_NEXT, id: '1' });
    expect(JSON.parse(result)).toEqual({ type: 'next', id: '1' });
  });

  it('encodes frame with type, id, and payload', () => {
    const result = encodeFrame({ type: GQL_NEXT, id: '1', payload: { data: { hello: 'world' } } });
    expect(JSON.parse(result)).toEqual({
      type: 'next',
      id: '1',
      payload: { data: { hello: 'world' } },
    });
  });

  it('omits id when undefined', () => {
    const result = encodeFrame({ type: GQL_CONNECTION_ACK });
    const parsed = JSON.parse(result);
    expect(parsed.id).toBeUndefined();
  });

  it('omits payload when undefined', () => {
    const result = encodeFrame({ type: GQL_COMPLETE, id: '1' });
    const parsed = JSON.parse(result);
    expect(parsed.payload).toBeUndefined();
  });
});

describe('decodeFrame', () => {
  it('decodes valid frame with type only', () => {
    const frame = decodeFrame(JSON.stringify({ type: 'ping' }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe('ping');
    expect(frame!.id).toBeUndefined();
    expect(frame!.payload).toBeUndefined();
  });

  it('decodes valid frame with type and id', () => {
    const frame = decodeFrame(JSON.stringify({ type: 'subscribe', id: 'abc' }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe('subscribe');
    expect(frame!.id).toBe('abc');
  });

  it('decodes valid frame with type, id, and payload', () => {
    const frame = decodeFrame(JSON.stringify({
      type: 'subscribe',
      id: '1',
      payload: { query: '{ hello }' },
    }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe('subscribe');
    expect(frame!.id).toBe('1');
    expect(frame!.payload).toEqual({ query: '{ hello }' });
  });

  it('returns null for non-JSON input', () => {
    expect(decodeFrame('not json')).toBeNull();
  });

  it('returns null for array input', () => {
    expect(decodeFrame(JSON.stringify([1, 2]))).toBeNull();
  });

  it('returns null for null input', () => {
    expect(decodeFrame(JSON.stringify(null))).toBeNull();
  });

  it('returns null for missing type', () => {
    expect(decodeFrame(JSON.stringify({ id: '1' }))).toBeNull();
  });

  it('returns null for non-string type', () => {
    expect(decodeFrame(JSON.stringify({ type: 123 }))).toBeNull();
  });

  it('returns null for non-string id', () => {
    expect(decodeFrame(JSON.stringify({ type: 'ping', id: 123 }))).toBeNull();
  });

  it('accepts array payload (used by error frames)', () => {
    const frame = decodeFrame(
      JSON.stringify({ type: GQL_ERROR, id: '1', payload: [{ message: 'err' }] }),
    );
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe(GQL_ERROR);
    expect(frame!.id).toBe('1');
  });

  it('accepts null payload (connection_init per protocol)', () => {
    // N1: connection_init permits payload: null; the protocol allows it.
    const frame = decodeFrame(JSON.stringify({ type: 'connection_init', payload: null }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe('connection_init');
    expect(frame!.payload).toBeNull();
  });

  it('round-trips frame encode/decode', () => {
    const original = { type: GQL_NEXT, id: '42', payload: { data: { value: 1 } } };
    const encoded = encodeFrame(original);
    const decoded = decodeFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(original.type);
    expect(decoded!.id).toBe(original.id);
    expect(decoded!.payload).toEqual(original.payload);
  });
});
