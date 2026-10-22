import { DatabasePlugin } from '@setu-ts/database-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { registerModules } from './src/modules/index.ts';

/** Builds an application over the zero-dependency memory database, without starting it. */
export function createApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ValidationPlugin({ errorFormat: 'rfc9457' }),
      DatabasePlugin({ type: 'memory' }),
    ],
  });

  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });
  registerModules(app.router);

  return app;
}
