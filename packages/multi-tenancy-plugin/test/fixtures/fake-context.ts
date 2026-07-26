/**
 * Fake IRequestContext for testing.
 */
import type { IMultiTenancyService, IRequestContext, IResponse } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ITenant } from '@hono-enterprise/common';
import { createFakeRequest } from './fake-request.ts';

export interface FakeContextOptions {
  tenant?: ITenant;
  services?: Map<string, unknown>;
  startTime?: number;
}

export function createFakeContext(
  opts?: FakeContextOptions,
): IRequestContext {
  const request = createFakeRequest(opts?.tenant ? { tenant: opts.tenant } : undefined);
  const state = new Map<string, unknown>();

  const services = opts?.services ?? new Map<string, unknown>();
  if (!services.has(CAPABILITIES.MULTI_TENANCY)) {
    // Default service stub. Its `prefixCacheKey` mirrors the COMMITTED
    // two-argument contract — a stub carrying an extra parameter would encode a
    // surface `IMultiTenancyService` does not have.
    services.set(CAPABILITIES.MULTI_TENANCY, {
      getCurrentTenant: () => opts?.tenant,
      getRepository: () => null as unknown,
      prefixCacheKey: (tid: string, key: string) => `${tid}:${key}`,
    } as unknown as IMultiTenancyService);
  }

  return {
    id: 'test-request-id',
    request,
    response: {
      status: (code: number) => ({
        header: (_name: string, _value: string) => ({
          json: () => null as never,
          text: () => null as never,
          send: () => null as never,
          redirect: () => null as never,
          stream: () => null as never,
          snapshot: () => ({ streaming: false, status: code, headers: new Headers(), body: null }),
        }),
        json: () => null as never,
      }),
      header: () => ({
        status: () => ({
          json: () => null as never,
        }),
      }),
      appendHeader: () => ({
        status: () => ({
          json: () => null as never,
        }),
      }),
      json: () => null as never,
      text: () => null as never,
      send: () => null as never,
      redirect: () => null as never,
      stream: () => null as never,
      snapshot: () => ({
        streaming: false,
        status: 200,
        headers: new Headers(),
        body: null,
      }),
    } as unknown as IResponse,
    services: {
      has: (token: string) => services.has(token),
      get: <T>(token: string): T => services.get(token) as T,
      register: (
        _token: string,
        _svc: unknown,
        _opts?: { override?: boolean; multi?: boolean },
      ) => {
        if (!_opts?.override && services.has(_token)) {
          throw new Error(`Service ${_token} already registered`);
        }
        services.set(_token, _svc);
      },
    } as unknown as typeof services,
    params: {},
    query: {},
    state,
    startTime: opts?.startTime ?? performance.now(),
    signal: new AbortController().signal,
  } as unknown as IRequestContext;
}
