/**
 * Test fixtures: a minimal request context and service registry.
 *
 * Written here rather than imported from `@hono-enterprise/testing` so the
 * plugin's tests carry no extra workspace dependency, and deliberately faithful
 * to how the real producers behave — a fixture that diverges from the kernel
 * tests the fixture instead of the code. In particular `startTime` is a
 * monotonic `hrtime()`-style reading rather than a wall-clock epoch, and
 * `request.text()` is replayable, matching the runtime's pre-read body mapping.
 *
 * @module
 */
import type {
  HandlerResult,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
  ResponseSnapshot,
} from '@hono-enterprise/common';

/** Records everything a response builder was asked to do. */
export class FakeResponse implements IResponse {
  readonly headers = new Headers();
  statusCode = 200;
  body: unknown = null;
  ended = false;

  status(code: number): IResponse {
    this.statusCode = code;
    return this;
  }

  header(name: string, value: string): IResponse {
    this.headers.set(name, value);
    return this;
  }

  appendHeader(name: string, value: string): IResponse {
    this.headers.append(name, value);
    return this;
  }

  json<T>(body: T): HandlerResult {
    this.body = body;
    this.ended = true;
    return BRAND;
  }

  text(body: string): HandlerResult {
    this.body = body;
    this.ended = true;
    return BRAND;
  }

  send(body?: Uint8Array): HandlerResult {
    this.body = body ?? null;
    this.ended = true;
    return BRAND;
  }

  redirect(url: string, status = 302): HandlerResult {
    this.statusCode = status;
    this.headers.set('location', url);
    this.ended = true;
    return BRAND;
  }

  stream(body: ReadableStream<Uint8Array>): HandlerResult {
    this.body = body;
    this.ended = true;
    return BRAND;
  }

  snapshot(): ResponseSnapshot {
    return {
      streaming: false,
      status: this.statusCode,
      headers: this.headers,
      body: null,
    };
  }

  /** Every `Set-Cookie` this response emitted. */
  setCookies(): readonly string[] {
    return this.headers.getSetCookie();
  }
}

/** The opaque handler-result brand; only its identity matters. */
const BRAND = { __handlerResult: true } as const satisfies HandlerResult;

/** A registry backed by a plain map. */
export class FakeRegistry implements IServiceRegistry {
  readonly #services = new Map<string, object>();

  register<T extends object>(token: string, service: T): void {
    this.#services.set(token, service);
  }

  registerFactory<T extends object>(token: string, factory: () => T): void {
    this.#services.set(token, factory());
  }

  get<T extends object>(token: string): T {
    const service = this.#services.get(token);
    if (service === undefined) {
      throw new Error(`No service registered for '${token}'`);
    }
    return service as T;
  }

  getAll<T extends object>(token: string): readonly T[] {
    const service = this.#services.get(token);
    return service === undefined ? [] : [service as T];
  }

  has(token: string): boolean {
    return this.#services.has(token);
  }

  unregister(token: string): boolean {
    return this.#services.delete(token);
  }

  createScope(): IServiceRegistry {
    return this;
  }
}

/** Options for {@linkcode makeContext}. */
export interface MakeContextOptions {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly registry?: FakeRegistry;
}

/** A context plus direct handles on its fake response and registry. */
export interface TestContext {
  readonly ctx: IRequestContext;
  readonly response: FakeResponse;
  readonly registry: FakeRegistry;
}

/**
 * Builds a request context suitable for driving middleware and services.
 *
 * @param options - Request shape and registry
 * @returns The context and its fakes
 */
export function makeContext(options: MakeContextOptions = {}): TestContext {
  const response = new FakeResponse();
  const registry = options.registry ?? new FakeRegistry();
  const body = options.body ?? '';

  const request: IRequest = {
    method: (options.method ?? 'GET') as IRequest['method'],
    url: options.url ?? 'http://localhost/',
    path: new URL(options.url ?? 'http://localhost/').pathname,
    headers: new Headers(options.headers ?? {}),
    // Replayable, exactly like the runtime's pre-read mapping: reading the body
    // in CSRF middleware must not starve the handler.
    json: <T = unknown>(): Promise<T> => Promise.resolve(JSON.parse(body) as T),
    text: (): Promise<string> => Promise.resolve(body),
    bytes: (): Promise<Uint8Array> => Promise.resolve(new TextEncoder().encode(body)),
  };

  const ctx: IRequestContext = {
    id: 'test-request',
    request,
    response,
    services: registry,
    params: {},
    query: {},
    state: new Map<string, unknown>(),
    // Monotonic, as the kernel sets it — never Date.now().
    startTime: 1234.5,
    signal: new AbortController().signal,
  };

  return { ctx, response, registry };
}

/** A deterministic clock and id source for tests. */
export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  uuid(): string;
}

/**
 * Creates a controllable clock plus a counting uuid source.
 *
 * @param start - Initial wall-clock reading in milliseconds
 * @returns The clock
 */
export function makeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  let counter = 0;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    uuid: () => `id-${++counter}`,
  };
}

/** Deterministic, non-random bytes: enough for tests, never for production. */
export function fakeRandomBytes(length: number): Uint8Array {
  return new Uint8Array(length).map((_v, i) => (i * 7 + 13) % 256);
}
