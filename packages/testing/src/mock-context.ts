import type {
  HandlerResult,
  IRequest,
  IRequestContext,
  IResponse,
  IRuntimeServices,
  IServiceRegistry,
  ResponseSnapshot,
  TimerHandle,
} from '@setu-ts/common';
import type { HttpMethod } from '@setu-ts/common';
import type { IPrincipal } from '@setu-ts/common';
import type { ITenant } from '@setu-ts/common';

import { MockServiceRegistry } from './mock-registry.ts';

// ---------------------------------------------------------------------------
// Internal default fake runtime (monotonic, never Date.now())
// ---------------------------------------------------------------------------

/** Opaque handle returned by the inert default timers. */
const INERT_TIMER_HANDLE: TimerHandle = Symbol('inert-timer');

/**
 * Default fake runtime used by {@linkcode createTestContext} when no
 * `options.runtime` is provided.
 *
 * Provides monotonic defaults (`hrtime: () => 0`) so that duration
 * calculations are never contaminated by wall-clock epoch values
 * (`Date.now()`). Tests that need a controllable clock inject their own
 * `IRuntimeServices` (the established per-package fake-runtime.ts pattern).
 *
 * @internal NOT exported — see decision 3.9
 */
const DEFAULT_TEST_RUNTIME: IRuntimeServices = {
  platform: (): 'node' | 'deno' | 'bun' | 'cloudflare-workers' => 'deno',
  version: () => '0.0.0',
  hostname: () => 'localhost',
  uuid: () => 'test-ctx',
  // Honors the length contract: `randomBytes(n)` returns exactly n bytes
  // (deterministic zeros — a fake must not shorten what it hands back, or
  // code under test that derives a token/IV from it silently gets nothing).
  randomBytes: (length: number): Uint8Array => new Uint8Array(length),
  // An empty SubtleCrypto stand-in rather than `null`: a missing method reads
  // as `undefined` (checkable) instead of throwing on property access.
  subtle: {} as SubtleCrypto,
  now: () => 0,
  hrtime: () => 0,
  // Inert no-op timers. A default fixture must never arm a REAL timer: the
  // callback would fire after the test that created it has finished, leaking
  // an op past the test boundary and polluting whatever runs next.
  setTimeout: (): TimerHandle => INERT_TIMER_HANDLE,
  clearTimeout: (): void => {},
  setInterval: (): TimerHandle => INERT_TIMER_HANDLE,
  clearInterval: (): void => {},
  // A plain object, not a Map: the contract is
  // `Readonly<Record<string, string | undefined>>`, and a Map answers
  // `env['KEY']` with undefined and `Object.keys(env)` with [] no matter what
  // it holds — a double that cannot behave like the thing it stands in for.
  env: {},
  exit: (): never => {
    throw new Error('exit called in test environment');
  },
};

/**
 * Returns the internal default test runtime for direct accessor verification.
 * Exported solely for unit-test coverage of DEFAULT_TEST_RUNTIME's remaining
 * accessors (platform, version, hostname, now, randomBytes, setTimeout,
 * setInterval, exit). NOT part of the public API.
 * @internal
 */
export function _getDefaults(): typeof DEFAULT_TEST_RUNTIME {
  return DEFAULT_TEST_RUNTIME;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@linkcode createTestContext}.
 *
 * @since 0.1.0
 */
export interface TestContextOptions {
  /** Partial `IRequest` overrides (method, url, headers, etc.). */
  request?: Partial<IRequest>;
  /** Body backing `json()`/`text()`/`bytes()` on the mock request. */
  body?: unknown;
  /** Runtime services — when absent, the internal default is used. */
  runtime?: IRuntimeServices;
  /**
   * Service registry — defaults to `new MockServiceRegistry()`.
   *
   * Typed as the `IServiceRegistry` interface (not the concrete
   * `MockServiceRegistry`) so a test may pass any implementation — a custom
   * fake, or a real kernel registry taken from a started app — matching
   * `IRequestContext.services`.
   */
  services?: IServiceRegistry;
  /** Response builder — defaults to `new MockResponse()`. */
  response?: IResponse;
  /** Path parameters — defaults to `{}`. */
  params?: Record<string, string>;
  /** Query string parameters — defaults to parse from the request URL's search params. */
  query?: Record<string, string>;
  /** Request-scoped state — defaults to `new Map()`. */
  state?: Map<string, unknown>;
  /**
   * Abort signal for `ctx.signal`. Precedence is
   * `options.request.signal` > `options.signal` > a live, never-aborting
   * `AbortController().signal` — `request.signal` wins because that is the
   * kernel's own rule (`request.signal ?? NEVER_ABORT_CONTROLLER.signal`).
   */
  signal?: AbortSignal;
  /**
   * Direct `startTime` override — highest precedence:
   * `options.startTime ?? options.runtime?.hrtime() ?? 0`.
   * Must be a monotonic reading, never `Date.now()`.
   */
  startTime?: number;
}

