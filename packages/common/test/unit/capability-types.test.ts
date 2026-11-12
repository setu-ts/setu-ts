import { expect, expectTypeOf, it } from 'vitest';
import { CAPABILITIES, serviceToken, requestServiceToken } from '../../src/index.ts';
import type {
  CapabilityKey,
  StandardCapabilityToken,
  ServiceToken,
  RequestServiceToken,
} from '../../src/index.ts';

it('keeps standard tokens as strings while requiring their brands', () => {
  expect(CAPABILITIES.LOGGER).toBe('logger');
  expectTypeOf(CAPABILITIES.LOGGER).toExtend<string>();
  expectTypeOf(CAPABILITIES.LOGGER).toEqualTypeOf<StandardCapabilityToken<'logger'>>();
  const key: CapabilityKey = 'event-diagnostics';
  expect(key).toBe('event-diagnostics');
  // @ts-expect-error A plain string does not carry the standard token brand.
  const standard: StandardCapabilityToken<'logger'> = 'logger';
  // @ts-expect-error Singleton service tokens require their own brand.
  const singleton: ServiceToken<object> = 'module.service';
  // @ts-expect-error Request service tokens require their own brand.
  const request: RequestServiceToken<object> = 'module.service';
  expect([standard, singleton, request]).toEqual(['logger', 'module.service', 'module.service']);
  expect(serviceToken('module.singleton')).toBe('module.singleton');
  expect(requestServiceToken('module.request')).toBe('module.request');
});
