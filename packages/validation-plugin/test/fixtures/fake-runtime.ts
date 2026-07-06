/**
 * Test fixtures for validation-plugin tests.
 *
 * Provides faithful test doubles for IRequestContext, IRequest, IResponse,
 * and IServiceRegistry matching the real kernel shapes exactly.
 */
import type {
  HandlerResult,
  HttpMethod,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@hono-enterprise/common';

// ---------------------------------------------------------------------------
// Fake IRequest
// ---------------------------------------------------------------------------

/** Configuration for creating a fake request. */
export interface FakeRequestOptions {
  /** HTTP method. Defaults to `'GET'`. */
  method?: HttpMethod;
  /** Full request URL. Defaults to `'http://localhost:3000/'`. */
  url?: string;
  /** URL path component. Defaults to `'/'`. */
  path?: string;
  /** Body to return from `json()`. Defaults to `{}`. */
  body?: unknown;
  /** When true, `json()` throws a SyntaxError. */
  bodyError?: boolean;
  /** Initial headers as a record. */
  headers?: Record<string, string>;
  /** Client IP. */
  ip?: string;
}

/** Create a fake IRequest matching the real kernel shapes. */
export function createFakeRequest(opts: FakeRequestOptions = {}): IRequest {
  const headers = new Headers(opts.headers ?? {});
  const method: HttpMethod = opts.method ?? 'GET';
  const url = opts.url ?? 'http://localhost:3000/';
  const path = opts.path ?? '/';

  const request: IRequest = {
    method,
    url,
    path,
    headers,
    ...(opts.ip !== undefined && { ip: opts.ip }),
    json<T = unknown>(): Promise<T> {
      if (opts.bodyError) {
        throw new SyntaxError('Unexpected token in JSON');
      }
      return Promise.resolve((opts.body ?? {}) as T);
    },
    text(): Promise<string> {
      if (opts.bodyError) {
        throw new SyntaxError('Unexpected token in JSON');
      }
      if (typeof opts.body === 'string') {
        return Promise.resolve(opts.body);
      }
      return Promise.resolve(JSON.stringify(opts.body ?? ''));
    },
    async bytes(): Promise<Uint8Array> {
      const text = await this.text();
      return new TextEncoder().encode(text);
    },
  };

  return request;
}

// ---------------------------------------------------------------------------
// Fake IResponse (mirrors ResponseBuilder)
// ---------------------------------------------------------------------------

/** Opaque brand — only the kernel constructs real values of this type. */
const HANDLER_RESULT: HandlerResult = { __handlerResult: true };

/** Result of {@linkcode createFakeResponse}. */
export interface FakeResponseResult {
  /** The fake response builder. */
  response: IResponse;
  /** Capture the current response state for assertions. */
  snapshot: () => { status: number; headers: Headers; body: string | null };
}

/** Create a fake IResponse with a snapshot for assertions. */
export function createFakeResponse(): FakeResponseResult {
  let status = 200;
  const headers = new Headers();
  let body: string | null = null;

  const response: IResponse = {
    status(code: number): IResponse {
      status = code;
      return response;
    },
    header(_name: string, _value: string): IResponse {
      return response;
    },
    json<T>(b: T): HandlerResult {
      body = JSON.stringify(b);
      headers.set('content-type', 'application/json; charset=utf-8');
      return HANDLER_RESULT;
    },
    text(_b: string): HandlerResult {
      return HANDLER_RESULT;
    },
    send(_b?: Uint8Array): HandlerResult {
      return HANDLER_RESULT;
    },
    redirect(_url: string, _status?: number): HandlerResult {
      return HANDLER_RESULT;
    },
  };

  return {
    response,
    snapshot: () => ({ status, headers, body }),
  };
}

// ---------------------------------------------------------------------------
// Fake IServiceRegistry (Map-backed)
// ---------------------------------------------------------------------------

/** Create a Map-backed fake IServiceRegistry. */
export function createFakeServiceRegistry(
  map: Map<string, unknown> = new Map(),
): IServiceRegistry {
  return {
    register<T>(key: string, service: T): void {
      map.set(key, service);
    },
    registerFactory<T>(_key: string, _factory: () => T): void {
      // no-op for tests
    },
    get<T>(key: string): T {
      const value = map.get(key);
      if (value === undefined) {
        throw new Error(`Service not found: ${key}`);
      }
      return value as T;
    },
    getAll<T>(): T[] {
      return [];
    },
    has(key: string): boolean {
      return map.has(key);
    },
    unregister(key: string): boolean {
      return map.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake IRequestContext
// ---------------------------------------------------------------------------

/** Configuration for creating a fake request context. */
export interface FakeContextOptions {
  /** Request configuration. */
  request?: FakeRequestOptions;
  /** Query parameters. Defaults to `{}`. */
  query?: Record<string, string>;
  /** Path parameters. Defaults to `{}`. */
  params?: Record<string, string>;
  /** Pre-populated service registry entries. */
  services?: Map<string, unknown>;
}

/** Result of {@linkcode createFakeContext}. */
export interface FakeContextResult {
  /** The fake request context. */
  ctx: IRequestContext;
  /** Capture the current response state for assertions. */
  responseSnapshot: () => { status: number; headers: Headers; body: string | null };
  /** The underlying service registry map (for assertions). */
  servicesMap: Map<string, unknown>;
}

/**
 * Create a fake IRequestContext matching the real kernel shapes.
 *
 * The response supports `status().json()` chaining and exposes a snapshot
 * for assertions. The `state` is a real `Map`. Query and params are real
 * Records.
 */
export function createFakeContext(opts: FakeContextOptions = {}): FakeContextResult {
  const { response, snapshot: responseSnapshot } = createFakeResponse();
  const servicesMap = opts.services ?? new Map();
  const ctx: IRequestContext = {
    id: 'test-request-id',
    request: createFakeRequest(opts.request),
    response,
    services: createFakeServiceRegistry(servicesMap),
    params: opts.params ?? {},
    query: opts.query ?? {},
    state: new Map(),
    startTime: 0,
  };

  return { ctx, responseSnapshot, servicesMap };
}