// ---------------------------------------------------------------------------
// MockRequest — internal IRequest double
// ---------------------------------------------------------------------------

/**
 * Internal mock `IRequest` used by {@linkcode createTestContext}.
 * Body readers are backed by the `body` field in `TestContextOptions`.
 */
class MockRequest implements IRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly path: string;
  readonly headers: Headers;
  readonly ip?: string;
  user?: IPrincipal;
  tenant?: ITenant;
  readonly signal?: AbortSignal;
  /**
   * The body reduced ONCE to its wire form, so `json()`, `text()` and
   * `bytes()` can never disagree about what the request carries.
   *
   * Mirrors the kernel's own synthetic inject request, which stringifies a
   * non-string body and serves all three readers off that one string
   * (`application.ts:376-410`). Deriving each reader from the raw value
   * independently is what let an object body answer `json()` correctly while
   * `text()` returned `''` and `bytes()` returned 0 bytes.
   */
  readonly #bodyText: string;
  /** Retained so `bytes()` returns the caller's exact buffer, not a re-encode. */
  readonly #bodyBytes: Uint8Array | undefined;

  constructor(options: {
    method: string;
    url: string;
    path?: string;
    headers?: Headers;
    body?: unknown;
    signal?: AbortSignal;
    ip?: string;
    user?: IPrincipal;
    tenant?: ITenant;
  }) {
    this.method = options.method as HttpMethod;
    this.url = options.url;
    this.path = options.path ?? new URL(options.url).pathname;
    this.headers = options.headers ?? new Headers();
    this.#bodyBytes = options.body instanceof Uint8Array ? options.body : undefined;
    this.#bodyText = MockRequest.#toBodyText(options.body);
    if (options.signal !== undefined) {
      this.signal = options.signal;
    }
    if (options.ip !== undefined) {
      this.ip = options.ip;
    }
    if (options.user !== undefined) {
      this.user = options.user;
    }
    if (options.tenant !== undefined) {
      this.tenant = options.tenant;
    }
  }

  /**
   * Reduces any supported body value to the single wire string all three
   * readers serve from.
   */
  static #toBodyText(body: unknown): string {
    if (body === undefined || body === null) {
      return '';
    }
    if (typeof body === 'string') {
      return body;
    }
    if (body instanceof Uint8Array) {
      return new TextDecoder().decode(body);
    }
    // Objects, arrays, numbers, booleans — same treatment the kernel's
    // inject() gives a non-string body.
    return JSON.stringify(body);
  }

  json<T = unknown>(): Promise<T> {
    return Promise.resolve(JSON.parse(this.#bodyText === '' ? '{}' : this.#bodyText) as T);
  }

  text(): Promise<string> {
    return Promise.resolve(this.#bodyText);
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(this.#bodyBytes ?? new TextEncoder().encode(this.#bodyText));
  }
}

// ---------------------------------------------------------------------------
// MockResponse — internal IResponse double
// ---------------------------------------------------------------------------

/**
 * In-memory `IResponse` double with `snapshot()` and `ended` getter.
 *
 * Implements the full `IResponse` surface so that middleware tests can
 * inspect `snapshot()` (status, headers, body) and assert short-circuit
 * behavior via the `ended` getter. Chaining methods (`status`, `header`,
 * `appendHeader`) return `this`; terminal methods set `#ended = true` and
 * return a `HandlerResult` brand.
 *
 * @since 0.1.0
 */
export class MockResponse implements IResponse {
  #status = 200;
  #headers = new Headers();
  #body: Uint8Array | string | null = null;
  #streaming = false;
  #streamBody: ReadableStream<Uint8Array> | null = null;
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  status(code: number): IResponse {
    this.#status = code;
    return this;
  }

  header(name: string, value: string): IResponse {
    this.#headers.set(name, value);
    return this;
  }

  appendHeader(name: string, value: string): IResponse {
    this.#headers.append(name, value);
    return this;
  }

  json<T>(_body: T): HandlerResult {
    this.#body = JSON.stringify(_body);
    this.#headers.set('content-type', 'application/json; charset=utf-8');
    this.#ended = true;
    return { __handlerResult: true };
  }

  text(_body: string): HandlerResult {
    this.#body = _body;
    this.#headers.set('content-type', 'text/plain; charset=utf-8');
    this.#ended = true;
    return { __handlerResult: true };
  }

  send(_body?: Uint8Array): HandlerResult {
    this.#body = _body ?? null;
    if (_body !== undefined && !this.#headers.has('content-type')) {
      this.#headers.set('content-type', 'application/octet-stream');
    }
    this.#ended = true;
    return { __handlerResult: true };
  }

  redirect(url: string, _status?: number): HandlerResult {
    this.#status = _status ?? 302;
    this.header('Location', url);
    this.#body = null;
    this.#ended = true;
    return { __handlerResult: true };
  }

  stream(body: ReadableStream<Uint8Array>): HandlerResult {
    this.#streaming = true;
    this.#streamBody = body;
    this.#ended = true;
    return { __handlerResult: true };
  }

  snapshot(): ResponseSnapshot {
    if (this.#streaming && this.#streamBody !== null) {
      return {
        streaming: true,
        status: this.#status,
        headers: this.#headers,
        body: this.#streamBody,
      };
    }
    return {
      streaming: false,
      status: this.#status,
      headers: this.#headers,
      body: this.#body,
    };
  }
}

// ---------------------------------------------------------------------------
// createTestContext
// ---------------------------------------------------------------------------

/**
 * Builds a contract-faithful `IRequestContext` for unit-testing middleware
 * and handlers in isolation (no started app needed).
 *
 * Replicates the kernel's internal `createRequestContext` construction:
 * `id` from `runtime.uuid()`, `startTime` from `runtime.hrtime()` (monotonic),
 * `signal` from a never-aborting `AbortController`. All fields are
 * overridable via `options`.
 *
 * @example
 * ```typescript
 * import { createTestContext } from '@setu-ts/testing';
 *
 * const ctx = createTestContext();
 * expect(ctx.id).toBe('test-ctx');
 * expect(ctx.startTime).toBe(0); // monotonic, never Date.now()
 * expect(ctx.signal).toBeInstanceOf(AbortSignal);
 * ```
 *
 * @param options - Context options
 * @returns A test `IRequestContext`
 * @since 0.1.0
 */
export function createTestContext(options?: TestContextOptions): IRequestContext {
  const runtime = options?.runtime ?? DEFAULT_TEST_RUNTIME;

  // Build the mock request first so we can derive signal from request.signal
  const reqOptions = options?.request ?? {};
  const method = reqOptions.method ?? 'GET';
  const url = reqOptions.url ?? 'http://localhost/';
  const resolvedPath = reqOptions.path ?? new URL(url).pathname;
  const headers = reqOptions.headers ?? new Headers();
  const mockRequest = new MockRequest({
    method,
    url,
    path: resolvedPath,
    headers,
    body: options?.body,
    ...(reqOptions.signal !== undefined ? { signal: reqOptions.signal } : {}),
    ...(reqOptions.ip !== undefined ? { ip: reqOptions.ip } : {}),
    ...(reqOptions.user !== undefined ? { user: reqOptions.user } : {}),
    ...(reqOptions.tenant !== undefined ? { tenant: reqOptions.tenant } : {}),
  });

  // Signal precedence: options.request.signal (propagated via mockRequest) >
  // options.signal (top-level override) > live never-aborting AbortController.
  // Matches the kernel's: request.signal ?? NEVER_ABORT_CONTROLLER.signal
  const signal = reqOptions.signal ?? options?.signal ?? new AbortController().signal;

  // Parse query from URL when not provided
  let query = options?.query;
  if (query === undefined) {
    const urlObj = new URL(url);
    query = Object.fromEntries(urlObj.searchParams.entries());
  }

  const state = options?.state ?? new Map();
  const services = options?.services ?? new MockServiceRegistry();
  const response = options?.response ?? new MockResponse();

  // startTime precedence: direct override > runtime.hrtime() > default 0
  const startTime = options?.startTime ?? runtime.hrtime();

  return {
    id: runtime.uuid(),
    request: mockRequest,
    response,
    services,
    params: options?.params ?? {},
    query,
    state,
    startTime,
    signal,
  };
}
