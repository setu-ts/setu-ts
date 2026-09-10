/**
 * Scheduler plugin factory.
 *
 * Creates a plugin that registers a SchedulerService under
 * `CAPABILITIES.SCHEDULER` (`'scheduler'`).
 *
 * @module
 */
import type {
  HealthIndicatorFn,
  IIngressBehavior,
  ILogger,
  IPlugin,
  IRuntimeServices,
  IScheduler,
  RegistryFactory,
  ScheduleOptions,
  SchedulerJobHandler,
} from '@setu-ts/common';
import { causeMessage, resolveRegistryEntry } from '@setu-ts/common';
import { SchedulerUnavailableError } from '../errors.ts';
import type {
  IDistributedLock,
  SchedulerJobDefinition,
  SchedulerJobEntry,
  SchedulerPluginOptions,
} from '../interfaces/index.ts';
import { resolveLock } from '../lock/distributed-lock.ts';
import type { ILifecyclableLock } from '../lock/distributed-lock.ts';
import { withIngressBehaviors } from '../jobs/job-executor.ts';
import { SchedulerService } from '../services/scheduler-service.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/**
 * Creates a scheduler plugin.
 *
 * @param options - Plugin configuration
 * @returns A plugin that registers an IScheduler under `'scheduler'`
 *
 * @example
 * ```typescript
 * app.register(SchedulerPlugin());
 *
 * // Or with distributed locking via Redis
 * app.register(SchedulerPlugin({
 *   distributedLock: { enabled: true, storage: 'redis', url: 'redis://localhost:6379' },
 * }));
 * ```
 * @since 0.1.0
 */
