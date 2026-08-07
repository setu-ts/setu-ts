/**
 * Test fixtures for the WebSocket plugin.
 *
 * The fake runtime's `hrtime()` is a manually-advanced MONOTONIC counter,
 * matching how the real runtime produces it — a fixture that returned a
 * wall-clock epoch here would make a broken duration calculation pass.
 * Intervals are captured rather than scheduled, so heartbeat ticks are driven
 * deterministically instead of by waiting.
 *
 * @module
 */

import type {
  ILogger,
  IRuntimeServices,
  IWebSocketTransport,
  LogMetadata,
  TimerHandle,
  WebSocketReadyState,
} from '@setu-ts/common';

/** A fake runtime with a controllable monotonic clock and captured intervals. */
export interface FakeRuntime extends IRuntimeServices {
  /** Advances the monotonic clock by `ms`. */
  advance(ms: number): void;
  /** The intervals currently registered, in registration order. */
  readonly intervals: { fn: () => void; ms: number; cleared: boolean }[];
  /** Runs every live interval callback once. */
  runIntervals(): void;
}

/**
 * Creates the fake runtime.
 *
 * @param options - Optional uuid prefix
 * @returns The fake runtime
 */
export function createFakeRuntime(options?: { uuidPrefix?: string }): FakeRuntime {
  let uuidCounter = 0;
  let monotonic = 1000;
  const intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];

  return {
    platform: () => 'deno' as const,
    version: () => 'test',
    hostname: () => 'localhost',
    uuid: () => `${options?.uuidPrefix ?? 'conn'}-${uuidCounter++}`,
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as SubtleCrypto,
    now: () => 1_700_000_000_000,
    hrtime: () => monotonic,
    setTimeout: (fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms),
    clearTimeout: (handle: TimerHandle) => clearTimeout(handle as number),
    setInterval: (fn: () => void, ms: number): TimerHandle => {
      const entry = { fn, ms, cleared: false };
      intervals.push(entry);
      return entry as unknown as TimerHandle;
    },
    clearInterval: (handle: TimerHandle) => {
      const entry = handle as unknown as { cleared: boolean };
      if (entry !== null && typeof entry === 'object') {
        entry.cleared = true;
      }
    },
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
    advance(ms: number): void {
      monotonic += ms;
    },
    intervals,
    runIntervals(): void {
      for (const entry of intervals) {
        if (!entry.cleared) {
          entry.fn();
        }
      }
    },
  };
}

/** A transport fake that records everything written to it. */
export interface FakeTransport extends IWebSocketTransport {
  /** Frames passed to `send`, in order. */
  readonly sent: (string | Uint8Array)[];
  /** Arguments of each `close` call. */
  readonly closes: { code: number | undefined; reason: string | undefined }[];
  /** Forces the reported ready state. */
  setReadyState(state: WebSocketReadyState): void;
}

/**
 * Creates a transport fake that starts open.
 *
 * @returns The fake transport
 */
export function createFakeTransport(): FakeTransport {
  const sent: (string | Uint8Array)[] = [];
  const closes: { code: number | undefined; reason: string | undefined }[] = [];
  let state: WebSocketReadyState = 'open';

  return {
    get readyState(): WebSocketReadyState {
      return state;
    },
    send(data: string | Uint8Array): void {
      sent.push(data);
    },
    close(code?: number, reason?: string): void {
      closes.push({ code, reason });
      state = 'closed';
    },
    sent,
    closes,
    setReadyState(next: WebSocketReadyState): void {
      state = next;
    },
  };
}

/**
 * Builds a WebSocket upgrade request with the RFC 6455 headers set.
 *
 * @param url - The request URL
 * @param headers - Extra headers to merge in
 * @returns The request
 */
export function upgradeRequest(url: string, headers?: Record<string, string>): Request {
  return new Request(url, {
    headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers },
  });
}

/** One captured log entry. */
export interface LoggedEntry {
  /** The severity the entry was written at. */
  readonly level: string;
  /** The log message. */
  readonly message: string;
  /** The structured context, when any was supplied. */
  readonly metadata: LogMetadata | undefined;
}

/** A logger fake that records every entry written to it. */
export interface FakeLogger extends ILogger {
  /** Entries recorded so far, in order. */
  readonly entries: LoggedEntry[];
}

/**
 * Creates a logger fake.
 *
 * @returns The fake logger
 */
export function createFakeLogger(): FakeLogger {
  const entries: LoggedEntry[] = [];
  const record = (level: string) => (message: string, metadata?: LogMetadata): void => {
    entries.push({ level, message, metadata });
  };

  const logger: FakeLogger = {
    level: 'trace',
    fatal: record('fatal'),
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    child: () => logger,
    entries,
  };
  return logger;
}

/**
 * Wraps an upgrade request so that reading `headers` fails after the first
 * read, reproducing a request the runtime has already closed underneath us —
 * the failure shape that the real M46 bug took.
 *
 * Called directly on the service's router, the first read is the route table's
 * subprotocol lookup and the second is the context snapshot, so the throw
 * lands *after* an admission slot has been claimed — the case that
 * distinguishes a leaked slot from a released one. Driven through `app.fetch`
 * the adapter's upgrade detection takes the first read instead and the route
 * table throws on the second; either way the router must contain it.
 *
 * @param url - The request URL
 * @returns The booby-trapped request
 */
export function requestFailingOnSecondHeaderRead(url: string): Request {
  const request = upgradeRequest(url);
  let reads = 0;
  return new Proxy(request, {
    get(target, prop, receiver): unknown {
      if (prop === 'headers') {
        reads++;
        if (reads > 1) {
          throw new Error('request already closed');
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
