/**
 * Fake runtime plugin fixture — provides deterministic {@linkcode IRuntimeServices}
 * with a uuid counter and manual clock for testing without real timers/UUIDs.
 *
 * @module
 */
import type {
  IHttpAdapter,
  IRuntimeServices,
  RuntimePlatform,
  ServerHandle,
  TimerHandle,
} from '@hono-enterprise/common';

import type { IRequest } from '@hono-enterprise/common';

export interface FakeRuntimeOptions {
  /** Seed value for UUID counter. */
  uuidSeed?: number;
  /** Initial clock time in milliseconds. */
  clock?: number;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
  /** Platform identifier. */
  platform?: RuntimePlatform;
}

/**
 * Creates a fake runtime services implementation for testing.
 *
 * @param options - Configuration options for the fake runtime
 * @returns The fake runtime services and control methods
 */
export function createFakeRuntime(options: FakeRuntimeOptions = {}): {
  runtime: IRuntimeServices;
  tick: (ms: number) => void;
  uuidSeed: number;
  adapter: FakeHttpAdapter;
} {
  let uuidCounter = options.uuidSeed ?? 0;
  let clock = options.clock ?? 0;
  const timers: { fn: () => void; delay: number; id: number }[] = [];
  let timerId = 0;

  const adapter = new FakeHttpAdapter();

  return {
    runtime: {
      platform: () => options.platform ?? 'deno',
      version: () => '2.0.0-fake',
      hostname: () => 'test-host',
      uuid: () => {
        uuidCounter++;
        return `test-uuid-${uuidCounter}`;
      },
      randomBytes: (length: number) => new Uint8Array(length).fill(0),
      get subtle(): SubtleCrypto {
        // Return a minimal SubtleCrypto stub — tests shouldn't use this
        throw new Error('SubtleCrypto not implemented in fake runtime');
      },
      now: () => clock,
      hrtime: () => clock,
      setTimeout: (fn: () => void, ms: number): TimerHandle => {
        timerId++;
        timers.push({ fn, delay: ms, id: timerId });
        return timerId;
      },
      clearTimeout: (handle: TimerHandle): void => {
        const idx = timers.findIndex((t) => t.id === (handle as number));
        if (idx !== -1) {
          timers.splice(idx, 1);
        }
      },
      setInterval: (fn: () => void, ms: number): TimerHandle => {
        timerId++;
        timers.push({ fn, delay: ms, id: timerId });
        return timerId;
      },
      clearInterval: (handle: TimerHandle): void => {
        const idx = timers.findIndex((t) => t.id === (handle as number));
        if (idx !== -1) {
          timers.splice(idx, 1);
        }
      },
      env: options.env ?? {},
      exit: () => {
        throw new Error('fake runtime exit called');
      },
    },
    tick: (ms: number) => {
      clock += ms;
      for (const timer of timers) {
        if (timer.delay <= ms) {
          timer.fn();
        }
      }
    },
    get uuidSeed() {
      return uuidCounter;
    },
    adapter,
  };
}

/**
 * Fake HTTP adapter that stores the handler for injection-based testing.
 */
export class FakeHttpAdapter implements IHttpAdapter {
  #handler: ((request: IRequest) => Promise<unknown>) | null = null;
  #listening = false;
  #port = 0;

  setHandler(handler: (request: IRequest) => Promise<unknown>): void {
    this.#handler = handler;
  }

  fetch(_request: Request): Promise<Response> {
    if (!this.#handler) {
      return Promise.resolve(new Response('Handler not set', { status: 500 }));
    }
    // This is for app.fetch testing; the handler expects IRequest, not web Request.
    // For unit tests that only use inject(), this path isn't exercised.
    return Promise.resolve(new Response('Not implemented for web Request', { status: 501 }));
  }

  listen(_port: number, _hostname?: string): Promise<ServerHandle> {
    this.#listening = true;
    this.#port = _port;
    return Promise.resolve({} as ServerHandle);
  }

  close(_handle: ServerHandle): Promise<void> {
    this.#listening = false;
    this.#port = 0;
    return Promise.resolve();
  }

  get handler() {
    return this.#handler;
  }

  get listening() {
    return this.#listening;
  }

  get port() {
    return this.#port;
  }
}
