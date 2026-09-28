/**
 * RealtimeBackplanePlugin — registers an `IRealtimeBackplane` under
 * `CAPABILITIES.REALTIME_BACKPLANE`.
 *
 * @module
 * @since 0.2.0
 */

import type {
  HealthCheckResult,
  IPlugin,
  IPluginContext,
  IRealtimeBackplane,
  IRealtimeDiagnosticsSource,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  compileRealtimeDiagnosticsAlias,
  createConnectionErrorReporter,
  createRealtimeObservationCollector,
  PLUGIN_PRIORITY,
} from '@setu-ts/common';
import {
  attachRealtimeObserver,
  detachRealtimeObserver,
} from '../diagnostics/realtime-observations.ts';
import type { RealtimeBackplanePluginOptions } from '../interfaces/index.ts';
import { createBackplane } from '../transports/backplane-factory.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'realtime-backplane-plugin';

/**
 * Creates the RealtimeBackplanePlugin.
 *
 * Registers a transport under `CAPABILITIES.REALTIME_BACKPLANE`, which the
 * WebSocket and SSE plugins resolve **optionally** — so adding this plugin is
 * what turns their in-process rooms and channels into cluster-wide ones, and
 * removing it returns them to in-process behavior with no code change.
 *
 * Its priority is above normal so the transport is connected before the
 * consumers register and subscribe.
 *
 * @example
 * ```typescript
 * import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
 *
 * app.register(RealtimeBackplanePlugin({
 *   transport: 'redis',
 *   url: 'redis://localhost:6379',
 * }));
 * app.register(WebSocketPlugin());
 * ```
 * @param options - Transport configuration; defaults to the in-process
 * `'memory'` transport
 * @returns The plugin instance
 * @since 0.2.0
 */
export function RealtimeBackplanePlugin(
  options: RealtimeBackplanePluginOptions = { transport: 'memory' },
): IPlugin {
  // M98l: validated here, before any application exists. The `'custom'` arm
  // carries no `diagnostics` option: its transport is never observed.
  const diagnosticsOption = options.transport === 'custom' ? undefined : options.diagnostics;
  const diagnosticsAlias = diagnosticsOption === undefined
    ? null
    : compileRealtimeDiagnosticsAlias(diagnosticsOption);

  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    provides: [CAPABILITIES.REALTIME_BACKPLANE],
    // Resolved by the messaging arm; absent for every other transport.
    optionalDependencies: [CAPABILITIES.MESSAGING],
    priority: PLUGIN_PRIORITY.HIGH,

    async register(ctx: IPluginContext): Promise<void> {
      // M70n X3-4: the plugin that knows its transport is the one that reports
      // it. A `'memory'` backplane is a real single-process transport — frames
      // never cross a process boundary — so behind more than one replica its
      // fan-out looks like partial delivery rather than an error. Said once at
      // register (the fact is fixed for the application's lifetime), and
      // suppressible with `localNotice: false` like the consumers'
      // `scalingNotice` opt-outs. Non-memory transports fan out already.
      // Both arms of the disjunct narrow `options` to `MemoryBackplaneOptions`,
      // the only arm that carries `localNotice`.
      if (
        (options.transport === undefined || options.transport === 'memory') &&
        options.localNotice !== false
      ) {
        ctx.logger?.info(
          "realtime-backplane: transport is 'memory' — frames fan out only within this " +
            "process. Configure transport 'redis' or 'messaging' to broadcast across replicas.",
        );
      }

      // The redis arm's built connections report reconnect failures to the
      // logger (read at call time) unless the caller routed them elsewhere,
      // rather than through ioredis's own console fallback.
      const resolved: RealtimeBackplanePluginOptions =
        options.transport === 'redis' && options.connectionErrorReporter === undefined
          ? {
            ...options,
            connectionErrorReporter: createConnectionErrorReporter({
              source: 'realtime-backplane-plugin: redis transport',
              logger: () => ctx.logger,
            }),
          }
          : options;
      const backplane = createBackplane(resolved, ctx.services, ctx.runtime.uuid());

      // Awaited, so the subscription is live before the first request and
      // before either consumer plugin registers its handler.
      await backplane.connect();

      ctx.services.register<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE, backplane);

      // M98l: one realtime source as a MULTI provider, describing THIS
      // transport only. A backplane has no gauges. Opted out (and always on
      // the `'custom'` arm), the collector is inert and nothing is attached.
      const collector = createRealtimeObservationCollector({
        kind: 'backplane',
        alias: diagnosticsAlias,
        clock: () => ctx.runtime.hrtime(),
      });
      if (collector.enabled) {
        attachRealtimeObserver(backplane, collector);
      }
      ctx.services.register<IRealtimeDiagnosticsSource>(
        CAPABILITIES.REALTIME_DIAGNOSTICS,
        collector.source,
        { multi: true },
      );

      ctx.health.register('realtime-backplane', async (): Promise<HealthCheckResult> => {
        // M70c: a fan-out failure is `degraded` (local delivery still works, so
        // /ready keeps serving), never `down`. A transport that cannot probe
        // (isHealthy absent) reports unknown reachability with an up status.
        let reachable: boolean | 'unknown' = 'unknown';
        if (typeof backplane.isHealthy === 'function') {
          reachable = await backplane.isHealthy();
        }
        return {
          status: reachable === false ? 'degraded' : 'up',
          data: {
            transport: options.transport ?? 'memory',
            origin: backplane.origin,
            reachable,
          },
        };
      });

      ctx.lifecycle.onClose(async () => {
        // M98l: detached and closed BEFORE the transport tears down.
        detachRealtimeObserver(backplane);
        collector.close();
        await backplane.close();
      });
    },
  };
}
