/** Public contracts for the portable SSE client. */

import type { IClientTiming } from '../http/contracts.ts';

/** A map from SSE event names to their parsed payload types. */
export type SseEventMap = Record<string, unknown>;

/** One parsed SSE event delivered to an application. */
export interface SseEvent<TName extends string = string, TData = unknown> {
  /** Server-provided event name, or `'message'` when omitted on the wire. */
  readonly event: TName;
  /** Parsed event payload. */
  readonly data: TData;
  /** Server event ID, when supplied. */
  readonly id?: string;
}

/** The lifecycle state of an SSE client. */
export type SseClientState = 'connecting' | 'open' | 'closed';

/** Reconnection policy for an SSE stream. */
export interface SseReconnectOptions {
  /** Maximum reconnect attempts after a stream failure. Omit for unlimited attempts. */
  readonly maxAttempts?: number;
  /** Default reconnect delay in milliseconds. Defaults to 1,000. */
  readonly delayMs?: number;
  /** Upper bound for exponential reconnect delay. Defaults to 30,000. */
  readonly maxDelayMs?: number;
}

/** The source frame given to a custom SSE payload parser. */
export interface RawSseEvent {
  /** Server-provided event name, or `'message'` when omitted. */
  readonly event: string;
  /** Joined raw `data:` lines. */
  readonly data: string;
  /** Server event ID, when supplied. */
  readonly id?: string;
}

/** Configuration for {@linkcode createSseClient}. */
export interface SseClientOptions<TEvents extends SseEventMap = SseEventMap> {
  /** Absolute SSE endpoint URL. */
  readonly url: string;
  /** Headers cloned into every initial and reconnect request. */
  readonly headers?: HeadersInit;
  /** Injectable streaming transport. Defaults to global `fetch`. */
  readonly fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  /** Injectable clock and sleep seam. Defaults to `createDefaultClientTiming()`. */
  readonly timing?: IClientTiming;
  /** External signal that closes the stream and prevents reconnects. */
  readonly signal?: AbortSignal;
  /** Reconnect behavior after an ended or failed stream. */
  readonly reconnect?: SseReconnectOptions;
  /**
   * Parses one raw SSE event. Defaults to `JSON.parse` and is typed against
   * the event map so applications can refine payloads by event name.
   */
  readonly parse?: (event: RawSseEvent) => TEvents[keyof TEvents];
  /** Receives every parsed data-bearing event in stream order. */
  readonly onEvent: (
    event: SseEvent<keyof TEvents & string, TEvents[keyof TEvents]>,
  ) => void | Promise<void>;
  /** Receives recoverable transport or parse errors before a reconnect attempt. */
  readonly onError?: (error: unknown) => void;
  /** Receives each state transition. */
  readonly onStateChange?: (state: SseClientState) => void;
}

/** A running SSE client returned by {@linkcode createSseClient}. */
export interface ISseClient {
  /** Current lifecycle state. */
  readonly state: SseClientState;
  /** Stops the active stream and disables every future reconnect attempt. */
  close(): void;
}
