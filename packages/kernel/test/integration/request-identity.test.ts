import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
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

describe('request identity through the kernel', () => {
  it('turns a late implicit overwrite into a 500 response', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'double-writer',
          version: '1.0.0',
          register(ctx): void {
            ctx.middleware.add(async (request, next) => {
              request.request.user = { id: 'first', roles: [] };
              request.request.user = { id: 'second', roles: [] };
              await next();
            });
          },
        },
      ],
    });
    await app.start();
    const response = await app.inject({ method: 'GET', url: 'http://localhost/' });
    expect(response.statusCode).toBe(500);
    await app.stop();
  });
});
