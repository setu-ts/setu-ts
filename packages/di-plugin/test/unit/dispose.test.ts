import { expect, it, vi } from 'vitest';
import { createToken } from '@setu-ts/common';
import type { IRequestContext, ProbeTiming } from '@setu-ts/common';
import {
  CircularDetector,
  createContainer,
  DiContainer,
  ProviderRegistry,
  ScopeDisposedError,
  ScopeRequiredError,
} from '../../src/index.ts';

it.each([
  ['ambient', 'resolve'],
  ['ambient', 'reject'],
  ['injected', 'resolve'],
  ['injected', 'reject'],
] as const)('bounds each disposal with %s timers and ignores a late %s', async (timers, late) => {
  vi.useFakeTimers();
  let expire: (() => void) | undefined;
  const timing: ProbeTiming = {
    hrtime: () => 0,
    setTimer: vi.fn((fn, ms) => {
      expect(ms).toBe(5000);
      expire = fn;
      return 7;
    }),
    clearTimer: vi.fn(),
  };
  let release = (): void => {};
  const hung = new Promise<void>((resolve, reject) => {
    release = () => (late === 'resolve' ? resolve() : reject(new Error('late failure')));
  });
  const root = new DiContainer({
    defaultScope: 'scoped',
    autoRegister: false,
    ...(timers === 'injected' ? { timing } : {}),
  });
  const order: string[] = [];
  const token = createToken<object>('hung-service');
  root.register('first', { useValue: {} }, { dispose: () => void order.push('first') });
  root.register(token, { useValue: {} }, { dispose: () => hung });
  root.register('last', { useValue: {} }, { dispose: () => void order.push('last') });
  const scope = root.createScope();
  for (const key of ['first', token, 'last']) scope.resolve(key);
  let outcome: unknown;
  const done = Promise.resolve(scope.dispose()).then(
    () => {
      outcome = 'unexpected success';
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  try {
    expect(order).toEqual(['last']);
    await vi.advanceTimersByTimeAsync(4999);
    expect(outcome).toBeUndefined();
    expect(order).toEqual(['last']);
    if (timers === 'injected') expire?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(AggregateError);
    await done;
    expect((outcome as AggregateError).errors).toEqual([
      new Error('DI disposal of hung-service timed out after 5000 ms'),
    ]);
    expect(order).toEqual(['last', 'first']);
    expect(scope.dispose()).toBeUndefined();
    if (timers === 'injected') {
      expect(timing.setTimer).toHaveBeenCalledOnce();
      expect(timing.clearTimer).toHaveBeenCalledExactlyOnceWith(7);
    }
    // Synchronous disposal remains synchronous and never arms a deadline.
    const sync = root.createScope();
    sync.resolve('first');
    expect(sync.dispose()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    if (timers === 'injected') expect(timing.setTimer).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((outcome as AggregateError).errors).toHaveLength(1);
    expect(order).toEqual(['last', 'first', 'first']);
  } finally {
    release();
    await done;
    vi.useRealTimers();
  }
});

it.each([
  ['request', 'default'],
  ['request', 'explicit'],
  ['manual', 'default'],
  ['manual', 'explicit'],
] as const)('owns 1000 %s scope leaves with %s singleton lifetime', (kind, lifetime) => {
  const root = createContainer();
  const rootTrack = vi.spyOn(root, 'track');
  const dispose = vi.fn();
  const create = vi.fn(() => ({}));
  for (let n = 0; n < 1000; n++) {
    const cleanups: (() => void | Promise<void>)[] = [];
    const ctx = {
      defer: (cleanup: () => void | Promise<void>) => void cleanups.push(cleanup),
    } as IRequestContext;
    const scope = kind === 'request' ? root.forRequest(ctx) : root.createScope();
    scope.register(
      'leaf',
      { useFactory: create },
      {
        dispose,
        ...(lifetime === 'explicit' ? { scope: 'singleton' as const } : {}),
      },
    );
    expect(scope.resolve('leaf')).toBe(scope.resolve('leaf'));
    expect(root.has('leaf')).toBe(false);
    if (kind === 'request') {
      expect(cleanups).toHaveLength(1);
      expect(cleanups[0]!()).toBeUndefined();
    } else expect(scope.dispose()).toBeUndefined();
  }
  expect(create).toHaveBeenCalledTimes(1000);
  expect(dispose).toHaveBeenCalledTimes(1000);
  expect(rootTrack).not.toHaveBeenCalled();
  expect(root.dispose()).toBeUndefined();
  expect(dispose).toHaveBeenCalledTimes(1000);
});

it.each(['on-demand', 'closed'] as const)(
  'refuses root disposable transient graphs with %s compilation and disposes request scopes only',
  (mode) => {
    const c = createContainer();
    const token = createToken<object>('disposable');
    const create = vi.fn(() => ({}));
    const dispose = vi.fn();
    const rootTrack = vi.spyOn(c, 'track');
    c.register(token, { useFactory: create }, { scope: 'transient', dispose });
    c.register(
      'middle',
      { useFactory: (value: object) => value, inject: [token] },
      { scope: 'transient' },
    );
    c.register(
      'outer',
      { useFactory: (value: object) => value, inject: ['middle'] },
      { scope: 'transient' },
    );
    c.register(
      'optional',
      {
        useFactory: (value: object) => value,
        inject: [{ token, optional: true }],
      },
      { scope: 'transient' },
    );
    const singletonCreate = vi.fn((value: object) => ({ value }));
    c.register('singleton', { useFactory: singletonCreate, inject: ['middle'] });
    c.register(
      'via-singleton',
      {
        useFactory: (value: object) => value,
        inject: ['singleton', { token: 'absent', optional: true }],
      },
      { scope: 'transient' },
    );
    c.register('plain', { useFactory: () => ({}) }, { scope: 'transient' });
    if (mode === 'closed') c.close();
    for (const refused of [token, 'middle', 'outer', 'optional']) {
      expect(() => c.resolve(refused)).toThrow(ScopeRequiredError);
    }
    expect(create).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(c.resolve('plain')).not.toBe(c.resolve('plain'));

    const singleton = c.resolve<{ value: object }>('singleton');
    expect(c.resolve('via-singleton')).toBe(singleton);
    expect(c.resolve('singleton')).toBe(singleton);
    expect(singletonCreate).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(rootTrack).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    // A cached singleton must not allow direct root transient resolution later.
    expect(() => c.resolve(token)).toThrow(ScopeRequiredError);

    c.close();
    const lookup = vi.spyOn(ProviderRegistry.prototype, 'get').mockImplementation(() => {
      throw new Error('runtime graph lookup');
    });
    const enter = vi.spyOn(CircularDetector.prototype, 'enter').mockImplementation(() => {
      throw new Error('runtime graph traversal');
    });
    const instances = new Set<object>();
    try {
      for (let n = 0; n < 1000; n++) {
        const cleanups: (() => void | Promise<void>)[] = [];
        const ctx = {
          defer: (cleanup: () => void | Promise<void>) => {
            cleanups.push(cleanup);
          },
        } as IRequestContext;
        const scope = c.forRequest(ctx);
        const direct = scope.resolve(token);
        const indirect = scope.resolve<object>('outer');
        const optional = scope.resolve<object>('optional');
        instances.add(direct);
        instances.add(indirect);
        instances.add(optional);
        expect(scope.resolve('singleton')).toBe(singleton);
        expect(cleanups).toHaveLength(1);
        expect(cleanups[0]!()).toBeUndefined();
        expect(scope.dispose()).toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes((n + 1) * 3);
        expect(() => c.resolve('outer')).toThrow(ScopeRequiredError);
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(enter).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      enter.mockRestore();
    }
    expect(instances.size).toBe(3000);
    expect(rootTrack).toHaveBeenCalledOnce();
    expect(dispose.mock.calls.some(([value]) => value === singleton.value)).toBe(false);
    // Only the singleton's once-created transient remains owned by the root.
    expect(c.dispose()).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(3001);
    expect(dispose).toHaveBeenLastCalledWith(singleton.value);
    expect(c.dispose()).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(3001);
  },
);

it('disposes scoped and transient dependencies in reverse creation order exactly once', () => {
  const order: string[] = [];
  const c = createContainer();
  c.register(
    'transient',
    { useFactory: () => ({}) },
    {
      scope: 'transient',
      dispose: () => {
        order.push('transient');
      },
    },
  );
  c.register(
    'scoped',
    { useFactory: () => ({}), inject: ['transient'] },
    {
      scope: 'scoped',
      dispose: () => {
        order.push('scoped');
      },
    },
  );
  const scope = c.createScope();
  scope.resolve('scoped');
  scope.resolve('scoped');
  expect(scope.dispose()).toBeUndefined();
  expect(scope.dispose()).toBeUndefined();
  expect(order).toEqual(['scoped', 'transient']);
  expect(() => scope.resolve('scoped')).toThrow(ScopeDisposedError);
});

it('owns singletons and their transients on the root even when first built in a scope', () => {
  const dispose = vi.fn();
  const c = createContainer();
  c.register('dep', { useValue: {} }, { scope: 'transient', dispose });
  c.register('singleton', { useFactory: () => ({}), inject: ['dep'] }, { dispose });
  const scope = c.createScope();
  scope.resolve('singleton');
  scope.dispose();
  expect(dispose).not.toHaveBeenCalled();
  c.dispose();
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(() => c.resolve('singleton')).toThrow(ScopeDisposedError);
});

it('runs all synchronous disposals before throwing an aggregate', () => {
  const order: number[] = [];
  const c = createContainer();
  for (const n of [1, 2, 3]) {
    c.register(
      String(n),
      { useValue: n },
      {
        dispose: () => {
          order.push(n);
          throw new Error(String(n));
        },
      },
    );
    c.resolve(String(n));
  }
  try {
    c.dispose();
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(3);
  }
  expect(order).toEqual([3, 2, 1]);
  expect(c.dispose()).toBeUndefined();
});

it('awaits asynchronous cleanup and continues after rejection and throw', async () => {
  const order: number[] = [];
  const c = createContainer();
  c.register(
    'a',
    { useValue: 1 },
    {
      dispose: () => {
        order.push(1);
        throw new Error('sync');
      },
    },
  );
  c.register(
    'b',
    { useValue: 2 },
    {
      dispose: async () => {
        await Promise.resolve();
        order.push(2);
        throw new Error('async');
      },
    },
  );
  c.register(
    'c',
    { useValue: 3 },
    {
      dispose: async () => {
        await Promise.resolve();
        order.push(3);
      },
    },
  );
  for (const token of ['a', 'b', 'c']) c.resolve(token);
  await expect(c.dispose()).rejects.toMatchObject({
    errors: [new Error('async'), new Error('sync')],
  });
  expect(order).toEqual([3, 2, 1]);
});
