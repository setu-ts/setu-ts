/**
 * Fake request context for SSE testing.
 *
 * Builds an {@linkcode IRequestContext} with a real response builder, a
 * controllable `AbortController.signal`, and settable headers — matching the
 * real kernel's shape.
 *
 * @module
 */
import type {
  HandlerResult,
  IRequestContext,
  IResponse,
  ResponseSnapshot,
} from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';

/** Internal state. */
interface FakeState {
  headers: Map<string, string>;
  streamBody: ReadableStream<Uint8Array> | null;
  status: number;
  result: HandlerResult;
}

/** Brand a HandlerResult. */
function brand(): HandlerResult {
  return { __handlerResult: true } as HandlerResult;
}

/**
 * Creates a fake request context.
 */
export function createFakeContext(opts?: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  runtime?: IRuntimeServices;
}): IRequestContext {
  const abortController = new AbortController();
  const signal = opts?.signal ?? abortController.signal;
  const state: FakeState = {
    headers: new Map(),
    streamBody: null,
    status: 200,
    result: brand(),
  };

  if (opts?.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      state.headers.set(k, v);
    }
  }

  const rt = opts?.runtime!;

  // Build response builder.
  const resp: IResponse = {
    header(name: string, value: string) {
      state.headers.set(name, value);
      return this;
    },
    appendHeader(name: string, value: string) {
      const existing = state.headers.get(name) ?? '';
      state.headers.set(name, existing ? `${existing}, ${value}` : value);
      return this;
    },
    status(code: number) {
      state.status = code;
      return this;
    },
    json(_data?: unknown): HandlerResult {
      return state.result;
    },
    text(_body?: string): HandlerResult {
      return state.result;
    },
    send(_body?: Uint8Array): HandlerResult {
      return state.result;
    },
    redirect(_url?: string, _status?: number): HandlerResult {
      return state.result;
    },
    stream(body: ReadableStream<Uint8Array>): HandlerResult {
      state.streamBody = body;
      return state.result;
    },
    snapshot(): ResponseSnapshot {
      if (state.streamBody) {
        return { streaming: true, body: state.streamBody as ReadableStream } as ResponseSnapshot;
      }
      return { streaming: false, body: null } as ResponseSnapshot;
    },
  };

  // Build request.
  const fakeRequest = {
    method: 'GET' as const,
    url: '/events',
    path: '/events',
    headers: new Proxy(Object.prototype, {
      get(_target, prop) {
        if (prop === 'get') {
          return (name: string) => state.headers.get(name) ?? null;
        }
        return undefined;
      },
    }) as Headers,
    signal: signal ?? undefined,
    json() {
      return Promise.resolve({} as never);
    },
    text() {
      return Promise.resolve('');
    },
    bytes() {
      return Promise.resolve(new Uint8Array());
    },
  };

  return {
    id: 'test-req',
    request: fakeRequest,
    response: resp,
    services: {
      register() {},
      get() {
        return undefined as never;
      },
      has() {
        return false;
      },
      getAll() {
        return [];
      },
    } as never,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
    signal: signal,
    runtime: rt,
  } as unknown as IRequestContext;
}
