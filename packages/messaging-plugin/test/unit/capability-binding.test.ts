import { expectTypeOf, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry } from '@setu-ts/common';
import type { IOutbox, IInbox } from '../../src/index.ts';

it('binds the plugin tokens through the public barrel', () => {
  const check = (registry: IServiceRegistry): void => {
    expectTypeOf(registry.get(CAPABILITIES.OUTBOX)).toEqualTypeOf<IOutbox>();
    expectTypeOf(registry.get(CAPABILITIES.INBOX)).toEqualTypeOf<IInbox>();
  };
  expectTypeOf(check).toBeFunction();
});
