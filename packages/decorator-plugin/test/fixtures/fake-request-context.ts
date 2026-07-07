/**
 * Fake {@linkcode IRequestContext} for parameter-resolver tests — deterministic
 * body, query, params, headers, cookies, and authenticated user.
 *
 * @module
 */
import type {
  HandlerResult,
  IPrincipal,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@hono-enterprise/common';

/** Options for {@linkcode createFakeRequestContext}. */
export interface FakeRequestOptions {
  /** Parsed JSON body (stringified for `json()`/`text()`/`bytes()`). */
  readonly body?: unknown;
  /** Query parameters. */
  readonly query?: Record<string, string>;
  /** Path parameters. */
  readonly params?: Record<string, string>;
  /** Request headers. */
  readonly headers?: Record<string, string>;
  /** Cookies (emitted as a `Cookie` header). */
  readonly cookies?: Record<string, string>;
  /** Authenticated principal. */
  readonly user?: IPrincipal;
  /** HTTP method. */
  readonly method?: string;
  /** Request URL. */
  readonly url?: string;
}

/** Builds a minimal fake response that records the terminal body. */
function createFakeResponse(): IResponse {
  const r: IResponse = {
    status: () => r,
    header: () => r,
    appendHeader: () => r,
    json: () => ({ __handlerResult: true }) as unknown as HandlerResult,
    text: () => ({ __handlerResult: true }) as unknown as HandlerResult,
    send: () => ({ __handlerResult: true }) as unknown as HandlerResult,
    redirect: () => ({ __handlerResult: true }) as unknown as HandlerResult,
  };
  return r;
}

/** A no-op service registry (the resolver does not resolve services). */
function noopRegistry(): IServiceRegistry {
  return {
    register() {},
    registerFactory() {},
    get() {
      throw new Error('service resolution not available in fake request context');
    },
    getAll() {
      return [];
    },
    has() {
      return false;
    },
    unregister() {
      return false;
    },
  };
}

/**
 * Creates a fake request context for parameter-resolution tests.
 *
 * @param options - Body, query, params, headers, cookies, user
 * @returns A deterministic `IRequestContext`
 */
export function createFakeRequestContext(options: FakeRequestOptions = {}): IRequestContext {
  const encoder = new TextEncoder();
  const bodyJson = options.body !== undefined ? JSON.stringify(options.body) : '';
  const headers = new Headers();
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    headers.set(k, v);
  }
  if (options.cookies !== undefined) {
    headers.set(
      'cookie',
      Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
    );
  }
  const url = options.url ?? 'http://localhost/test';
  const request: IRequest = {
    method: (options.method ?? 'GET') as IRequest['method'],
    url,
    path: new URL(url).pathname,
    headers,
    ...(options.user !== undefined ? { user: options.user } : {}),
    json<T>(): Promise<T> {
      return Promise.resolve(JSON.parse(bodyJson === '' ? 'null' : bodyJson) as T);
    },
    text(): Promise<string> {
      return Promise.resolve(bodyJson);
    },
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(encoder.encode(bodyJson));
    },
  };
  const ctx: IRequestContext = {
    id: 'test-request-id',
    request,
    response: createFakeResponse(),
    services: noopRegistry(),
    params: options.params ?? {},
    query: options.query ?? {},
    state: new Map(),
    startTime: 0,
  };
  return ctx;
}
