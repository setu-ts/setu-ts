import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { registerModules } from './src/modules/index.ts';

/** The request header that names the tenant. */
export const TENANT_HEADER = 'x-tenant-id';

/** Builds an application whose data store is partitioned by tenant, without starting it. */
export function createApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      MultiTenancyPlugin({
        resolver: 'header',
        header: { name: TENANT_HEADER },
        required: true,
      }),
    ],
  });

  registerModules(app.router);

  return app;
}
