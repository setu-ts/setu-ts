/**
 * Type-level and runtime smoke tests for contracts.ts.
 *
 * Assigns every public option shape to verify compile-time correctness.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ClientOptions,
  ClientRateLimitPolicy,
  ClientRequest,
  ClientRequestContext,
  ClientResponse,
  IClientTiming,
  IHttpClient,
} from '../../src/http/contracts.ts';

describe('http/contracts — compile-time type fixture', () => {
  it('ClientOptions is fully assignable', () => {
    const timing: IClientTiming = { now: () => 0, sleep: () => Promise.resolve() };
    const options: ClientOptions = {
      baseUrl: 'https://api.example.com',
      headers: { 'X-Custom': 'value' },
      timing,
      retry: { limit: 3, delay: 100, backoff: 'exponential' },
      circuitBreaker: { threshold: 5, timeout: 30_000, resetTimeout: 10_000 },
      rateLimit: { maxRequests: 10, windowMs: 60_000 },
    };
    expect(options.baseUrl).toEqual('https://api.example.com');
  });

  it('ClientRequest is assignable with json body', () => {
    const req: ClientRequest<{ name: string }> = {
      method: 'POST',
      path: 'users',
      json: { name: 'test' },
    };
    expect(req.method).toEqual('POST');
  });

  it('ClientResponse shape is correct', () => {
    const resp: ClientResponse<{ id: number }> = {
      status: 200,
      headers: new Headers(),
      data: { id: 1 },
    };
    expect(resp.status).toEqual(200);
  });

  it('ClientResponse allows undefined data for 204', () => {
    const resp: ClientResponse<undefined> = {
      status: 204,
      headers: new Headers(),
      data: undefined,
    };
    expect(resp.status).toEqual(204);
  });

  it('ClientRequestContext is mutable', () => {
    const ctx: ClientRequestContext = {
      url: new URL('https://example.com/path'),
      headers: new Headers(),
    };
    ctx.headers.set('X-Added', 'yes');
    expect(ctx.headers.get('X-Added')).toEqual('yes');
  });

  it('IClientTiming interface is implementable', () => {
    const fake: IClientTiming = {
      now: () => 123,
      sleep: () => Promise.resolve(),
    };
    expect(fake.now()).toEqual(123);
  });

  it('IHttpClient interface is implementable', () => {
    const fake: IHttpClient = {
      request: () =>
        Promise.resolve({
          status: 200,
          headers: new Headers(),
          data: undefined,
        }),
    };
    expect(typeof fake.request).toEqual('function');
  });

  it('ClientRateLimitPolicy is assignable', () => {
    const policy: ClientRateLimitPolicy = {
      maxRequests: 5,
      windowMs: 10_000,
    };
    expect(policy.maxRequests).toEqual(5);
  });
});
