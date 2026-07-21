/**
 * Fake {@linkcode IRequestContext} for http-security-plugin tests.
 *
 * Builds a recording context that captures response mutations (status,
 * headers, body) and supports configurable request properties (method,
 * headers, ip, url). Follows the sibling-plugin test-fixture convention.
 *
 * @module
 */
import type {
  HandlerResult,
  IRequest,
  IRequestContext,
  IResponse,
  IRuntimeServices,
  IServiceRegistry,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

const HANDLER_RESULT: HandlerResult = { __handlerResult: true };

/** Options for creating a fake request. */
export interface FakeRequestOptions {
  /** HTTP method. Defaults to `'GET'`. */
  method?: string;
  /** Full request URL. Defaults to `'http://localhost:3000/test'`. */
  url?: string;
  /** URL path. Defaults to `'/test'`. */
  path?: string;
  /** Initial headers as a record. */
  headers?: Record<string, string>;
  /** Client IP. */
  ip?: string;
  /** Body to return from `json()`. Defaults to `{}`. */
  body?: unknown;
}

/** Create a fake IRequest. */
function createFakeRequest(opts: FakeRequestOptions = {}): IRequest {
  const headers = new Headers(opts.headers ?? {});
  const method = opts.method ?? 'GET';
  const url = opts.url ?? 'http://localhost:3000/test';
  const path = opts.path ?? '/test';

  const request: IRequest = {
    method: method as IRequest['method'],
    url,
    path,
    headers,
    ...(opts.ip !== undefined && { ip: opts.ip }),
    json<T = unknown>(): Promise<T> {
      return Promise.resolve((opts.body ?? {}) as T);
    },
    text(): Promise<string> {
      return Promise.resolve(
        typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? ''),
      );
    },
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(new TextEncoder().encode(JSON.stringify(opts.body ?? '')));
    },
  };

  return request;
}

/** Result of {@linkcode createFakeResponse}. */
export interface FakeResponseResult {
  /** The fake response builder. */
  response: IResponse;
  /** The captured status codes. */
  statuses: number[];
  /** The captured headers (lowercase key → value). */
  headers: Map<string, string>;
  /** The captured appended headers (lowercase key → values array). */
  appendedHeaders: Map<string, string[]>;
  /** The captured JSON body (live getter). */
  get body(): unknown;
}

/** Create a fake IResponse that records mutations. */
export function createFakeResponse(): FakeResponseResult {
  const statuses: number[] = [];
  const headers: Map<string, string> = new Map();
  const appendedHeaders: Map<string, string[]> = new Map();
  let bodyValue: unknown = null;

  const response: IResponse = {
    status(code: number): IResponse {
      statuses.push(code);
      return response;
    },
    header(name: string, value: string): IResponse {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    appendHeader(name: string, value: string): IResponse {
      const existing = appendedHeaders.get(name.toLowerCase()) ?? [];
      existing.push(value);
      appendedHeaders.set(name.toLowerCase(), existing);
      return response;
    },
    json<T>(b: T): HandlerResult {
      bodyValue = b;
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
    stream(_body: ReadableStream<Uint8Array>): HandlerResult {
      return HANDLER_RESULT;
    },
    snapshot(): {
      readonly streaming: false;
      readonly status: number;
      readonly headers: Headers;
      readonly body: Uint8Array | string | null;
    } | {
      readonly streaming: true;
      readonly status: number;
      readonly headers: Headers;
      readonly body: ReadableStream<Uint8Array>;
    } {
      const h = new Headers();
      for (const [k, v] of headers) {
        h.set(k, v);
      }
      for (const [k, vals] of appendedHeaders) {
        for (const v of vals) {
          h.append(k, v);
        }
      }
      return {
        streaming: false,
        status: statuses.at(-1) ?? 200,
        headers: h,
        body: bodyValue as string | null,
      };
    },
  };

  return {
    response,
    statuses,
    headers,
    appendedHeaders,
    get body() {
      return bodyValue;
    },
  };
}

/** Options for creating a fake request context. */
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
  /** The response recording result. */
  response: FakeResponseResult;
  /** Whether next() was called. */
  nextCalled: boolean[];
  /** The underlying service registry map. */
  servicesMap: Map<string, unknown>;
}

/**
 * Create a fake IRequestContext for testing middleware.
 *
 * Records response mutations and captures whether `next()` was called.
 */
export function createFakeContext(opts: FakeContextOptions = {}): FakeContextResult {
  const responseResult = createFakeResponse();
  const { response } = responseResult;
  const servicesMap = opts.services ?? new Map();
  const nextCalled: boolean[] = [];

  // Register a basic runtime service by default
  if (!servicesMap.has(CAPABILITIES.RUNTIME)) {
    const runtime: IRuntimeServices = {
      platform: () => 'deno' as const,
      version: () => 'test',
      hostname: () => 'localhost',
      now: () => 0,
      hrtime: () => 0,
      setTimeout: () => ({ id: 0 }),
      clearTimeout: () => {},
      setInterval: () => ({ id: 0 }),
      clearInterval: () => {},
      uuid: () => 'test-uuid',
      randomBytes: (length: number) => new Uint8Array(length),
      subtle: globalThis.crypto?.subtle,
      env: {},
      exit: () => {
        throw new Error('exit called');
      },
    };
    servicesMap.set(CAPABILITIES.RUNTIME, runtime);
  }

  const serviceRegistry: IServiceRegistry = {
    register<T>(key: string, service: T): void {
      servicesMap.set(key, service);
    },
    registerFactory<T>(_key: string, _factory: () => T): void {},
    get<T>(key: string): T {
      const value = servicesMap.get(key);
      if (value === undefined) {
        throw new Error(`Service not found: ${key}`);
      }
      return value as T;
    },
    getAll<T>(): T[] {
      return [];
    },
    has(key: string): boolean {
      return servicesMap.has(key);
    },
    unregister(key: string): boolean {
      return servicesMap.delete(key);
    },
  };

  const ctx: IRequestContext = {
    id: 'test-request-id',
    request: createFakeRequest(opts.request),
    response,
    services: serviceRegistry,
    params: opts.params ?? {},
    query: opts.query ?? {},
    state: new Map(),
    startTime: 0,
    signal: new AbortController().signal,
  };

  return {
    ctx,
    response: responseResult,
    nextCalled,
    servicesMap,
  };
}
