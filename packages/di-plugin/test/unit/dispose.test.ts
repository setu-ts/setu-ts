import { expect, it, vi } from 'vitest';
import { createContainer, ScopeDisposedError } from '../../src/index.ts';

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
