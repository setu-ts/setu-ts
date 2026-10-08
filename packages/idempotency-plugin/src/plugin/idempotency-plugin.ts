/**
 * The idempotency plugin factory (plan §3.14).
 *
 * @module
 */
import type { IIdempotencyService, ILogger, IPlugin } from '@setu-ts/common';
import { CAPABILITIES, createConnectionErrorReporter, PLUGIN_PRIORITY } from '@setu-ts/common';
import denoJson from '../../deno.json' with { type: 'json' };
import { resolveDefaults, validatePluginOptionShape } from '../core/options.ts';
import { createIdempotencyIndicator } from '../health/indicator.ts';
import type { IdempotencyLifecycleState } from '../health/indicator.ts';
import type { IdempotencyPluginOptions } from '../interfaces/index.ts';
import { IdempotencyService } from '../service/idempotency-service.ts';
import { resolveStore } from '../stores/resolve-store.ts';

/**
 * Creates the idempotency plugin, which registers an `IIdempotencyService`
 * under `CAPABILITIES.IDEMPOTENCY` and the `idempotency` health indicator.
 *
 * @param options - The plugin options
 * @returns A plugin registering the idempotency service
 * @throws {IdempotencyConfigurationError} When an option's shape is invalid
 * @example
 * ```typescript
 * app.register(IdempotencyPlugin({ store: { type: 'memory' } }));
 * app.register(IdempotencyPlugin({ store: { type: 'redis', namespace: 'shop', url: REDIS_URL } }));
 * ```
 * @since 0.9.0
 */
export function IdempotencyPlugin(options?: IdempotencyPluginOptions): IPlugin {
  validatePluginOptionShape(options ?? {});
  const defaults = resolveDefaults(options);
  let state: IdempotencyLifecycleState = 'pending';

  return {
    name: 'idempotency-plugin',
    version: denoJson.version,
    provides: [CAPABILITIES.IDEMPOTENCY],
    priority: PLUGIN_PRIORITY.NORMAL,
    async register(ctx) {
      const logger = (): ILogger | undefined => ctx.logger;
      // A built ioredis client's connection errors go to the logger instead of
      // ioredis printing each reconnect failure to the console. The logger is
      // read at call time, so one registered later is still honoured (§3.5).
      const reporter = createConnectionErrorReporter({
        source: 'idempotency-plugin: redis store',
        // The SAME call-time thunk the store already logs through.
        logger,
      });
      const store = await resolveStore(options?.store, reporter, logger);
      await store.connect(ctx.runtime);
      state = 'connected';
      // Registered immediately after connect, so a store whose indicator
      // registration throws still gets its `disconnect`.
      ctx.lifecycle.onClose(async () => {
        state = 'closed';
        await store.disconnect?.();
      });
      const service = new IdempotencyService({ store, runtime: ctx.runtime, logger, defaults });
      ctx.services.register<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY, service);
      ctx.health.register(
        'idempotency',
        createIdempotencyIndicator(store, ctx.runtime, () => state),
      );
    },
  };
}
