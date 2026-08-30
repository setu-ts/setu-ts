/** WebSocket client implementing the server heartbeat and room-rejoin contract. */

import { createDefaultClientTiming } from '../http/timing.ts';
import type { IClientTiming } from '../http/contracts.ts';
import type {
  IRealtimeClient,
  IWebSocketTransport,
  RealtimeClientOptions,
  RealtimeClientState,
  RealtimeReconnectOptions,
  WebSocketFactory,
} from './websocket-contracts.ts';

const OPEN = 1;
const DEFAULT_HEARTBEAT_PAYLOAD = 'ping';
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

/** Creates and immediately connects a portable WebSocket realtime client. */
export function createRealtimeClient<TIncoming = unknown, TOutgoing = unknown>(
  options: RealtimeClientOptions<TIncoming>,
): IRealtimeClient<TOutgoing> {
  return new RealtimeClient(options, options.timing ?? createDefaultClientTiming());
}

/** Internal implementation retained behind the public interface. */
class RealtimeClient<TIncoming, TOutgoing> implements IRealtimeClient<TOutgoing> {
  readonly #options: RealtimeClientOptions<TIncoming>;
  readonly #timing: IClientTiming;
  readonly #factory: WebSocketFactory;
  readonly #controller = new AbortController();
  #socket: IWebSocketTransport | undefined;
  #state: RealtimeClientState = 'connecting';
  #closed = false;
  #attempts = 0;

  constructor(options: RealtimeClientOptions<TIncoming>, timing: IClientTiming) {
    validateReconnect(options.reconnect);
    this.#options = options;
    this.#timing = timing;
    this.#factory = options.webSocket ?? defaultWebSocket;
    if (options.signal?.aborted) {
      this.#closed = true;
      this.#controller.abort();
      this.#setState('closed');
      return;
    }
    options.signal?.addEventListener('abort', () => this.close(), { once: true });
    this.#connect();
  }

  get state(): RealtimeClientState {
    return this.#state;
  }

  send(message: TOutgoing): void {
    if (this.#socket?.readyState !== OPEN) throw new Error('Realtime client is not connected.');
    this.#socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  close(code?: number, reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    // Aborting disarms a reconnect delay already sleeping. Without this the
    // timer stays pending for up to `maxDelayMs`, holding the process open
    // long after the caller closed the client.
    this.#controller.abort();
    this.#setState('closed');
    this.#socket?.close(code, reason);
  }

  #connect(): void {
    if (this.#closed) return;
    this.#setState('connecting');
    let socket: IWebSocketTransport;
    try {
      socket = this.#factory(this.#url());
    } catch (error: unknown) {
      this.#options.onError?.(error);
      void this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#closed || socket !== this.#socket) return;
      this.#setState('open');
    };
    socket.onmessage = (event) => this.#onMessage(socket, event);
    socket.onerror = () => this.#options.onError?.(new Error('Realtime WebSocket error.'));
    socket.onclose = () => {
      if (socket !== this.#socket || this.#closed) return;
      void this.#scheduleReconnect();
    };
  }

  #onMessage(socket: IWebSocketTransport, event: MessageEvent): void {
    if (this.#closed || socket !== this.#socket || typeof event.data !== 'string') return;
    const heartbeat = this.#options.heartbeatPayload ?? DEFAULT_HEARTBEAT_PAYLOAD;
    if (event.data === heartbeat) {
      if (socket.readyState === OPEN) socket.send(heartbeat);
      return;
    }
    try {
      const data = this.#options.parse === undefined
        ? JSON.parse(event.data) as TIncoming
        : this.#options.parse(event.data);
      this.#options.onMessage({ data });
    } catch (error: unknown) {
      this.#options.onError?.(error);
    }
  }

  async #scheduleReconnect(): Promise<void> {
    if (this.#closed || !canReconnect(this.#attempts, this.#options.reconnect)) {
      this.close();
      return;
    }
    this.#attempts++;
    const delay = Math.min(
      (this.#options.reconnect?.delayMs ?? DEFAULT_RECONNECT_DELAY_MS) *
        (2 ** (this.#attempts - 1)),
      this.#options.reconnect?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
    );
    this.#setState('connecting');
    try {
      await this.#timing.sleep(delay, this.#controller.signal);
    } catch {
      return;
    }
    this.#connect();
  }

  #url(): string {
    const url = new URL(this.#options.url);
    if (this.#options.room !== undefined) {
      url.searchParams.set(this.#options.roomParameter ?? 'room', this.#options.room);
    }
    return url.toString();
  }

  #setState(state: RealtimeClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }
}

function defaultWebSocket(url: string): IWebSocketTransport {
  return new WebSocket(url);
}

function canReconnect(attempts: number, options: RealtimeReconnectOptions | undefined): boolean {
  return options?.maxAttempts === undefined || attempts < options.maxAttempts;
}

function validateReconnect(options: RealtimeReconnectOptions | undefined): void {
  if (
    options?.maxAttempts !== undefined &&
    (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 0)
  ) {
    throw new Error('reconnect.maxAttempts must be a non-negative integer.');
  }
  if (!isNonNegativeFinite(options?.delayMs)) {
    throw new Error('reconnect.delayMs must be a finite non-negative number.');
  }
  if (!isNonNegativeFinite(options?.maxDelayMs)) {
    throw new Error('reconnect.maxDelayMs must be a finite non-negative number.');
  }
}

/** Rejects timer values that native platforms would coerce into a hot loop. */
function isNonNegativeFinite(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}
