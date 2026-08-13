import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

describe('route ownership integration', () => {
  it('attributes each plugin route and leaves an application route unowned', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'health-plugin',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/health', (request) => request.response.send());
          },
        },
        {
          name: 'metrics-plugin',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/metrics', (request) => request.response.send());
          },
        },
      ],
    });
    app.router.get('/application', (request) => request.response.send());

    await app.start();

    expect(app.router.listRoutes()).toEqual([
      expect.objectContaining({ path: '/application' }),
      expect.objectContaining({ path: '/health', owner: 'health-plugin' }),
      expect.objectContaining({ path: '/metrics', owner: 'metrics-plugin' }),
    ]);
    expect(app.router.listRoutes()[0]?.owner).toBe(undefined);

    await app.stop();
  });
});
