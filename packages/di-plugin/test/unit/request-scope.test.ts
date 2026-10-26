import { expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  createContainer,
  DiContainer,
  DiPlugin,
  RequestScopeUnavailableError,
  ScopeDisposedError,
} from '../../src/index.ts';

function slotContext() {
  const entries = new Map<object, unknown>();
  const keys: object[] = [];
  const cleanups: (() => void | Promise<void>)[] = [];
  const ctx = {
    slot<T>(key: object, create: () => T): T {
      keys.push(key);
      if (!entries.has(key)) entries.set(key, create());
      return entries.get(key) as T;
    },
    defer(cleanup: () => void | Promise<void>): void {
      cleanups.push(cleanup);
    },
  } as IRequestContext & { slot<T>(key: object, create: () => T): T };
  return { ctx, entries, keys, cleanups };
}

it('M125 request slot: stores the scope under a private distinct key per container owner', () => {
  const root = createContainer();
  const owner = root.createScope();
  const request = slotContext();
  const first = root.forRequest(request.ctx);
  const second = owner.forRequest(request.ctx);
  expect(root.forRequest(request.ctx)).toBe(first);
  expect(owner.forRequest(request.ctx)).toBe(second);
  expect(request.keys).toHaveLength(4);
  expect(request.keys[0]).not.toBe(root);
  expect(request.keys[1]).not.toBe(owner);
  expect(request.keys[0]).not.toBe(request.keys[1]);
  expect(request.entries.get(request.keys[0]!)).toBe(first);
  expect(request.entries.get(request.keys[1]!)).toBe(second);
  expect(request.cleanups).toHaveLength(2);
  expect(() => root.forRequest({ slot: request.ctx.slot } as IRequestContext)).toThrow(
    RequestScopeUnavailableError,
  );
  for (const cleanup of request.cleanups) cleanup();
  expect(root.forRequest(request.ctx)).toBe(first);
  expect(() => first.resolve('anything')).toThrow(ScopeDisposedError);
});

it('M125 request slot: allocates WeakMaps only for fallback or provider registration', () => {
  let allocated = 0;
  class CountedWeakMap extends WeakMap<object, unknown> {
    constructor() {
      super();
      allocated++;
    }
  }
  vi.stubGlobal('WeakMap', CountedWeakMap);
  try {
    const root = createContainer();
    const request = slotContext();
    const scope = root.forRequest(request.ctx);
    expect(allocated).toBe(0);
    scope.register('local', { useValue: {} });
    expect(allocated).toBe(1);
    let deferred = 0;
    const fallback = {
      defer: () => {
        deferred++;
      },
    } as unknown as IRequestContext;
    const first = root.forRequest(fallback);
    expect(root.forRequest(fallback)).toBe(first);
    expect(allocated).toBe(2);
    root.forRequest({ defer: fallback.defer } as IRequestContext);
    expect(allocated).toBe(2);
    expect(deferred).toBe(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('M125 obligation 11: middleware cannot plant or read the request scope with accessible keys', async () => {
  const fakeScope = { resolve: vi.fn(() => 'fake'), dispose: vi.fn() };
  const ownKey = {};
  const ownValue = {};
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      {
        name: 'slot-planting-probe',
        version: '1.0.0',
        dependencies: [CAPABILITIES.DI_CONTAINER],
        register(ctx) {
          const container = ctx.container!;
          container.register('real', { useFactory: () => ({}) }, { scope: 'scoped' });
          const otherScope = container.createScope();
          ctx.middleware.add((request, next) => {
            const slot = Reflect.get(request, 'slot') as IRequestContext['slot'] | undefined;
            if (slot === undefined) throw new Error('request slot unavailable');
            for (const key of [
              container,
              otherScope,
              ctx.services,
              request.services,
              request,
              {},
              Object.create(null) as object,
            ]) {
              expect(slot.call(request, key, () => fakeScope)).toBe(fakeScope);
            }
            expect(slot.call(request, ownKey, () => ownValue)).toBe(ownValue);
            expect(slot.call(request, ownKey, () => fakeScope)).toBe(ownValue);
            return next();
          });
          ctx.router.get('/scope', (request) => {
            const scope = container.forRequest(request);
            expect(scope).not.toBe(fakeScope);
            expect(request.slot!(scope, () => fakeScope)).toBe(fakeScope);
            expect(container.forRequest(request)).toBe(scope);
            expect(scope.resolve('real')).not.toBe('fake');
            return request.response.text('real scope');
          });
        },
      },
    ],
  });
  await app.start();
  try {
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: 'GET', url: '/scope' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('real scope');
    }
    expect(fakeScope.resolve).not.toHaveBeenCalled();
    expect(fakeScope.dispose).not.toHaveBeenCalled();
  } finally {
    await app.stop();
  }
});

