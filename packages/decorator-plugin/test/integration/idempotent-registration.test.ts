/**
 * `@Idempotent` at `register()` (M109a §3.9): the middleware is appended with
 * the route's options when a provider exists, and the two refusals fire when it
 * does not, or on a safe method.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  Constructor,
  IIdempotencyService,
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  MiddlewareFunction,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { DecoratorPlugin } from '@setu-ts/decorator-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { ValidateBody } from '../../src/index.ts';
import { Controller } from '../../src/decorators/controller.ts';
import { Idempotent } from '../../src/decorators/idempotency.ts';
import { Get, Post } from '../../src/decorators/http.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

// Real Zod, guarded the same way the validation suites are: the ordering test
// needs a schema that actually rejects, so it is skipped where npm:zod cannot
// load rather than passing vacuously.
const zodModule = await import('npm:zod@^3.24.0').catch(() => undefined);
const z = zodModule?.z;
const itZod = z === undefined ? it.skip : it;

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

/** Minimal runtime-provider plugin backed by the fake runtime. */
function testRuntimePlugin(): IPlugin {
  const runtime: IRuntimeServices = createFakeRuntime();
  return {
    name: 'test-runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

describe('@Idempotent runs AFTER the validation band (M109a §3.9, negative control 8)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  itZod('never enters the idempotency middleware for an invalid body', async () => {
    let entered = 0;
    const provider: IPlugin = {
      name: 'counting-idempotency-provider',
      version: '1.0.0',
      provides: [CAPABILITIES.IDEMPOTENCY],
      register(ctx: IPluginContext): void {
        const service: IIdempotencyService = {
          middleware: (): MiddlewareFunction => (_ctx, next) => {
            entered++;
            return next();
          },
          behavior: () => ({ handle: (_ctx, next) => next() }),
        };
        ctx.services.register(CAPABILITIES.IDEMPOTENCY, service);
      },
    };
    const Schema = z!.object({ name: z!.string() });

    @Controller('/pay')
    class PayController {
      @Post('/')
      @ValidateBody(Schema)
      @Idempotent()
      create() {
        return {};
      }
    }

    const app = createApplication({
      plugins: [
        testRuntimePlugin(),
        ValidationPlugin(),
        provider,
        DecoratorPlugin({ controllers: [PayController as unknown as Constructor] }),
      ],
    });
    await app.start();
    try {
      const bad = await app.inject({
        method: 'POST',
        url: 'http://localhost/pay',
        body: { name: 1 },
      });
      expect(bad.statusCode).toBe(400);
      // Validation answered first, so the idempotency middleware never ran and
      // the caller's key was not consumed.
      expect(entered).toBe(0);
    } finally {
      await app.stop();
    }
  });
});
