import { expect, it, vi } from 'vitest';
import type { IRequestContext } from '@setu-ts/common';
import {
  createContainer,
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

it('refuses a context without cleanup with an actionable createTestApp error', () => {
  const c = createContainer();
  expect(() => c.forRequest({} as IRequestContext)).toThrow(RequestScopeUnavailableError);
  expect(() => c.forRequest({} as IRequestContext)).toThrow(/createTestApp/);
});
