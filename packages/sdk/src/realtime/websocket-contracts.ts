/** Public contracts for the portable realtime WebSocket client. */

import type { IClientTiming } from '../http/contracts.ts';

/** Lifecycle states a realtime client reports. */
export type RealtimeClientState = 'connecting' | 'open' | 'closed';

/** Minimal structural WebSocket surface used by the client. */
export interface IWebSocketTransport {
  /** Browser-compatible ready-state number (`0` connecting, `1` open). */
  readonly readyState: number;
  /** Open callback installed by the client. */
  onopen: ((event: Event) => void) | null;
  /** Message callback installed by the client. */
  onmessage: ((event: MessageEvent) => void) | null;
  /** Close callback installed by the client. */
  onclose: ((event: CloseEvent) => void) | null;
  /** Error callback installed by the client. */
  onerror: ((event: Event) => void) | null;
  /** Sends one text frame. */
  send(data: string): void;
  /** Closes the connection. */
  close(code?: number, reason?: string): void;
}

/** Injectable constructor seam for the global WebSocket. */
export type WebSocketFactory = (url: string) => IWebSocketTransport;

/** Bounded reconnect policy for a realtime connection. */
export interface RealtimeReconnectOptions {
  /** Maximum reconnect attempts after close. Omit for unlimited attempts. */
  readonly maxAttempts?: number;
  /** Initial reconnect delay in milliseconds. Defaults to 1,000. */
  readonly delayMs?: number;
  /** Maximum exponential reconnect delay in milliseconds. Defaults to 30,000. */
  readonly maxDelayMs?: number;
}

/** One parsed application message received from the server. */
export interface RealtimeMessage<TData = unknown> {
  /** Parsed text-frame payload. */
  readonly data: TData;
}

/** Configuration for {@linkcode createRealtimeClient}. */
export interface RealtimeClientOptions<TIncoming = unknown> {
  /** Absolute WebSocket endpoint URL. */
  readonly url: string;
  /** Room name re-applied to the URL on every connection. */
  readonly room?: string;
  /** Query-string key for {@linkcode RealtimeClientOptions.room}. Defaults to `'room'`. */
  readonly roomParameter?: string;
  /** Application heartbeat text to suppress and send back. Defaults to `'ping'`. */
  readonly heartbeatPayload?: string;
  /** Injectable constructor seam. Defaults to global WebSocket. */
  readonly webSocket?: WebSocketFactory;
  /** Injectable clock and sleep seam. Defaults to `createDefaultClientTiming()`. */
  readonly timing?: IClientTiming;
  /** Reconnect policy following an unrequested close. */
  readonly reconnect?: RealtimeReconnectOptions;
  /** Optional external signal that permanently closes the client. */
  readonly signal?: AbortSignal;
  /** Parses a non-heartbeat text frame. Defaults to `JSON.parse`. */
  readonly parse?: (data: string) => TIncoming;
  /** Receives parsed application messages in arrival order. */
  readonly onMessage: (message: RealtimeMessage<TIncoming>) => void;
  /** Receives socket or payload parse errors. */
  readonly onError?: (error: unknown) => void;
  /** Receives lifecycle transitions. */
  readonly onStateChange?: (state: RealtimeClientState) => void;
}

/** A running realtime WebSocket client. */
export interface IRealtimeClient<TOutgoing = unknown> {
  /** Current lifecycle state. */
  readonly state: RealtimeClientState;
  /** Serializes non-string values as JSON and sends a text frame. */
  send(message: TOutgoing): void;
  /** Stops future reconnect attempts and closes the active socket. */
  close(code?: number, reason?: string): void;
}
