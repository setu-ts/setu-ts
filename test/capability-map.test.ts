import { expectTypeOf, it } from 'vitest';
import type { UnboundCapability } from '@setu-ts/common';
import type {} from '@setu-ts/database-plugin';
import type {} from '@setu-ts/cloudflare-plugin';
import type {} from '@setu-ts/static-plugin';
import type {} from '@setu-ts/messaging-plugin';

it('leaves exactly the four kernel contribution shapes unbound in the full program', () => {
  expectTypeOf<UnboundCapability>().toEqualTypeOf<
    'metric-registration' | 'openapi-schema' | 'decorator-handler' | 'cli-command'
  >();
});
