/**
 * `getService`, `serviceResolverContext` and the bridge's resolver (M130 §3.2).
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IServiceRegistry } from '@setu-ts/common';
import { RequestServiceUnavailableError, requestService, serviceToken } from '@setu-ts/common';
import type { IRequestContext } from '../../src/interfaces/index.ts';
import { applyDefaultLoadContext } from '../../src/handler/load-context.ts';
import { contextKeyFor } from '../../src/handler/context-keys.ts';
import {
  getService,
  serviceResolverContext,
  ServiceResolverUnavailableError,
} from '../../src/handler/get-service.ts';
import type { ServiceResolver } from '../../src/handler/get-service.ts';
import { FakeRouterContextProvider } from '../fixtures/fake-handler.ts';

interface Greeter {
  greet(): string;
}
const GREETER = serviceToken<Greeter>('module.greeter');

function registry(entries: Record<string, object>): IServiceRegistry {
  return {
    register: () => {},
    registerFactory: () => {},
    get: <T extends object>(token: string) => entries[token] as T,
    getAll: () => [],
    has: (token) => token in entries,
    unregister: () => false,
  };
}

function buildCtx(services: IServiceRegistry): IRequestContext {
  const slots = new Map<object, unknown>();
  return {
    id: 'req-1',
    request: { method: 'GET', path: '/', headers: new Headers(), user: undefined },
    response: { marker: 'response' },
    services,
    params: {},
    query: {},
    state: new Map([['secret', 'state']]),
    startTime: 0,
    signal: new AbortController().signal,
    slot<T>(key: object, create: () => T): T {
      if (!slots.has(key)) slots.set(key, create());
      return slots.get(key) as T;
    },
  } as unknown as IRequestContext;
}

describe('getService', () => {
  it('calls the resolver the context carries', () => {
    const context = new FakeRouterContextProvider();
    const greeter: Greeter = { greet: () => 'hi' };
    const resolver: ServiceResolver = <T>(token: string) => {
      expect(token).toBe('module.greeter');
      return greeter as T;
    };
    context.set(serviceResolverContext, resolver);
    expect(getService(context, GREETER).greet()).toBe('hi');
  });

  it('throws ServiceResolverUnavailableError when no resolver is set', () => {
    const context = new FakeRouterContextProvider();
    let caught: unknown;
    try {
      getService(context, GREETER);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceResolverUnavailableError);
    expect((caught as Error).name).toBe('ServiceResolverUnavailableError');
    expect((caught as Error).message).toContain('ReactRouterPlugin');
    expect((caught as Error).message).toContain('serviceResolverContext');
  });

  it('keeps its key identity through contextKeyFor (survives a bundled copy)', () => {
    expect(contextKeyFor('setu.react-router.service-resolver', 'other')).toBe(
      serviceResolverContext,
    );
    expect(serviceResolverContext.defaultValue).toBe(null);
  });
});

describe('applyDefaultLoadContext resolver', () => {
  it('sets a resolver bound to the request, sharing one instance per request', () => {
    let built = 0;
    const services = registry({
      [GREETER]: requestService<Greeter>(() => {
        built += 1;
        return { greet: () => `hi ${built}` };
      }),
    });
    const context = new FakeRouterContextProvider();
    applyDefaultLoadContext(buildCtx(services), context);
    const a = getService(context, GREETER);
    const b = getService(context, GREETER);
    expect(a).toBe(b);
    expect(built).toBe(1);
  });

  it('surfaces a missing token as RequestServiceUnavailableError', () => {
    const context = new FakeRouterContextProvider();
    applyDefaultLoadContext(buildCtx(registry({})), context);
    expect(() => getService(context, GREETER)).toThrow(RequestServiceUnavailableError);
  });

  it('exposes no IRequestContext through any value it sets (T2)', () => {
    const ctx = buildCtx(registry({}));
    const stored: unknown[] = [];
    const recording = {
      get: () => null,
      set: (_key: unknown, value: unknown) => {
        stored.push(value);
      },
    };
    applyDefaultLoadContext(ctx, recording as never);

    // Walk every value reachable from what was stored (own properties only;
    // a closure's captured scope is not reachable from page code).
    const seen = new Set<unknown>();
    const queue = [...stored];
    while (queue.length > 0) {
      const value = queue.shift();
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      expect(value).not.toBe(ctx);
      expect(value).not.toBe(ctx.response);
      expect(value).not.toBe(ctx.state);
      for (const key of Reflect.ownKeys(value as object)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && 'value' in descriptor) queue.push(descriptor.value);
      }
    }
    // The resolver is a function whose own properties reveal nothing.
    const resolver = stored.find((v) => typeof v === 'function');
    expect(resolver).toBeTypeOf('function');
  });
});
