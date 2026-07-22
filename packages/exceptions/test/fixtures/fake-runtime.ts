/**
 * Test fixtures for exceptions package tests.
 *
 * Provides faithful test doubles for `IRequestContext`, `IRequest`,
 * `IResponse`, and `IServiceRegistry` matching the real kernel shapes. Unlike
 * a minimal stub, the fake `IResponse` **captures** every header set via
 * `.header()` so assertions can verify `content-type` and other headers.
 */
import type {
  HandlerResult,
  HttpMethod,
  ILogger,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
  LogLevel,
  ResponseSnapshot,
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
  /** Initial headers as a record. */
  headers?: Record<string, string>;
}

/** Create a fake `IRequest`. */
export function createFakeRequest(opts: FakeRequestOptions = {}): IRequest {
  const headers = new Headers(opts.headers ?? {});
  const method: HttpMethod = opts.method ?? 'GET';
  const url = opts.url ?? 'http://localhost:3000/';
  const path = opts.path ?? '/';

  return {
    method,
    url,
    path,
    headers,
    json<T = unknown>(): Promise<T> {
      return Promise.resolve({} as T);
    },
    text(): Promise<string> {
      return Promise.resolve('');
    },
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array());
    },
  };
}

// ---------------------------------------------------------------------------
// Fake IResponse (captures all headers)
// ---------------------------------------------------------------------------

const HANDLER_RESULT: HandlerResult = { __handlerResult: true };

/** Result of {@linkcode createFakeResponse}. */
export interface FakeResponseResult {
  /** The fake response builder. */
  response: IResponse;
  /** Capture the current response state for assertions. */
  snapshot: () => { status: number; headers: Headers; body: Uint8Array | string | null };
}

/**
 * Create a fake `IResponse` that **captures** headers set via `.header()`,
 * mirroring the real `ResponseBuilder`.
 */
export function createFakeResponse(): FakeResponseResult {
  let status = 200;
  const headers = new Headers();
  let body: Uint8Array | string | null = null;

  const response: IResponse = {
    status(code: number): IResponse {
      status = code;
      return response;
    },
    header(name: string, value: string): IResponse {
      headers.set(name, value);
      return response;
    },
    appendHeader(name: string, value: string): IResponse {
      headers.append(name, value);
      return response;
    },
    json<T>(b: T): HandlerResult {
      body = JSON.stringify(b);
      headers.set('content-type', 'application/json; charset=utf-8');
      return HANDLER_RESULT;
    },
    text(b: string): HandlerResult {
      body = b;
      headers.set('content-type', 'text/plain; charset=utf-8');
      return HANDLER_RESULT;
    },
    send(b?: Uint8Array): HandlerResult {
      body = b ?? null;
      if (b !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/octet-stream');
      }
      return HANDLER_RESULT;
    },
    redirect(_url: string, _status?: number): HandlerResult {
      return HANDLER_RESULT;
    },
    stream(_body: ReadableStream<Uint8Array>): HandlerResult {
      return HANDLER_RESULT;
    },
    snapshot(): ResponseSnapshot {
      return { streaming: false, status, headers, body };
    },
  };

  return {
    response,
    snapshot: () => ({ streaming: false, status, headers, body }),
  };
}

// ---------------------------------------------------------------------------
// Fake IServiceRegistry (Map-backed)
// ---------------------------------------------------------------------------

/** Create a Map-backed fake `IServiceRegistry`. */
export function createFakeServiceRegistry(
  map: Map<string, unknown> = new Map(),
): IServiceRegistry {
  return {
    register<T>(key: string, service: T): void {
      map.set(key, service);
    },
    registerFactory<T>(_key: string, _factory: () => T): void {},
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
// Fake ILogger
// ---------------------------------------------------------------------------

/** A recording fake logger that captures all log calls. */
export class FakeLogger implements ILogger {
  readonly level: LogLevel = 'trace';
  readonly calls: Array<{ level: LogLevel; message: string; meta?: Record<string, unknown> }> = [];

  private record(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.calls.push({ level, message, ...(meta !== undefined && { meta }) });
  }

  fatal(message: string, meta?: Record<string, unknown>): void {
    this.record('fatal', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.record('error', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.record('warn', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.record('info', message, meta);
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    this.record('debug', message, meta);
  }
  trace(message: string, meta?: Record<string, unknown>): void {
    this.record('trace', message, meta);
  }
  child(_meta: Record<string, unknown>): ILogger {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Fake IRequestContext
// ---------------------------------------------------------------------------

/** Configuration for creating a fake request context. */
export interface FakeContextOptions {
  /** Request configuration. */
  request?: FakeRequestOptions;
  /** Pre-populated service registry entries. */
  services?: Map<string, unknown>;
}

/** Result of {@linkcode createFakeContext}. */
export interface FakeContextResult {
  /** The fake request context. */
  ctx: IRequestContext;
  /** Capture the current response state for assertions. */
  responseSnapshot: () => { status: number; headers: Headers; body: Uint8Array | string | null };
  /** The underlying service registry map. */
  servicesMap: Map<string, unknown>;
}

/** Create a fake `IRequestContext`. */
export function createFakeContext(opts: FakeContextOptions = {}): FakeContextResult {
  const { response, snapshot: responseSnapshot } = createFakeResponse();
  const servicesMap = opts.services ?? new Map();
  const ctx: IRequestContext = {
    id: 'test-request-id',
    request: createFakeRequest(opts.request),
    response,
    services: createFakeServiceRegistry(servicesMap),
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
    signal: new AbortController().signal,
  };

  return { ctx, responseSnapshot, servicesMap };
}
