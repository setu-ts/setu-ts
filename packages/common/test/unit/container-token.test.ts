import { expect, expectTypeOf, it } from 'vitest';
import { createToken } from '../../src/index.ts';
import type { InjectionToken } from '../../src/index.ts';

it('creates frozen identity tokens without counters or runtime type state', () => {
  const first = createToken<number>('port');
  const second = createToken<number>('port');
  expect(first).toEqual({ name: 'port' });
  expect(Object.keys(first)).toEqual(['name']);
  expect(Object.isFrozen(first)).toBe(true);
  expect(first).not.toBe(second);
  expectTypeOf(first).toEqualTypeOf<InjectionToken<number>>();
});