it('M125 obligation 12: 10000 request-local registrations do not grow shared root slots or tracking', () => {
  const root = createContainer();
  root.register('root', { useFactory: () => ({}) }, { scope: 'scoped' });
  root.close();
  const tracked = vi.spyOn(root, 'track');
  let disposed = 0;
  for (let i = 0; i < 10000; i++) {
    let cleanup!: () => void | Promise<void>;
    const scope = root.forRequest({
      defer: (fn) => {
        cleanup = fn;
      },
    } as IRequestContext);
    scope.register(
      'local',
      { useFactory: () => ({ id: i }) },
      {
        scope: 'scoped',
        dispose: (value) => {
          expect(value.id).toBe(i);
          disposed++;
        },
      },
    );
    const value = scope.resolve<{ id: number }>('local');
    expect(value.id).toBe(i);
    expect(scope.resolve('local')).toBe(value);
    cleanup();
  }
  expect(disposed).toBe(10000);
  expect(tracked).not.toHaveBeenCalled();
  const fresh = root.createScope() as DiContainer;
  fresh.register('fresh', { useValue: {} }, { scope: 'scoped' });
  fresh.resolve('root');
  fresh.resolve('fresh');
  expect(fresh.slots!.length).toBeLessThanOrEqual(1);
  fresh.dispose();
  root.dispose();
  expect(tracked).not.toHaveBeenCalled();
});

it('caches one scope per context and registers its disposal exactly once', () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  const defer = vi.fn((cleanup: () => void | Promise<void>) => {
    cleanups.push(cleanup);
  });
  const ctx = { defer } as unknown as IRequestContext;
  const c = createContainer();
  c.register('svc', { useValue: {} }, { scope: 'scoped' });
  const scope = c.forRequest(ctx);
  expect(c.forRequest(ctx)).toBe(scope);
  expect(c.forRequest({ defer } as unknown as IRequestContext)).not.toBe(scope);
  expect(defer).toHaveBeenCalledTimes(2);
  cleanups[0]?.();
  expect(() => scope.resolve('svc')).toThrow(ScopeDisposedError);
});

it('reports synchronous disposal failure once, inherits the reporter, and otherwise rethrows', () => {
  const failure = new Error('sync dispose');
  const reportDisposeError = vi.fn();
  for (const configured of [false, true]) {
    const root = new DiContainer({
      defaultScope: 'scoped',
      autoRegister: false,
      ...(configured ? { reportDisposeError } : {}),
    });
    root.register(
      'failed',
      { useValue: {} },
      {
        dispose: () => {
          throw failure;
        },
      },
    );
    const cleanups: (() => void | Promise<void>)[] = [];
    const ctx = {
      defer: (fn: () => void | Promise<void>) => {
        cleanups.push(fn);
      },
    } as IRequestContext;
    const owner = root.createScope();
    const scope = owner.forRequest(ctx);
    scope.resolve('failed');
    if (configured) {
      expect(cleanups[0]!()).toBeUndefined();
      expect(reportDisposeError).toHaveBeenCalledExactlyOnceWith(
        new AggregateError([failure], 'DI disposal failed'),
      );
    } else {
      expect(cleanups[0]).toThrow(AggregateError);
      expect(reportDisposeError).not.toHaveBeenCalled();
    }
    expect(cleanups[0]!()).toBeUndefined();
    // Successful disposal must stay synchronous even with a reporter installed.
    const success = vi.fn();
    owner.register('success', { useValue: {} }, { dispose: success });
    owner.forRequest({ defer: ctx.defer } as IRequestContext).resolve('success');
    expect(cleanups[1]!()).toBeUndefined();
    expect(success).toHaveBeenCalledOnce();
    expect(reportDisposeError).toHaveBeenCalledTimes(configured ? 1 : 0);
  }
});

