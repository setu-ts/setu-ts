import type {
  HandlerResult,
  IRequest,
  IRequestContext,
  IResponse,
  IRuntimeServices,
  ResponseSnapshot,
} from '@hono-enterprise/common';
import type { HttpMethod } from '@hono-enterprise/common';
import type { IPrincipal } from '@hono-enterprise/common';
import type { ITenant } from '@hono-enterprise/common';

import { MockServiceRegistry } from './mock-registry.ts';

// ---------------------------------------------------------------------------
// Internal default fake runtime (monotonic, never Date.now())
// ---------------------------------------------------------------------------

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
  randomBytes: (_length: number): Uint8Array => new Uint8Array(0),
  subtle: null as unknown as SubtleCrypto,
  now: () => 0,
  hrtime: () => 0,
  setTimeout: (fn: () => void, ms: number): ReturnType<IRuntimeServices['setTimeout']> =>
    setTimeout(fn, ms),
  clearTimeout: clearTimeout.bind(globalThis),
  setInterval: (fn: () => void, ms: number): ReturnType<IRuntimeServices['setInterval']> =>
    setInterval(fn, ms),
  clearInterval: clearInterval.bind(globalThis),
  env: new Map() as unknown as Readonly<Record<string, string | undefined>>,
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
  /** Service registry — defaults to `new MockServiceRegistry()`. */
  services?: MockServiceRegistry;
  /** Response builder — defaults to `new MockResponse()`. */
  response?: IResponse;
  /** Path parameters — defaults to `{}`. */
  params?: Record<string, string>;
  /** Query string parameters — defaults to parse from the request URL's search params. */
  query?: Record<string, string>;
  /** Request-scoped state — defaults to `new Map()`. */
  state?: Map<string, unknown>;
  /** Abort signal — defaults to a live, never-aborting `AbortController().signal`. */
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
  #body: unknown;

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
    this.#body = options.body;
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

  json<T = unknown>(): Promise<T> {
    if (typeof this.#body === 'string') {
      return Promise.resolve(JSON.parse(this.#body) as T);
    }
    return Promise.resolve(this.#body as T);
  }

  text(): Promise<string> {
    return Promise.resolve(typeof this.#body === 'string' ? this.#body : '');
  }

  bytes(): Promise<Uint8Array> {
    const str = typeof this.#body === 'string' ? this.#body : '';
    return Promise.resolve(new TextEncoder().encode(str));
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
 * import { createTestContext } from '@hono-enterprise/testing';
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
  const signal = options?.signal ?? new AbortController().signal;

  // Build the mock request
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
    signal,
    ...(reqOptions.ip !== undefined ? { ip: reqOptions.ip } : {}),
    ...(reqOptions.user !== undefined ? { user: reqOptions.user } : {}),
    ...(reqOptions.tenant !== undefined ? { tenant: reqOptions.tenant } : {}),
  });

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
