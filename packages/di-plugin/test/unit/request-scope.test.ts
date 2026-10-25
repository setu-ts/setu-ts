import { expect, it, vi } from 'vitest';
import type { IRequestContext } from '@setu-ts/common';
import {
  createContainer,
  DiContainer,
  RequestScopeUnavailableError,
  ScopeDisposedError,
} from '../../src/index.ts';

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
