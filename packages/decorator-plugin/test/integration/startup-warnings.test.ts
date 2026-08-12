import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { beforeEach } from '@std/testing/bdd';

import type {
  IPlugin,
  IPluginContext,
  IRequestContext,
  IRuntimeServices,
  LogMetadata,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';

import {
  clearParameterResolvers,
  Controller,
  createParameterDecorator,
  Ctx,
  Get,
  registerParameterResolver,
} from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

interface Warning {
  readonly message: string;
  readonly metadata?: LogMetadata;
}

/** Collects `warn` calls so a startup diagnostic can be asserted. */
function collectingLoggerPlugin(sink: Warning[]): IPlugin {
  const logger = {
    level: 'warn' as const,
    fatal: () => {},
    error: () => {},
    // `exactOptionalPropertyTypes` — omit `metadata` rather than assigning undefined.
    warn: (message: string, metadata?: LogMetadata) =>
      void sink.push(metadata === undefined ? { message } : { message, metadata }),
    info: () => {},
    debug: () => {},
    trace: () => {},
    child: () => logger,
  };
  return {
    name: 'logger',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

function testRuntimePlugin(): IPlugin {
  return {
    name: 'runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register<IRuntimeServices>(CAPABILITIES.RUNTIME, createFakeRuntime());
    },
  };
}

async function startWith(controllers: readonly (new () => object)[]): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const app = createApplication({
    plugins: [
      testRuntimePlugin(),
      collectingLoggerPlugin(warnings),
      DecoratorPlugin({ controllers: [...controllers] }),
    ],
  });
  await app.start();
  await app.stop();
  return warnings;
}

describe('startup warnings', () => {
  beforeEach(() => {
    metadataStore.clear();
    clearParameterResolvers();
  });

  it('warns when an explicitly listed controller carries no @Controller metadata', async () => {
    // A class whose decorators wrote to a DIFFERENT copy's metadata store looks
    // exactly like this to the plugin: present in `controllers`, absent from the
    // store. Left unreported, every one of its routes answers 404 silently.
    class Undecorated {
      list() {
        return [];
      }
    }

    const warnings = await startWith([Undecorated]);
    const warning = warnings.find((w) =>
      w.message === 'Controller has no @Controller metadata and registers no routes'
    );
    expect(warning).toBeDefined();
    expect(warning?.metadata?.['controller']).toBe('Undecorated');
    expect(String(warning?.metadata?.['hint'])).toContain('decorator-plugin');
  });

  it('does not warn for a properly decorated controller', async () => {
    @Controller('/ok')
    class Ok {
      @Get('/')
      list() {
        return [];
      }
    }

    expect(await startWith([Ok])).toEqual([]);
  });

  it('warns about a custom parameter that no registered resolver can satisfy', async () => {
    const Unregistered = (): ParameterDecorator => createParameterDecorator('never-registered');

    @Controller('/params')
    class ParamController {
      @Get('/')
      read(@Unregistered() value: string) {
        return { value };
      }
    }

    const warnings = await startWith([ParamController]);
    const warning = warnings.find((w) =>
      w.message === 'Decorated parameter cannot be resolved and will be undefined'
    );
    expect(warning).toBeDefined();
    expect(warning?.metadata?.['controller']).toBe('ParamController');
    expect(warning?.metadata?.['handler']).toBe('read');
    expect(warning?.metadata?.['parameterIndex']).toBe(0);
    expect(warning?.metadata?.['customType']).toBe('never-registered');
  });

  it('reports a custom parameter written to the store with no customType', async () => {
    // The metadata store is public API (CAPABILITIES.METADATA_STORE), so an
    // integration can write a parameter record directly. One without a
    // customType matches no rule and must still be named in the warning.
    @Controller('/raw')
    class RawController {
      @Get('/')
      read() {
        return {};
      }
    }
    metadataStore.storeParam(RawController, 'read', { index: 0, type: 'custom' });

    const warnings = await startWith([RawController]);
    const warning = warnings.find((w) =>
      w.message === 'Decorated parameter cannot be resolved and will be undefined'
    );
    expect(warning).toBeDefined();
    expect(warning?.metadata?.['customType']).toBe('(none)');
  });

  it('does not warn for @Ctx, @CurrentUser, or a registered custom parameter', async () => {
    const Tenant = (): ParameterDecorator => createParameterDecorator('current-tenant');
    registerParameterResolver('current-tenant', () => 'tenant-1');

    @Controller('/mixed')
    class MixedController {
      @Get('/')
      read(@Ctx() _ctx: IRequestContext, @Tenant() tenant: string) {
        return { tenant };
      }
    }

    expect(await startWith([MixedController])).toEqual([]);
  });
});
