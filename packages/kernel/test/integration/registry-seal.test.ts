import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

function recordingLogger(entries: string[]): ILogger {
  return {
    level: 'info',
    fatal: (): void => {},
    error: (): void => {},
    warn: (message: string): void => {
      entries.push(`warn:${message}`);
    },
    info: (message: string): void => {
      entries.push(`info:${message}`);
    },
    debug: (): void => {},
    trace: (): void => {},
    child(): ILogger {
      return this;
    },
  };
}

describe('application registry sealing', () => {
  it('seals the application registry after bootstrap but leaves request children mutable', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'lifecycle-registration',
          version: '1.0.0',
          register(ctx): void {
            ctx.lifecycle.onInit(() => ctx.services.register('init-service', {}));
            ctx.lifecycle.onBootstrap(() => ctx.services.register('bootstrap-service', {}));
            ctx.middleware.add(async (request, next) => {
              request.services.register('request-service', {});
              await next();
            });
          },
        },
      ],
    });
    await app.start();
    expect(app.services.has('init-service')).toBe(true);
    expect(app.services.has('bootstrap-service')).toBe(true);
    expect(() => app.services.register('late-service', {})).toThrow('onBootstrap');
    const response = await app.inject({ method: 'GET', url: 'http://localhost/' });
    expect(response.statusCode).toBe(404);
    await app.stop();
  });

  it('reports override at info and unregister at warn with the registering plugin', async () => {
    const entries: string[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'logger',
          version: '1.0.0',
          provides: [CAPABILITIES.LOGGER],
          register(ctx): void {
            ctx.services.register(CAPABILITIES.LOGGER, recordingLogger(entries));
          },
        },
        {
          name: 'mutator',
          version: '1.0.0',
          register(ctx): void {
            ctx.services.register('replaceable', { first: true });
            ctx.services.register('replaceable', { first: false }, { override: true });
            ctx.services.unregister('replaceable');
          },
        },
      ],
    });
    await app.start();
    expect(entries).toEqual([
      "info:Capability 'replaceable' was overridden by mutator.",
      "warn:Capability 'replaceable' was unregistered by mutator.",
    ]);
    await app.stop();
  });
});
