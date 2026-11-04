import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import type { CloudflareWorkerEnv } from '@setu-ts/cloudflare-plugin';
import { CloudflareWorkersHttpAdapter, createCloudflareRuntimeServices } from '@setu-ts/runtime';
import { WORKER_ENV } from '../bindings.ts';

/**
 * Registers only the Workers runtime adapters so the Worker bundle never evaluates Node, Deno, or
 * Bun adapter modules.
 */
export function CloudflareRuntimePlugin(): IPlugin {
  return {
    name: 'runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME, CAPABILITIES.HTTP_ADAPTER],
    priority: PLUGIN_PRIORITY.HIGHEST,
    register(ctx: IPluginContext): void {
      const env = ctx.services.get<CloudflareWorkerEnv>(WORKER_ENV);
      ctx.services.register(CAPABILITIES.RUNTIME, createCloudflareRuntimeServices({ env }));
      ctx.services.register(CAPABILITIES.HTTP_ADAPTER, new CloudflareWorkersHttpAdapter());
    },
  };
}
