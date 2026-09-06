/**
 * Shared context fixture for the rate-limit middleware tests.
 *
 * Extracted from `rate-limit-middleware.test.ts` when M90a added
 * `rate-limit-exclude.test.ts`: both files need the same recording
 * `IRequestContext`, and a second copy would be the duplication §11.1 forbids
 * — and the copy that drifted would be the one whose assertions stopped
 * meaning what they say.
 *
 * @module
 */

import { CAPABILITIES } from '@setu-ts/common';
import type {
  HandlerResult,
  IPrincipal,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@setu-ts/common';
import type { createFakeRuntime } from './fake-runtime.ts';

export interface CapturedResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export function createContext(
  runtime: ReturnType<typeof createFakeRuntime>,
  options?: { ip?: string; user?: IPrincipal; path?: string },
): { ctx: IRequestContext; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 200, headers: new Headers(), body: null };

  const path = options?.path ?? '/';
  const request: IRequest & { user?: IPrincipal } = {
    method: 'GET',
    url: `http://localhost${path}`,
    path,
    headers: new Headers(),
    ...(options?.ip !== undefined ? { ip: options.ip } : {}),
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
  if (options?.user !== undefined) {
    request.user = options.user;
  }

  const response: IResponse = {
    status: (code: number) => {
      captured.status = code;
      return response;
    },
    header: (name: string, value: string) => {
      captured.headers.set(name, value);
      return response;
    },
    appendHeader: () => response,
    json: (body: unknown): HandlerResult => {
      captured.body = body;
      return { __handlerResult: true } as unknown as HandlerResult;
    },
    text: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    html: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    send: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    redirect: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    stream: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    snapshot: () => ({
      streaming: false,
      status: captured.status,
      headers: captured.headers,
      body: null,
    }),
  };

  const services = {
    get: <T>(token: string): T => {
      if (token === CAPABILITIES.RUNTIME) {
        return runtime as T;
      }
      throw new Error(`unexpected token: ${token}`);
    },
    has: () => true,
    register: () => {},
  } as unknown as IServiceRegistry;

  const _abortCtrl = new AbortController();
  const ctx: IRequestContext = {
    id: 'test',
    request,
    response,
    services,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
    signal: _abortCtrl.signal,
  };

  return { ctx, captured };
}
