/**
 * `CloudflarePlugin` — publishes a Worker's platform bindings under
 * `CAPABILITIES.CLOUDFLARE`, and optionally serves the cache and storage
 * capabilities from KV and R2.
 *
 * @module
 */

import type {
  CapabilityToken,
  ICacheStore,
  IPlugin,
  IPluginContext,
  IQueue,
  IStorage,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY, splitWorkerEnv } from '@hono-enterprise/common';

import { resolveWaitUntil } from '../background/wait-until.ts';
import { instanceToken } from '../instance-token.ts';
import type { ICloudflareBindings } from '../bindings/binding-registry.ts';
import { BindingRegistry } from '../bindings/binding-registry.ts';
import { CloudflareBindingMissingError } from '../errors.ts';
import { createCloudflareIndicator } from '../health/indicator.ts';
import type { CloudflarePluginOptions } from '../options.ts';
import { WorkersQueue } from '../queues/workers-queue.ts';
import { R2Storage } from '../storage/r2-storage.ts';
import { KvCacheStore } from '../stores/kv-cache-store.ts';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'cloudflare-plugin';

/**
 * Creates the Cloudflare Workers plugin.
 *
 * The Worker's `env` is passed in rather than imported, because
 * `cloudflare:workers` is not a specifier any other runtime can resolve. The
 * plugin captures the bindings at `register()` and never calls a method on one
 * there: Cloudflare prohibits I/O outside a request context, so a probe read at
 * startup would throw on a real deployment while passing against every fake.
 *
 * @example
 * ```typescript
 * import { env, waitUntil } from 'cloudflare:workers';
 * import { CloudflarePlugin } from '@hono-enterprise/cloudflare-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin({ env }),
 *     CloudflarePlugin({
 *       env,
 *       waitUntil,
 *       cache: { binding: 'CACHE_KV', prefix: 'cache:' },
 *     }),
 *   ],
 * });
 *
 * export default { fetch: app.fetch };
 * ```
 * @param options - The Worker `env` plus the capabilities to serve from it
 * @returns The plugin instance
 * @throws {CloudflareBindingMissingError} At `register()`, when a required or
 * configured binding is absent, or is present with the wrong shape
 * @since 0.2.0
 */
export function CloudflarePlugin(options: CloudflarePluginOptions): IPlugin {
  // Each arm is paired with its token in one value, so a later `undefined`
  // check narrows both at once — carrying them separately would leave a second
  // check that can never fail.
  const cacheArm = options.cache === undefined
    ? undefined
    : { options: options.cache, token: instanceToken(CAPABILITIES.CACHE, options.cache.name) };
  const storageArm = options.storage === undefined ? undefined : {
    options: options.storage,
    token: instanceToken(CAPABILITIES.STORAGE, options.storage.name),
  };
  const queueArm = options.queue === undefined
    ? undefined
    : { options: options.queue, token: instanceToken(CAPABILITIES.QUEUE, options.queue.name) };

  // Computed from the options rather than declared statically, so the kernel's
  // duplicate-provider index sees exactly what this instance registers.
  const provides: CapabilityToken[] = [CAPABILITIES.CLOUDFLARE];
  if (cacheArm !== undefined) provides.push(cacheArm.token);
  if (storageArm !== undefined) provides.push(storageArm.token);
  if (queueArm !== undefined) provides.push(queueArm.token);

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: ['logger'],
    provides,
    priority: PLUGIN_PRIORITY.HIGH,

    register(ctx: IPluginContext): void {
      const { vars, bindings } = splitWorkerEnv(options.env);
      const available = Object.keys(bindings).sort();

      // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so
      // `requireBindings: ['toString']` would pass a check whose whole job is
      // to fail fast on a binding the Worker does not carry.
      const missing = (options.requireBindings ?? []).filter(
        (name) => !Object.hasOwn(bindings, name),
      );
      if (missing.length > 0) {
        throw CloudflareBindingMissingError.absent(missing.join("', '"), available);
      }

      const registry = new BindingRegistry(
        bindings,
        vars,
        // A thunk, not `ctx.logger`: the kernel resolves that through a Proxy
        // that answers `undefined` until a logger is registered, and a
        // capability may be registered imperatively without declaring
        // `provides` — which the `optionalDependencies` ordering edge cannot
        // see. Reading it when the failure happens is what makes the reporting
        // this seam promises actually happen.
        resolveWaitUntil(options.waitUntil, () => ctx.logger),
      );
      ctx.services.register<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE, registry);

      if (cacheArm !== undefined) {
        const store = new KvCacheStore(registry.kv(cacheArm.options.binding), ctx.runtime, {
          ...(cacheArm.options.prefix === undefined ? {} : { prefix: cacheArm.options.prefix }),
          ...(cacheArm.options.defaultTtlSeconds === undefined
            ? {}
            : { defaultTtlSeconds: cacheArm.options.defaultTtlSeconds }),
        });
        ctx.services.register<ICacheStore>(cacheArm.token, store);
      }

      if (storageArm !== undefined) {
        const storage = new R2Storage(registry.r2(storageArm.options.binding), {
          ...(storageArm.options.prefix === undefined ? {} : { prefix: storageArm.options.prefix }),
        });
        ctx.services.register<IStorage>(storageArm.token, storage);
      }

      if (queueArm !== undefined) {
        // `ctx.runtime` rather than `crypto.randomUUID()`: the id `add` returns
        // travels inside the message envelope, and AI_GUIDELINES §4.2 routes
        // every runtime capability through IRuntimeServices. That requirement is
        // why the queue is built here rather than by the application.
        const queue = new WorkersQueue(registry.queue(queueArm.options.binding), ctx.runtime, {
          // A thunk, matching the waitUntil seam above: `ctx.logger` reads as
          // `undefined` until a logger is registered, so capturing its value
          // here would silence a logger that registers imperatively later.
          logger: () => ctx.logger,
          ...(queueArm.options.maxDelaySeconds === undefined
            ? {}
            : { maxDelaySeconds: queueArm.options.maxDelaySeconds }),
        });
        ctx.services.register<IQueue>(queueArm.token, queue);
      }

      ctx.health.register(
        'cloudflare',
        createCloudflareIndicator({
          bindings: available,
          varCount: Object.keys(vars).length,
          cache: cacheArm !== undefined,
          storage: storageArm !== undefined,
          queue: queueArm !== undefined,
          waitUntil: options.waitUntil !== undefined,
          platform: ctx.runtime.platform(),
        }),
      );
    },
  };
}
