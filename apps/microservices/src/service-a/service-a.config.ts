import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';
import { SERVICE_B } from '../greeting.contract.ts';
import { optionalMessaging } from '../messaging.ts';

/** Builds service A, which finds service B through static discovery. */
export function createServiceA(serviceBPort: number, redisUrl?: string): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      ...optionalMessaging(redisUrl),
      ServiceDiscoveryPlugin({
        provider: 'static',
        services: { [SERVICE_B]: [{ host: '127.0.0.1', port: serviceBPort }] },
      }),
    ],
  });
}
