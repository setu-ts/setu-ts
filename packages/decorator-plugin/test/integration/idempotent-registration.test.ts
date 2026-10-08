/**
 * `@Idempotent` at `register()` (M109a §3.9): the middleware is appended with
 * the route's options when a provider exists, and the two refusals fire when it
 * does not, or on a safe method.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { Constructor, IIdempotencyService, IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { Controller } from '../../src/decorators/controller.ts';
import { Idempotent } from '../../src/decorators/idempotency.ts';
import { Get, Post } from '../../src/decorators/http.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

/** A provider plugin recording every `middleware()` call. */
function providerPlugin(calls: unknown[]): IPlugin {
  const service: IIdempotencyService = {
    middleware: (options) => {
      calls.push(options);
      return (_ctx, next) => next();
    },
    behavior: () => ({ handle: (_ctx, next) => next() }),
  };
  return {
    name: 'fake-idempotency-provider',
    version: '1.0.0',
    provides: [CAPABILITIES.IDEMPOTENCY],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.IDEMPOTENCY, service);
    },
  };
}

describe('@Idempotent registration (M109a §3.9)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('appends the idempotency middleware with the route options', async () => {
    @Controller('/pay')
    class PayController {
      @Post('/')
      @Idempotent({ namespace: 'payments' })
      create() {
        return {};
      }
    }
    const calls: unknown[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        providerPlugin(calls),
        DecoratorPlugin({ controllers: [PayController as unknown as Constructor] }),
      ],
    });
    await app.start();
    try {
      expect(calls).toEqual([{ namespace: 'payments' }]);
    } finally {
      await app.stop();
    }
  });

  it('fails register() for @Idempotent on a safe method', async () => {
    @Controller('/pay')
    class PayController {
      @Get('/')
      @Idempotent()
      list() {
        return [];
      }
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        providerPlugin([]),
        DecoratorPlugin({ controllers: [PayController as unknown as Constructor] }),
      ],
    });
    await expect(app.start()).rejects.toThrow('is a safe method');
  });

  it('fails register() when no idempotency provider is registered', async () => {
    @Controller('/pay')
    class PayController {
      @Post('/')
      @Idempotent()
      create() {
        return {};
      }
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [PayController as unknown as Constructor] }),
      ],
    });
    await expect(app.start()).rejects.toThrow('no CAPABILITIES.IDEMPOTENCY provider is registered');
  });
});
