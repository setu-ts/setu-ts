/**
 * DiagnosticsPlugin — the local diagnostics connector.
 *
 * Activation is explicit and development-scoped: every option is required,
 * nothing auto-enables, and the plugin refuses startup when M98a's
 * diagnostics were not enabled on the application. The plugin resolves the
 * runtime-owned `ILocalDiagnosticsListenerFactory` through its declared
 * capability, hands it the private protocol handler and the explicit port
 * in `onBootstrap`, and retains only the returned listener — it never
 * imports the runtime package, constructs an adapter, or receives a server
 * handle.
 *
 * @module
 */

import type {
  IAuthorizationDiagnosticsSource,
  ICacheDiagnosticsSource,
  IConfigDiagnosticsSource,
  IEventDiagnosticsSource,
  IHealthDiagnosticsSource,
  ILocalDiagnosticsListener,
  ILocalDiagnosticsListenerFactory,
  IPluginContext,
  IQueueDiagnosticsSource,
  ISchedulerDiagnosticsSource,
  ITraceDiagnosticsSource,
  TimerHandle,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import denoJson from '../../deno.json' with { type: 'json' };
import type { DiagnosticsPluginOptions, IDiagnosticsPlugin } from '../interfaces/index.ts';
import { DiagnosticsSessionState } from '../security/session.ts';
import { createConnectorHandler } from '../transport/connector-handler.ts';
import { ConnectorLimits } from '../transport/limits.ts';
import { QueueObservationMerger } from '../transport/queue-merger.ts';
import { MAX_CACHE_SOURCES } from '../protocol/cache-protocol.ts';
import { MAX_EVENT_SOURCES } from '../protocol/event-protocol.ts';
import { MAX_SCHEDULER_SOURCES } from '../protocol/scheduler-protocol.ts';

/**
 * The default session lifetime: 15 minutes.
 *
 * @internal
 */
const DEFAULT_TTL_MS = 900_000;

/**
 * The maximum session lifetime: one hour.
 *
 * @internal
 */
const MAX_TTL_MS = 3_600_000;

/**
 * Fixed activation errors. Each names the refusal, never a supplied value.
 *
 * @internal
 */
export const PLUGIN_ERRORS = {
  notEnabled:
    'DiagnosticsPlugin: enabled must be true to activate the local diagnostics connector.',
  invalidPort: 'DiagnosticsPlugin: port must be an integer from 1024 to 65535.',
  invalidSessionId: 'DiagnosticsPlugin: sessionId must be exactly 32 lowercase hex characters.',
  invalidSessionKey: 'DiagnosticsPlugin: sessionKey must be exactly 32 bytes.',
  invalidTtl: 'DiagnosticsPlugin: ttlMs must be an integer from 1 to 3600000.',
  tooManySchedulerSources:
    'DiagnosticsPlugin: more than 16 scheduler-diagnostics sources are registered; ' +
    'the connector reads at most 16.',
  tooManyEventSources:
    'DiagnosticsPlugin: more than 16 event-diagnostics sources are registered; ' +
    'the connector reads at most 16.',
  tooManyCacheSources:
    'DiagnosticsPlugin: more than 16 cache-diagnostics sources are registered; ' +
    'the connector reads at most 16.',
  missingDiagnostics:
    'DiagnosticsPlugin: the application was not created with kernel diagnostics enabled. ' +
    'Pass diagnostics: {} to createApplication to use the connector.',
} as const;

/**
 * Validates the factory options. Composition-time: a mistake here is a
 * developer error and refuses BEFORE any application exists.
 *
 * @param options - The options to validate
 * @returns The resolved TTL in milliseconds
 * @throws {Error} With one fixed message on any invalid option
 * @internal
 */
export function validatePluginOptions(options: DiagnosticsPluginOptions): number {
  if (options.enabled !== true) {
    throw new Error(PLUGIN_ERRORS.notEnabled);
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(PLUGIN_ERRORS.invalidPort);
  }
  if (!/^[0-9a-f]{32}$/.test(options.sessionId)) {
    throw new Error(PLUGIN_ERRORS.invalidSessionId);
  }
  if (!(options.sessionKey instanceof Uint8Array) || options.sessionKey.byteLength !== 32) {
    throw new Error(PLUGIN_ERRORS.invalidSessionKey);
  }
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MS) {
    throw new Error(PLUGIN_ERRORS.invalidTtl);
  }
  return ttl;
}