export function SchedulerPlugin(options?: SchedulerPluginOptions): IPlugin {
  // Enforce UTC-only timezone
  const timezone = options?.timezone ?? 'UTC';
  if (timezone !== 'UTC') {
    throw new Error('Non-UTC timezones are not supported in this release');
  }

  // The registration arms are split ONCE, here at plugin construction, so
  // `register` and the `onInit` hook each read a single list (the M70d arm
  // pattern). Instance entries keep their pre-arm `register()` timing;
  // factories are resolved in `onInit`, the first phase at which the registry
  // holds every capability. Each factory carries the index it holds in the
  // DECLARED array, not its position among the factories: the index is the
  // only thing the error label has to point a developer at the failing entry,
  // and filtering first made it name a different — working — entry whenever
  // the two arms were mixed.
  const jobs: readonly SchedulerJobEntry[] = options?.jobs ?? [];
  const behaviors: readonly (IIngressBehavior | RegistryFactory<IIngressBehavior>)[] =
    options?.behaviors ?? [];
  const jobInstances = jobs
    .map((entry, index) => ({ entry, index }))
    .filter((slot): slot is { entry: SchedulerJobDefinition; index: number } =>
      typeof slot.entry !== 'function'
    );
  const jobFactories = jobs
    .map((entry, index) => ({ entry, index }))
    .filter((slot): slot is { entry: RegistryFactory<SchedulerJobDefinition>; index: number } =>
      typeof slot.entry === 'function'
    );
  const behaviorInstances = behaviors.filter((entry): entry is IIngressBehavior =>
    typeof entry !== 'function'
  );
  const behaviorFactories = behaviors
    .map((entry, index) => ({ entry, index }))
    .filter((slot): slot is { entry: RegistryFactory<IIngressBehavior>; index: number } =>
      typeof slot.entry === 'function'
    );
  // The LIVE behaviour list the chain reads on every fire. Instances are
  // available at registration; when factories exist, `onInit` replaces it
  // with the complete declared sequence before the app serves.
  const behaviorChain: IIngressBehavior[] = [...behaviorInstances];
  const declaredBehaviors = behaviors.length > 0;
  // Held while behaviour FACTORIES are still unresolved. A fire waits on it so
  // no job runs through a partial chain; opened at the end of `onInit`, once
  // `behaviorChain` is final.
  // `withResolvers` rather than a `new Promise` executor with `() => {}`
  // placeholders: those placeholders are never called, so they are dead
  // functions the coverage bar counts.
  //
  // `failChainGate` is called when `onInit` fails, so work held on the gate
  // FAILS into this ingress's own failure path instead of hanging on a promise
  // that can never settle. Running it through the partial chain remains the
  // one thing the gate will not do.
  const {
    promise: chainReady,
    resolve: openChainGate,
    reject: failChainGate,
  } = Promise.withResolvers<void>();
  // The gate is awaited per dispatch, so its rejection is always observed
  // there; this keeps an unobserved rejection from surfacing when nothing is
  // currently held.
  chainReady.catch(() => {});

  return {
    name: 'scheduler-plugin',
    version: denoJson.version,
    provides: ['scheduler'],
    priority: 100,

    async register(ctx) {
      // X9-2: refuse BEFORE resolving or connecting any lock — and before ANY
      // declared entry is read (M86 §4.1): no `jobs` instance registers, and
      // the `onInit` hook that would resolve a factory entry is never reached,
      // because the plugin's entire surface is inert on Workers — `every` and
      // `delay` arm timers on an isolate that is evicted between invocations —
      // so registering it can only produce a job that never runs and reports
      // nothing.
      if (ctx.runtime.platform() === 'cloudflare-workers') {
        throw new SchedulerUnavailableError(ctx.runtime.platform());
      }

      // Resolve distributed lock
      const lock = await resolveLock(options, ctx.runtime);

      // Connect Redis lock if needed
      if (
        options?.distributedLock?.enabled &&
        options.distributedLock.storage === 'redis' &&
        options.distributedLock.lock === undefined
      ) {
        // RedisLock needs to be connected — use ILifecyclableLock seam
        const lifecycleLock = lock as ILifecyclableLock;
        if (typeof lifecycleLock.connect === 'function') {
          await lifecycleLock.connect();
        }
      }

      // Create scheduler service. With no behaviours declared the plain
      // service is constructed exactly as before the arms existed — no chain
      // sits in front of any handler (M86 §3.9). With behaviours declared,
      // the subclass routes EVERY registration — declarative arm entries AND
      // imperative `cron()`/`every()`/`delay()` calls — through the ingress
      // behaviour chain.
      const serviceOptions = {
        logger: ctx.logger,
        ttlMs: options?.distributedLock?.ttlMs,
      };
      const service = declaredBehaviors
        ? new BehaviorChainSchedulerService(
          ctx.runtime,
          lock,
          serviceOptions,
          behaviorChain,
          behaviorFactories.length === 0 ? undefined : chainReady,
        )
        : new SchedulerService(ctx.runtime, lock, serviceOptions);

      // Connect the service
      await service.connect();

      // Register the service
      ctx.services.register<IScheduler>('scheduler', service);

      // Declared job INSTANCES register now, exactly as an imperative
      // `cron()`/`every()`/`delay()` call made before this arm existed.
      //
      // Their timing is safe even when a behaviour FACTORY is declared, and
      // not because registration is deferred — M86's review reverted that.
      // Scheduling arms a timer, so a short `delay` or a due `cron` could
      // otherwise fire before `onInit` resolved the factory behaviours and
      // reach the handler through a PARTIAL chain. What prevents it is that
      // DELIVERY is gated: `BehaviorChainSchedulerService` holds each fire on
      // `chainReady`, which `openChainGate` opens only once the chain is
      // final. That gate also closes the second door a deferral could not —
      // a later plugin resolving this service in its own `register()`.
      for (const slot of jobInstances) {
        await scheduleDeclaredJob(service, slot.entry, slot.index);
      }

      // Register health indicator
      const healthIndicator: HealthIndicatorFn = service.createHealthIndicator();
      ctx.health.register('scheduler', healthIndicator);

      // Register lifecycle hook for cleanup
      ctx.lifecycle.onClose(async () => {
        await service.disconnect();

        // Disconnect Redis lock if needed
        const lifecycleLock = lock as ILifecyclableLock;
        if (typeof lifecycleLock.disconnect === 'function') {
          await lifecycleLock.disconnect();
        }
      });

      // Factory entries resolve at `onInit` — the first phase at which the
      // registry holds every capability, and still before the application
      // serves. A throwing factory rejects `start()` naming the option and the
      // entry's DECLARED index. The hook is registered only when a factory is
      // configured: with instances alone there is nothing to resolve, so a
      // zero-factory configuration gains no lifecycle hook at all.
      if (jobFactories.length > 0 || behaviorFactories.length > 0) {
        ctx.lifecycle.onInit(async () => {
          try {
            // The chain is completed FIRST, before any factory job is scheduled
            // below.
            behaviorChain.splice(
              0,
              behaviorChain.length,
              ...behaviors.map((entry, index) =>
                typeof entry === 'function'
                  ? resolveRegistryEntry(
                    entry,
                    ctx.services,
                    `SchedulerPlugin({ behaviors })[${index}]`,
                  )
                  : entry
              ),
            );

            for (const slot of jobFactories) {
              const definition = resolveRegistryEntry(
                slot.entry,
                ctx.services,
                `SchedulerPlugin({ jobs })[${slot.index}]`,
              );
              await scheduleDeclaredJob(service, definition, slot.index);
            }

            // LAST: the chain is final, so any fire held during startup may run.
            // A hook that threw above never reaches this, leaving the gate shut
            // — correct, since `start()` has failed.
            openChainGate();
          } catch (error) {
            // Fail the gate so held work rejects into this ingress's own
            // failure path rather than waiting on a promise that can never
            // settle, then surface the startup failure to the caller.
            failChainGate(error);
            throw error;
          }
        });
      }
    },
  };
}

/**
 * Internal {@linkcode SchedulerService} variant used when the plugin is
 * configured with ingress behaviours: it routes EVERY handler registration —
 * declarative arm entries and imperative `cron()`/`every()`/`delay()` calls
 * alike — through the scheduler behaviour chain, so a mixed application
 * cannot leave a handler unchained. The wrapper reads the live behaviour list
 * at FIRE time, so the full factory-resolved sequence installed in `onInit`
 * also wraps registrations made earlier in `register()`. Not barrel-exported.
 *
 * The chain the wrapper composes runs INSIDE the distributed lock: the
 * registry stores the wrapped handler, and the executor reaches it only after
 * the lock is held — so a replica that loses the lock runs neither the
 * handler nor any behaviour (M86 §3.10).
 *
 * With no behaviours declared the plugin constructs the plain
 * {@linkcode SchedulerService}, keeping the zero-configuration dispatch
 * byte-identical.
 */
