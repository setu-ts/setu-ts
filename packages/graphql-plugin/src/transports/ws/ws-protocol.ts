/**
 * graphql-transport-ws protocol constants and frame codec.
 *
 * Protocol reference: enisdenjo/graphql-ws PROTOCOL.md
 *
 * @module
 * @since 0.3.0
 */

/** The protocol identifier. */
export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

/** Message types. */
export const GQL_CONNECTION_INIT = 'connection_init';
export const GQL_CONNECTION_ACK = 'connection_ack';
export const GQL_PING = 'ping';
export const GQL_PONG = 'pong';
export const GQL_SUBSCRIBE = 'subscribe';
export const GQL_NEXT = 'next';
export const GQL_ERROR = 'error';
export const GQL_COMPLETE = 'complete';

/** Close codes. */
export const CLOSE_NORMAL = 1000;
export const CLOSE_INVALID_MESSAGE = 4400;
export const CLOSE_SUBSCRIBE_BEFORE_ACK = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_INIT_TIMEOUT = 4408;
export const CLOSE_DUPLICATE_SUBSCRIBE = 4409;
export const CLOSE_TOO_MANY_INITS = 4429;

/** Inbound frame shape. */
export interface InboundFrame {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

/**
 * Decode a JSON frame. Returns `null` when the frame cannot be parsed,
 * or a close decision when the frame shape is invalid.
 */
export function decodeFrame(raw: string): InboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string') {
    return null;
  }

  const frame: InboundFrame = { type };

  if (obj.id !== undefined) {
    if (typeof obj.id !== 'string') {
      return null;
    }
    frame.id = obj.id;
  }

  if (obj.payload !== undefined) {
    // Payload can be an object (for subscribe) or an array (for error frames).
    if (typeof obj.payload !== 'object' || obj.payload === null) {
      return null;
    }
    frame.payload = obj.payload as Record<string, unknown>;
  }

  return frame;
}

/**
 * Encode a frame to a JSON string.
 */
export function encodeFrame(frame: { type: string; id?: string; payload?: unknown }): string {
  const obj: Record<string, unknown> = { type: frame.type };
  if (frame.id !== undefined) {
    obj.id = frame.id;
  }
  if (frame.payload !== undefined) {
    obj.payload = frame.payload;
  }
  return JSON.stringify(obj);
}
