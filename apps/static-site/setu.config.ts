import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '@setu-ts/static-plugin';
import type { StaticPluginOptions } from '@setu-ts/static-plugin';

/** The settings the smoke check changes to drive the streaming path. */
export type StaticSiteOverrides = Pick<StaticPluginOptions, 'maxBufferBytes'>;

/** Builds the static site, served from `./public` with an SPA fallback, without starting it. */
export function createApp(overrides: StaticSiteOverrides = {}): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      StaticPlugin({ root: './public', urlPrefix: '/', fallback: 'index.html', ...overrides }),
    ],
  });

  app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));

  return app;
}