class BehaviorChainSchedulerService extends SchedulerService {
  readonly #behaviors: readonly IIngressBehavior[];
  readonly #chainReady: Promise<void> | undefined;

  constructor(
    runtime: IRuntimeServices,
    lock: IDistributedLock,
    options: { logger?: ILogger | undefined; ttlMs?: number | undefined },
    behaviors: readonly IIngressBehavior[],
    chainReady?: Promise<void>,
  ) {
    super(runtime, lock, options);
    this.#behaviors = behaviors;
    this.#chainReady = chainReady;
  }

  /**
   * Registers the cron job with its handler wrapped in the behaviour chain.
   *
   * @typeParam T - The job payload type
   * @param name - Unique job name
   * @param expression - 5-field cron expression (UTC)
   * @param handler - The handler being registered
   * @param options - Payload and retry config, passed through
   */
  override async cron<T = unknown>(
    name: string,
    expression: string,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void> {
    await super.cron(
      name,
      expression,
      withIngressBehaviors(handler, this.#behaviors, this.#chainReady),
      options,
    );
  }

  /**
   * Registers the interval job with its handler wrapped in the behaviour chain.
   *
   * @typeParam T - The job payload type
   * @param name - Unique job name
   * @param intervalMs - Interval in milliseconds
   * @param handler - The handler being registered
   * @param options - Payload and retry config, passed through
   */
  override async every<T = unknown>(
    name: string,
    intervalMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void> {
    await super.every(
      name,
      intervalMs,
      withIngressBehaviors(handler, this.#behaviors, this.#chainReady),
      options,
    );
  }

  /**
   * Registers the one-shot job with its handler wrapped in the behaviour chain.
   *
   * @typeParam T - The job payload type
   * @param name - Unique job name
   * @param delayMs - Delay in milliseconds
   * @param handler - The handler being registered
   * @param options - Payload and retry config, passed through
   */
  override async delay<T = unknown>(
    name: string,
    delayMs: number,
    handler: SchedulerJobHandler<T>,
    options?: ScheduleOptions<T>,
  ): Promise<void> {
    await super.delay(
      name,
      delayMs,
      withIngressBehaviors(handler, this.#behaviors, this.#chainReady),
      options,
    );
  }
}

/**
 * Registers one entry of the declared `jobs` array, naming it if it refuses.
 *
 * Both arms funnel through here — an instance entry at `register()` and a
 * factory's resolved definition at `onInit` — so an operator cannot tell the
 * two apart from the failure, which is the point: the two arms describe the
 * same job.
 *
 * @param service - The connected scheduler service
 * @param definition - The definition to register
 * @param index - The entry's position in the DECLARED `jobs` array, not among
 *   entries of its own kind — the only thing that points at the failing entry
 * @returns Resolves when the registration call completes
 * @throws {Error} If the definition is refused; the message names the option,
 * the declared index and the job's own `name`, with the refusal as `cause`
 * @since 0.6.0
 */
async function scheduleDeclaredJob(
  service: IScheduler,
  definition: SchedulerJobDefinition,
  index: number,
): Promise<void> {
  try {
    await scheduleDefinition(service, definition);
  } catch (cause) {
    // X23-1: the underlying refusal names only what was wrong — `Invalid cron
    // expression: not a cron` — and an application declaring several jobs is
    // then told an expression is bad with nothing saying WHICH entry produced
    // it. The plugin holds both the declared index and the job's own name, so
    // it says them. This matches the label the factory arm already builds for
    // a throwing factory, so both arms of `jobs` fail the same way.
    throw new Error(
      `Failed to schedule SchedulerPlugin({ jobs })[${index}] ` +
        `(name '${definition.name}'): ${causeMessage(cause)}`,
      { cause },
    );
  }
}

/**
 * Registers one declarative job definition, dispatching on its `trigger` —
 * the declarative form of exactly one imperative `cron()`/`every()`/`delay()`
 * call.
 *
 * @param service - The connected scheduler service
 * @param definition - The definition to register
 * @returns Resolves when the registration call completes
 */
async function scheduleDefinition(
  service: IScheduler,
  definition: SchedulerJobDefinition,
): Promise<void> {
  const options: ScheduleOptions = {
    ...(definition.data !== undefined ? { data: definition.data } : {}),
    ...(definition.retry !== undefined ? { retry: definition.retry } : {}),
  };
  switch (definition.trigger) {
    case 'cron':
      await service.cron(definition.name, definition.expression, definition.handler, options);
      return;
    case 'every':
      await service.every(definition.name, definition.intervalMs, definition.handler, options);
      return;
    case 'delay':
      await service.delay(definition.name, definition.delayMs, definition.handler, options);
      return;
  }
}
