import { expectTypeOf, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry } from '@setu-ts/common';
import type { IStaticFiles } from '../../src/index.ts';

it('binds the plugin tokens through the public barrel', () => {
  const check = (registry: IServiceRegistry): void => {
    expectTypeOf(registry.get(CAPABILITIES.STATIC_FILES)).toEqualTypeOf<IStaticFiles>();
  };
  expectTypeOf(check).toBeFunction();
});
