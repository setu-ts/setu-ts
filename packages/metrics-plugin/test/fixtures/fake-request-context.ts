/**
 * Fake IRequestContext for testing middleware.
 *
 * @module
 */
import type { HttpMethod, IRequestContext } from '@hono-enterprise/common';

/**
 * A fake response builder for testing.
 */
export class FakeResponse {
  #status: number;
  #headers = new Map<string, string>();
  #body: string;

  constructor() {
    this.#status = 200;
    this.#body = '';
  }

  status(code: number): this {
    this.#status = code;
    return this;
  }

  header(name: string, value: string): this {
    this.#headers.set(name, value);
    return this;
  }

  text(body: string): this {
    this.#body = body;
    return this;
  }

  json(body: unknown): this {
    this.#body = JSON.stringify(body);
    this.#headers.set('Content-Type', 'application/json');
    return this;
  }

  html(body: string): this {
    this.#body = body;
    this.#headers.set('Content-Type', 'text/html');
    return this;
  }

  redirect(location: string, status = 302): this {
    this.#status = status;
    this.#headers.set('Location', location);
    return this;
  }

  snapshot(): {
    readonly status: number;
    readonly headers: Headers;
    readonly body: string | Uint8Array<ArrayBufferLike> | null;
  } {
    const headers = new Headers();
    for (const [k, v] of this.#headers.entries()) {
      headers.set(k, v);
    }
    return {
      status: this.#status,
      headers,
      body: this.#body || null,
    };
  }
}

/**
 * A fake request for testing.
 */
export class FakeRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: Headers;
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly params: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly url: string;
  readonly bytes: Uint8Array;

  constructor(options?: {
    method?: HttpMethod;
    path?: string;
    headers?: Record<string, string>;
    query?: Record<string, string | string[]>;
    params?: Record<string, string>;
    body?: unknown;
  }) {
    this.method = options?.method ?? 'GET' as HttpMethod;
    this.path = options?.path ?? '/';
    this.headers = new Headers(options?.headers);
    this.query = options?.query ?? {};
    this.params = options?.params ?? {};
    this.body = options?.body;
    this.url = this.path;
    this.bytes = new Uint8Array();
  }

  json<T = unknown>(): Promise<T> {
    return Promise.resolve(this.body as T);
  }

  text(): Promise<string> {
    return Promise.resolve(
      typeof this.body === 'string' ? this.body : JSON.stringify(this.body ?? ''),
    );
  }
}

/**
 * Creates a fake request context for testing.
 *
 * @param options - Optional configuration
 * @returns The fake request context
 */
export function createFakeContext(options?: {
  method?: HttpMethod;
  path?: string;
  status?: number;
}): IRequestContext {
  const request = new FakeRequest({
    method: options?.method ?? 'GET' as HttpMethod,
    path: options?.path ?? '/',
  });

  const response = new FakeResponse();
  if (options?.status) {
    response.status(options.status);
  }

  const startTime = Date.now();

  return {
    id: 'test-request-id',
    request: request as unknown as import('@hono-enterprise/common').IRequest,
    response: response as unknown as import('@hono-enterprise/common').IResponse,
    startTime,
    services: new Map() as unknown as import('@hono-enterprise/common').IServiceRegistry,
    params: {},
    query: {},
    state: new Map(),
    signal: new AbortController().signal,
  };
}
