import { expect, it, vi } from 'vitest';
import type { IRequest, IRequestContext } from '@setu-ts/common';
import { createRequestContext } from '../../src/context/request-context.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function handle() {
  return createRequestContext(
    { method: 'GET', url: 'http://test/', path: '/', headers: new Headers() } as IRequest,
    new ServiceRegistry(),
    createFakeRuntime().runtime,
  );
}

function slotContext(ctx: IRequestContext): IRequestContext & {
  slot<T>(key: object, create: () => T): T;
} {
  expect(typeof Reflect.get(ctx, 'slot')).toBe('function');
  return ctx as IRequestContext & { slot<T>(key: object, create: () => T): T };
}

it('M125 slot: creates the first value once, including undefined, without changing object shape', () => {
  const ctx = slotContext(handle().ctx);
  const shape = Reflect.ownKeys(ctx);
  const create = vi.fn(() => undefined);
  const key = {};
  expect(ctx.slot(key, create)).toBeUndefined();
  expect(ctx.slot(key, () => 'replacement')).toBeUndefined();
  expect(create).toHaveBeenCalledOnce();
  expect(Reflect.ownKeys(ctx)).toEqual(shape);
});

it('M125 slot: keeps second and third identity keys independent and caches falsy overflow values', () => {
  const ctx = slotContext(handle().ctx);
  const shape = Reflect.ownKeys(ctx);
  const first = { name: 'same' };
  const second = { name: 'same' };
  const third = { name: 'same' };
  expect(ctx.slot(first, () => 0)).toBe(0);
  expect(ctx.slot(second, () => undefined)).toBeUndefined();
  expect(ctx.slot(third, () => false)).toBe(false);
  const replace = vi.fn(() => 'wrong');
  expect(ctx.slot(first, replace)).toBe(0);
  expect(ctx.slot(second, replace)).toBeUndefined();
  expect(ctx.slot(third, replace)).toBe(false);
  expect(replace).not.toHaveBeenCalled();
  expect(Reflect.ownKeys(ctx)).toEqual(shape);
});

it.each(['first', 'overflow'] as const)(
  'M125 slot: a throwing %s factory stores nothing and can be retried',
  (mode) => {
    const ctx = slotContext(handle().ctx);
    if (mode === 'overflow') ctx.slot({}, () => 'occupied');
    const key = {};
    const failure = new Error('create failed');
    expect(() =>
      ctx.slot(key, () => {
        throw failure;
      }),
    ).toThrow(failure);
    const value = {};
    const create = vi.fn(() => value);
    expect(ctx.slot(key, create)).toBe(value);
    expect(ctx.slot(key, () => 'wrong')).toBe(value);
    expect(create).toHaveBeenCalledOnce();
  },
);

it('M125 slot: retains and creates entries after completion while requests remain isolated', () => {
  const first = handle();
  const ctx = slotContext(first.ctx);
  const key = {};
  const value = {};
  expect(ctx.slot(key, () => value)).toBe(value);
  first.takeDeferred();
  expect(ctx.slot(key, () => 'wrong')).toBe(value);
  const late = {};
  expect(ctx.slot(late, () => 7)).toBe(7);
  expect(ctx.slot(late, () => 8)).toBe(7);
  expect(slotContext(handle().ctx).slot(key, () => 'other request')).toBe('other request');
});
