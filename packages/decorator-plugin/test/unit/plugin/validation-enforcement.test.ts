import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  Err,
  ILogger,
  IValidationService,
  LogMetadata,
  MiddlewareFunction,
  ValidationIssue,
} from '@setu-ts/common';

import {
  Controller,
  Get,
  Post,
  UseFilters,
  UseGuards,
  ValidateBody,
  ValidateQuery,
} from '../../../src/index.ts';
import { DecoratorPlugin } from '../../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../../fixtures/fake-context.ts';

/** A recording logger capturing `warn` calls. */
function recordingLogger(): {
  logger: ILogger;
  warns: { message: string; metadata?: LogMetadata }[];
} {
  const warns: { message: string; metadata?: LogMetadata }[] = [];
  const logger: ILogger = {
    level: 'warn',
    fatal() {},
    error() {},
    info() {},
    debug() {},
    trace() {},
    warn(message, metadata) {
      warns.push(metadata === undefined ? { message } : { message, metadata });
    },
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

interface MiddlewareCall {
  readonly schema: unknown;
  readonly target: 'body' | 'query' | 'params' | 'headers' | 'cookies';
}

/** A fake validation service whose middleware functions are uniquely marked. */
function fakeValidationService(): {
  service: IValidationService;
  calls: MiddlewareCall[];
  markerOf(fn: unknown): string | undefined;
} {
  const calls: MiddlewareCall[] = [];
  let n = 0;
  const service: IValidationService = {
    validate(_schema: unknown, _data: unknown): Err<readonly ValidationIssue[]> {
      return { success: false, error: [] };
    },
    middleware(schema: unknown, target: MiddlewareCall['target']): MiddlewareFunction {
      calls.push({ schema, target });
      const fn: MiddlewareFunction = (_ctx, next) => next();
      const marker = `mw-${++n}`;
      Object.defineProperty(fn, '__marker', { value: marker });
      return fn;
    },
  };
  return {
    service,
    calls,
    markerOf(fn: unknown): string | undefined {
      return (fn as { __marker?: string }).__marker;
    },
  };
}

/** Extracts the RouteDefinition a plugin registered (always a RouteDefinition). */
function asRouteDef(route: unknown): { middleware?: MiddlewareFunction[] } {
  return route as { middleware?: MiddlewareFunction[] };
}

describe('DecoratorPlugin validation enforcement (E1)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('appends validation middleware LAST per present target, in schema order', async () => {
    const bodySchema = { kind: 'body-schema' };
    const querySchema = { kind: 'query-schema' };
    const guardFn: MiddlewareFunction = () => {};
    const filterFn: MiddlewareFunction = () => {};

    @Controller('/items')
    class ItemsController {
      @Post('/')
      @UseGuards(guardFn)
      @UseFilters(filterFn)
      @ValidateBody(bodySchema)
      @ValidateQuery(querySchema)
      create() {
        return null;
      }
    }

    const fake = fakeValidationService();
    const { ctx, routes } = createFakeContext();
    ctx.services.register(CAPABILITIES.VALIDATION, fake.service);
    await DecoratorPlugin({ controllers: [ItemsController] }).register(ctx);

    expect(fake.calls).toEqual([
      { schema: bodySchema, target: 'body' },
      { schema: querySchema, target: 'query' },
    ]);
    // LAST position: after the guards AND the filters.
    const mw = asRouteDef(routes[0].route).middleware ?? [];
    expect(mw.map((fn) => fake.markerOf(fn))).toEqual([undefined, undefined, 'mw-1', 'mw-2']);
  });

  it('appends nothing for a route without validation schemas', async () => {
    @Controller('/plain')
    class PlainController {
      @Get('/')
      list() {
        return [];
      }
    }

    const fake = fakeValidationService();
    const { ctx, routes } = createFakeContext();
    ctx.services.register(CAPABILITIES.VALIDATION, fake.service);
    await DecoratorPlugin({ controllers: [PlainController] }).register(ctx);

    expect(fake.calls).toEqual([]);
    expect(asRouteDef(routes[0].route).middleware).toBeUndefined();
  });

  it('warns ONCE per route naming controller, handler and targets when the capability is absent', async () => {
    @Controller('/unprotected')
    class UnprotectedController {
      @Post('/a')
      @ValidateBody({ kind: 'b' })
      createA() {
        return null;
      }

      @Get('/b')
      list() {
        return [];
      }
    }

    const { logger, warns } = recordingLogger();
    const { ctx, routes } = createFakeContext({ logger });
    await DecoratorPlugin({ controllers: [UnprotectedController] }).register(ctx);

    // One warning — only for the route that carries a schema; /b is silent.
    expect(warns).toHaveLength(1);
    const meta = warns[0].metadata ?? {};
    expect(meta.controller).toBe('UnprotectedController');
    expect(meta.handler).toBe('createA');
    expect(meta.targets).toEqual(['body']);
    expect(String(warns[0].message) + String(meta.hint)).toContain('ValidationPlugin');
    expect(warns[0].message).toContain('NOT enforced');
    // No enforcement middleware was appended.
    expect(asRouteDef(routes[0].route).middleware).toBeUndefined();
    expect(asRouteDef(routes[1].route).middleware).toBeUndefined();
  });

  it('emits no warning when the capability is present', async () => {
    @Controller('/ok')
    class OkController {
      @Post('/')
      @ValidateBody({ kind: 'b' })
      create() {
        return null;
      }
    }

    const { logger, warns } = recordingLogger();
    const fake = fakeValidationService();
    const { ctx } = createFakeContext({ logger });
    ctx.services.register(CAPABILITIES.VALIDATION, fake.service);
    await DecoratorPlugin({ controllers: [OkController] }).register(ctx);

    expect(fake.calls).toHaveLength(1);
    expect(warns).toHaveLength(0);
  });

  it('enforceSchemas:false appends nothing and silences the warning', async () => {
    @Controller('/legacy')
    class LegacyController {
      @Post('/')
      @ValidateBody({ kind: 'b' })
      @ValidateQuery({ kind: 'q' })
      create() {
        return null;
      }
    }

    const { logger, warns } = recordingLogger();
    const fake = fakeValidationService();
    const { ctx, routes } = createFakeContext({ logger });
    // Capability ABSENT on purpose: the warning must be silenced too.
    await DecoratorPlugin({ controllers: [LegacyController], enforceSchemas: false }).register(ctx);

    expect(fake.calls).toEqual([]);
    expect(warns).toHaveLength(0);
    expect(asRouteDef(routes[0].route).middleware).toBeUndefined();
    // The schema is still described for OpenAPI consumers.
    const def = routes[0].route as { schema?: { body?: unknown; query?: unknown } };
    expect(def.schema?.body).toEqual({ kind: 'b' });
    expect(def.schema?.query).toEqual({ kind: 'q' });
  });

  it('declares an optional dependency on the validation capability', () => {
    const plugin = DecoratorPlugin({});
    expect(plugin.optionalDependencies).toEqual([CAPABILITIES.VALIDATION]);
  });
});
