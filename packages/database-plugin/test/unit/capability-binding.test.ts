import { expectTypeOf, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry } from '@setu-ts/common';
import type { IDatabaseService } from '../../src/index.ts';

it('binds the plugin tokens through the public barrel', () => {
  const check = (registry: IServiceRegistry): void => {
    expectTypeOf(registry.get(CAPABILITIES.DATABASE)).toEqualTypeOf<IDatabaseService>();
  };
  expectTypeOf(check).toBeFunction();
});