it('reports an asynchronous rejection once and resolves cleanup, but rejects without a reporter', async () => {
  const failure = new Error('async dispose');
  for (const configured of [false, true]) {
    const reportDisposeError = vi.fn();
    const root = new DiContainer({
      defaultScope: 'scoped',
      autoRegister: false,
      ...(configured ? { reportDisposeError } : {}),
    });
    root.register('failed', { useValue: {} }, { dispose: () => Promise.reject(failure) });
    root.register('success', { useValue: {} }, { dispose: () => Promise.resolve() });
    const cleanups: (() => void | Promise<void>)[] = [];
    const defer = (fn: () => void | Promise<void>): void => {
      cleanups.push(fn);
    };
    root.forRequest({ defer } as IRequestContext).resolve('success');
    await expect(cleanups[0]!()).resolves.toBeUndefined();
    expect(reportDisposeError).not.toHaveBeenCalled();
    root.forRequest({ defer } as IRequestContext).resolve('failed');
    const pending = cleanups[1]!();
    expect(pending).toBeInstanceOf(Promise);
    if (configured) {
      await expect(pending).resolves.toBeUndefined();
      expect(reportDisposeError).toHaveBeenCalledExactlyOnceWith(
        new AggregateError([failure], 'DI disposal failed'),
      );
    } else {
      await expect(pending).rejects.toMatchObject({ errors: [failure] });
      expect(reportDisposeError).not.toHaveBeenCalled();
    }
  }
});

it('reports named failures after two disposal deadlines exceed the kernel cleanup bound', async () => {
  vi.useFakeTimers();
  try {
    const reportDisposeError = vi.fn();
    const root = new DiContainer({
      defaultScope: 'scoped',
      autoRegister: false,
      reportDisposeError,
    });
    const released = vi.fn();
    root.register('sibling', { useValue: {} }, { dispose: released });
    for (const token of ['hung1', 'hung2']) {
      root.register(token, { useValue: {} }, { dispose: () => new Promise<void>(() => {}) });
    }
    const cleanups: (() => void | Promise<void>)[] = [];
    const scope = root.forRequest({
      defer: (fn) => {
        cleanups.push(fn);
      },
    } as IRequestContext);
    for (const token of ['sibling', 'hung1', 'hung2']) scope.resolve(token);
    const fulfilled = vi.fn();
    const rejected = vi.fn();
    const pending = Promise.resolve(cleanups[0]!()).then(fulfilled, rejected);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reportDisposeError).not.toHaveBeenCalled();
    expect(fulfilled).not.toHaveBeenCalled();
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(reportDisposeError).toHaveBeenCalledExactlyOnceWith(
      new AggregateError(
        [
          new Error('DI disposal of hung2 timed out after 5000 ms'),
          new Error('DI disposal of hung1 timed out after 5000 ms'),
        ],
        'DI disposal failed',
      ),
    );
    expect(fulfilled).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('refuses a context without cleanup with an actionable createTestApp error', () => {
  const c = createContainer();
  expect(() => c.forRequest({} as IRequestContext)).toThrow(RequestScopeUnavailableError);
  expect(() => c.forRequest({} as IRequestContext)).toThrow(/createTestApp/);
});