/**
 * Creates the diagnostics connector plugin.
 *
 * @param options - The explicit, launch-scoped options
 * @returns The plugin; keep the instance to call {@linkcode IDiagnosticsPlugin.revoke}
 * @throws {Error} At composition time for any invalid option
 * @example
 * ```typescript
 * const diagnostics = DiagnosticsPlugin({
 *   enabled: true,
 *   port: 4919,
 *   sessionId,
 *   sessionKey,
 * });
 * const app = createApplication({
 *   plugins: [RuntimePlugin(), diagnostics],
 *   diagnostics: {},
 * });
 * await app.start();
 * ```
 * @since 0.8.0
 */
export function DiagnosticsPlugin(options: DiagnosticsPluginOptions): IDiagnosticsPlugin {
  const ttlMs = validatePluginOptions(options);

  // Declared before the revoke closure reads it: revoke() is valid before
  // register() runs, where `runtime` is still null.
  let runtime: IPluginContext['runtime'] | null = null;

  let revoked = false;
  let generation = 0;
  let cleanupPromise: Promise<void> | null = null;
  let listener: ILocalDiagnosticsListener | null = null;
  let session: DiagnosticsSessionState | null = null;
  let expiryTimer: TimerHandle | null = null;
  let queueMerger: QueueObservationMerger | null = null;
  let traceSource: ITraceDiagnosticsSource | null = null;

  const revoke = (): Promise<void> => {
    if (cleanupPromise !== null) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      // First, disarm: the generation bump fails every post-await check in
      // flight, the session drop disables authorization immediately, and the
      // timer clear ends the expiry path. Only then close the socket —
      // asynchronously, awaited so a caller that awaits revoke() knows the
      // port is released.
      revoked = true;
      generation += 1;
      session?.revoke();
      session = null;
      // The merged queue observations are discarded with the session, so
      // nothing captured for it outlives the revocation.
      queueMerger?.close();
      queueMerger = null;
      if (expiryTimer !== null) {
        runtime?.clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      const open = listener;
      listener = null;
      await open?.close();
    })();
    return cleanupPromise;
  };

  return {
    name: 'diagnostics-plugin',
    version: denoJson.version,
    dependencies: [CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER],
    optionalDependencies: [
      CAPABILITIES.HEALTH_DIAGNOSTICS,
      CAPABILITIES.CONFIG_DIAGNOSTICS,
      CAPABILITIES.QUEUE_DIAGNOSTICS,
      CAPABILITIES.SCHEDULER_DIAGNOSTICS,
      CAPABILITIES.TRACE_DIAGNOSTICS,
      CAPABILITIES.EVENTS_DIAGNOSTICS,
      CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
    ],

    register(ctx: IPluginContext): void {
      const source = ctx.app.diagnostics;
      if (source === undefined) {
        throw new Error(PLUGIN_ERRORS.missingDiagnostics);
      }
      runtime = ctx.runtime;
      const factory = ctx.services.get<ILocalDiagnosticsListenerFactory>(
        CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER,
      );
      // The optional health-diagnostics source (M98d): resolved once, during
      // registration, through its declared optional capability. An absent
      // source means no health plugin is registered, and the connector answers
      // a typed `unsupported`. A health plugin without the `diagnostics`
      // option still registers a source, which answers `disabled`. Neither
      // runs an indicator or fails startup.
      const healthSource: IHealthDiagnosticsSource | null = ctx.services.has(
          CAPABILITIES.HEALTH_DIAGNOSTICS,
        )
        ? ctx.services.get<IHealthDiagnosticsSource>(CAPABILITIES.HEALTH_DIAGNOSTICS)
        : null;
      // The optional trace-diagnostics source (M98g): resolved once, during
      // registration, through its declared optional capability. A single
      // source — every TelemetryPlugin instance registers exactly one, and
      // the kernel admits one provider of the token. Absent means no
      // telemetry plugin at all, and the connector answers a typed
      // `unsupported`. A telemetry plugin whose observation was not opted
      // into still registers a source, which answers `disabled`. Neither
      // creates, ends, exports or flushes a span, and neither fails startup.
      traceSource = ctx.services.has(CAPABILITIES.TRACE_DIAGNOSTICS)
        ? ctx.services.get<ITraceDiagnosticsSource>(CAPABILITIES.TRACE_DIAGNOSTICS)
        : null;

      // The optional authorization-diagnostics source (M98h): resolved once,
      // during registration, through its declared optional capability. A
      // single source — the AuthPlugin always registers exactly one, and the
      // kernel admits one provider of the token. Absent means no auth plugin
      // at all, and the connector answers a typed `unsupported` batch. An
      // auth plugin without the observation option still registers a
      // source, which answers `disabled`; with the option but without RBAC
      // it answers `unsupported`. A read never evaluates a role, permission or wildcard,
      // and neither fails startup.
      const authorizationSource: IAuthorizationDiagnosticsSource | null =
        ctx.services.has(CAPABILITIES.AUTHORIZATION_DIAGNOSTICS)
          ? ctx.services.get<IAuthorizationDiagnosticsSource>(
            CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
          )
          : null;

      // The optional configuration provenance source (M98e): the same shape.
      // An absent source means no ConfigPlugin is registered and the
      // connector answers a typed `unsupported`; the ConfigPlugin ALWAYS
      // registers one, so a configuration without the `diagnostics` option
      // answers `disabled` rather than unsupported. A provenance read never
      // touches a configuration value.
      const configSource: IConfigDiagnosticsSource | null = ctx.services.has(
          CAPABILITIES.CONFIG_DIAGNOSTICS,
        )
        ? ctx.services.get<IConfigDiagnosticsSource>(CAPABILITIES.CONFIG_DIAGNOSTICS)
        : null;

      // Parent cleanup hooks FIRST — before the bootstrap below opens the
      // listener — so a failed startup, a parent stop, or a close all meet
      // an installed revoke. The kernel runs close hooks on the
      // failed-startup path too, which is how a listener opened during a
      // bootstrap that later fails still gets released.
      ctx.lifecycle.onStopping(() => revoke());
      ctx.lifecycle.onClose(() => revoke());

      ctx.lifecycle.onBootstrap(async () => {
        const startGeneration = generation;
        if (revoked) {
          return;
        }
        const active = await DiagnosticsSessionState.create(
          ctx.runtime.subtle,
          options.sessionId,
          options.sessionKey,
          ttlMs,
          ctx.runtime,
        );
        // Post-await check: a revoke during key import leaves nothing bound.
        if (revoked || generation !== startGeneration) {
          active.revoke();
          return;
        }
        session = active;
        const limits = new ConnectorLimits(ctx.runtime);
        // The queue-diagnostics sources (M98f), read ONCE here: every plugin
        // has registered by bootstrap, so a queue plugin ordered after this
        // one is still included. Each named queue instance contributes its own
        // multi-provider source; none means the connector answers a typed
        // `unsupported` batch. Only the first 16 are ever read.
        const queueSources = ctx.services.has(CAPABILITIES.QUEUE_DIAGNOSTICS)
          ? ctx.services.getAll<IQueueDiagnosticsSource>(CAPABILITIES.QUEUE_DIAGNOSTICS)
          : [];
        // The cache-diagnostics sources (M98i), read ONCE here for the same
        // reason. Registration is only collected — no snapshot is taken until
        // an authenticated request — and more than 16 refuses by a fixed,
        // value-free configuration error rather than silently dropping one.
        const cacheSources = ctx.services.has(CAPABILITIES.CACHE_DIAGNOSTICS)
          ? ctx.services.getAll<ICacheDiagnosticsSource>(CAPABILITIES.CACHE_DIAGNOSTICS)
          : [];
        if (cacheSources.length > MAX_CACHE_SOURCES) {
          active.revoke();
          session = null;
          throw new Error(PLUGIN_ERRORS.tooManyCacheSources);
        }
        const merger = new QueueObservationMerger(queueSources, ctx.runtime);
        queueMerger = merger;
        // The event-diagnostics sources (M98j), read ONCE here: every plugin
        // has registered by bootstrap, so an events plugin ordered after this
        // one is still included. Each EventsPlugin instance contributes its
        // own multi-provider source; none means the connector answers a
        // typed `unsupported` response. More than 16 refuses by a fixed,
        // value-free configuration error rather than silently dropping one.
        const eventSources = ctx.services.has(CAPABILITIES.EVENTS_DIAGNOSTICS)
          ? ctx.services.getAll<IEventDiagnosticsSource>(CAPABILITIES.EVENTS_DIAGNOSTICS)
          : [];
        // The scheduler-diagnostics sources (M98k), read ONCE here for the
        // same reason. Registration is only collected — no snapshot is taken
        // until an authenticated request — and more than 16 refuses by a
        // fixed, value-free configuration error rather than silently
        // dropping one.
        const schedulerSources = ctx.services.has(CAPABILITIES.SCHEDULER_DIAGNOSTICS)
          ? ctx.services.getAll<ISchedulerDiagnosticsSource>(
            CAPABILITIES.SCHEDULER_DIAGNOSTICS,
          )
          : [];
        if (schedulerSources.length > MAX_SCHEDULER_SOURCES) {
          active.revoke();
          session = null;
          throw new Error(PLUGIN_ERRORS.tooManySchedulerSources);
        }
        if (eventSources.length > MAX_EVENT_SOURCES) {
          active.revoke();
          session = null;
          throw new Error(PLUGIN_ERRORS.tooManyEventSources);
        }
        const handler = createConnectorHandler({
          port: options.port,
          subtle: ctx.runtime.subtle,
          session: active,
          limits,
          source,
          clock: ctx.runtime,
          healthSource,
          configSource,
          cacheSources,
          schedulerSources,
          queues: merger,
          traces: traceSource,
          eventSources,
          authorization: authorizationSource,
        });
        // The devtool's own startup line. Without it the runtime prints a
        // bare `Listening on http://127.0.0.1:<port>/`, which in an
        // application that also binds a port is indistinguishable from the
        // application's own listener — the signal is wanted, the ambiguity
        // is not. Supplying `onListen` REPLACES that banner.
        //
        // Read here, in `onBootstrap`, and not in `register()`: every
        // plugin has registered by now, so a LoggerPlugin ordered after this
        // one is still visible (the M52b capture-too-early defect). When no
        // logger is registered at all the key is OMITTED rather than bound
        // to a no-op, so the runtime's default banner stands and the bind is
        // never silent.
        const logger = ctx.logger;
        const announce = logger === undefined ? undefined : (
          address: { hostname: string; port: number },
        ): void => {
          logger.info(
            `Setu devtool: local diagnostics connector listening on ` +
              `http://${address.hostname}:${address.port}`,
          );
        };
        const opened = await factory.listen({
          port: options.port,
          handler,
          ...(announce !== undefined ? { onListen: announce } : {}),
        });
        // Post-await check: a revoke during the bind closes the late-created
        // listener instead of leaking it.
        if (revoked || generation !== startGeneration) {
          await opened.close();
          return;
        }
        listener = opened;
        expiryTimer = ctx.runtime.setTimeout(() => {
          // Swallow deliberately: revoke() awaits listener.close(), whose
          // shutdown may reject on an already-errored socket. An unhandled
          // rejection terminates the whole process — exactly what revoke()
          // must never do to the parent application. The socket is released
          // by the OS regardless, and a DIRECT revoke() caller still sees
          // the rejection.
          revoke().catch(() => {});
        }, ttlMs);
      });
    },

    revoke,
  };
}
