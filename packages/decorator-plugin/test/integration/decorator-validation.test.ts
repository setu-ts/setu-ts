import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, validatedStateKey } from '@setu-ts/common';
import type {
  HandlerResult,
  IPlugin,
  IPluginContext,
  IRequestContext,
  IRuntimeServices,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { ValidationPlugin } from '@setu-ts/validation-plugin';

import { Body, Controller, Ctx, Post, UseGuards, ValidateBody } from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

// Real Zod, guarded: the suite is skipped where the npm specifier cannot load
// (the same arrangement the validation-plugin suites use). Class bodies below
// call these factories only when a test runs, i.e. never while skipped.
const zodModule = await import('npm:zod@^3.24.0').catch(() => undefined);
const z = zodModule?.z;

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

/**
 * A schema that CHANGES its input: defaults a missing quantity and
 * trims/uppercases the name. A schema that only rejects cannot distinguish the
 * enforcing pipeline from the inert one — only a transform can.
 */
function transformingBodySchema(): unknown {
  const { object, string, number } = z!;
  return object({
    name: string(),
    quantity: number().int().default(1),
  }).transform((v) => ({ ...v, name: v.name.trim().toUpperCase() }));
}

/** A rejecting guard: answers 403 without calling next(). */
const rejectingGuard = (ctx: IRequestContext): HandlerResult => {
  ctx.response.status(403).json({ error: 'forbidden' });
  return { __handlerResult: true } as HandlerResult;
};

// The whole suite describes REAL enforcement, so it is skipped wholesale where
// the real Zod import could not load.
const describeEnforcement = z === undefined ? describe.skip : describe;

describeEnforcement('decorator validation enforcement (integration)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('rejects a bad body with 400 and stores the TRANSFORMED body under the shared key', async () => {
    const Schema = transformingBodySchema();
    let seenViaState: unknown;

    @Controller('/orders')
    class OrderController {
      @Post('/')
      @ValidateBody(Schema)
      create(@Ctx() ctx: IRequestContext) {
        seenViaState = ctx.state.get(validatedStateKey('body'));
        return null;
      }
    }

    const app = createApplication({
      plugins: [
        testRuntimePlugin(),
        ValidationPlugin(),
        DecoratorPlugin({ controllers: [OrderController] }),
      ],
    });
    await app.start();

    const bad = await app.inject({
      method: 'POST',
      url: 'http://localhost/orders',
      body: { name: 'widget', quantity: 'not-a-number' },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'POST',
      url: 'http://localhost/orders',
      body: { name: '  widget  ', quantity: 3 },
    });
    expect(good.statusCode).toBe(200);
    // The RAW body was '  widget  '; the validated value carries the
    // TRANSFORMED one — written by validation-plugin's middleware under
    // common's `validatedStateKey`, read here through the same helper: the two
    // packages share one key byte-for-byte. (The handler ARGUMENT reading this
    // value is E2 — parameter-resolver work, not E1.)
    expect(seenViaState).toEqual({ name: 'WIDGET', quantity: 3 });

    await app.stop();
  });

  it('applies schema defaults when the field is absent', async () => {
    const Schema = transformingBodySchema();
    let seenViaState: unknown;

    @Controller('/state')
    class StateController {
      @Post('/')
      @ValidateBody(Schema)
      read(@Ctx() ctx: IRequestContext) {
        seenViaState = ctx.state.get(validatedStateKey('body'));
        return null;
      }
    }

    const app = createApplication({
      plugins: [
        testRuntimePlugin(),
        ValidationPlugin(),
        DecoratorPlugin({ controllers: [StateController] }),
      ],
    });
    await app.start();
    const res = await app.inject({
      method: 'POST',
      url: 'http://localhost/state',
      body: { name: 'widget' },
    });
    expect(res.statusCode).toBe(200);
    expect(seenViaState).toEqual({ name: 'WIDGET', quantity: 1 });
    await app.stop();
  });

  it('a rejecting guard answers BEFORE validation (403, not 400)', async () => {
    const Schema = transformingBodySchema();

    @Controller('/guarded')
    class GuardedController {
      @Post('/')
      @UseGuards(rejectingGuard)
      @ValidateBody(Schema)
      create(@Ctx() ctx: IRequestContext) {
        // The guard short-circuits; this must never run.
        return ctx.response.status(200).json({ ran: true });
      }
    }

    const app = createApplication({
      plugins: [
        testRuntimePlugin(),
        ValidationPlugin(),
        DecoratorPlugin({ controllers: [GuardedController] }),
      ],
    });
    await app.start();
    // The body ALSO fails the schema — but the guard runs first (validation is
    // appended LAST, innermost).
    const res = await app.inject({
      method: 'POST',
      url: 'http://localhost/guarded',
      body: { quantity: 'nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    await app.stop();
  });

  it('enforceSchemas:false restores description-only behaviour', async () => {
    const Schema = transformingBodySchema();

    @Controller('/optout')
    class OptOutController {
      @Post('/')
      @ValidateBody(Schema)
      create(@Body() body: unknown) {
        return body;
      }
    }

    const app = createApplication({
      plugins: [
        testRuntimePlugin(),
        ValidationPlugin(),
        DecoratorPlugin({ controllers: [OptOutController], enforceSchemas: false }),
      ],
    });
    await app.start();
    // An invalid body reaches the handler untouched — today's behaviour.
    const res = await app.inject({
      method: 'POST',
      url: 'http://localhost/optout',
      body: { quantity: 'nope' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ quantity: 'nope' });
    await app.stop();
  });
});
