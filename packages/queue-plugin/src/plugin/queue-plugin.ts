/**
 * Queue plugin factory.
 *
 * Creates a plugin that registers a QueueService with the specified adapter.
 *
 * @module
 */

import type {
  HealthIndicatorFn,
  IIngressBehavior,
  ILogger,
  IMetricsService,
  IPlugin,
  IPluginContext,
  IQueue,
  IRuntimeServices,
  JobProcessor,
  ProcessOptions,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken, resolveRegistryEntry } from '@setu-ts/common';
import type {
  QueueAdapterType,
  QueuePluginOptions,
  QueueProcessorDefinition,
  QueueProcessorEntry,
} from '../interfaces/index.ts';
import type { QueueAdapter } from '../adapters/queue-adapter.ts';
import { MemoryQueue } from '../adapters/memory-queue.ts';
import { RedisQueue, validateClient as isRedisQueueClient } from '../adapters/redis-queue.ts';
import {
  RabbitMqQueue,
  validateClient as isAmqpQueueConnection,
} from '../adapters/rabbitmq-queue.ts';
import { SqsQueue } from '../adapters/sqs-queue.ts';
import { QueueService } from '../services/queue-service.ts';
import { withIngressBehaviors } from '../processors/job-processor.ts';
import { QueueCollector } from '../metrics/queue-collector.ts';
import type { QueueLogger } from '../services/queue-service.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/**
 * Creates a queue plugin.
 *
 * @param options - Plugin configuration
 * @returns A plugin that registers a QueueService
 *
 * @example
 * ```typescript
 * app.register(QueuePlugin({ adapter: 'memory' }));
 *
 * // Or with Redis
 * app.register(QueuePlugin({ adapter: 'redis', url: 'redis://localhost:6379' }));
 *
 * // Or with a named instance
 * app.register(QueuePlugin({ adapter: 'memory', name: 'background' }));
 * ```
 * @since 0.1.0
 */
export function QueuePlugin(options?: QueuePluginOptions): IPlugin {
  const adapterType: QueueAdapterType = options?.adapter ?? 'memory';
  const name = options?.name;
  const defaultMaxAttempts = options?.defaultMaxAttempts ?? 3;
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;

  // The registration arms are split ONCE, here at plugin construction, so
  // `register` and the `onInit` hook each read a single list (the M70d arm
  // pattern). Instance entries keep their pre-arm `register()` timing;
  // factories are resolved in `onInit`, the first phase at which the registry
  // holds every capability. Each factory carries the index it holds in the
  // DECLARED array, not its position among the factories: the index is the
  // only thing the error label has to point a developer at the failing entry,
  // and filtering first made it name a different — working — entry whenever
  // the two arms were mixed.
  const processors: readonly QueueProcessorEntry[] = options?.processors ?? [];
  const behaviors: readonly (IIngressBehavior | RegistryFactory<IIngressBehavior>)[] =
    options?.behaviors ?? [];
  const processorInstances = processors.filter((entry): entry is QueueProcessorDefinition =>
    typeof entry !== 'function'
  );
  const processorFactories = processors
    .map((entry, index) => ({ entry, index }))
    .filter((slot): slot is { entry: RegistryFactory<QueueProcessorDefinition>; index: number } =>
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
  // The LIVE behaviour list the chain reads on every delivery. Instances are
  // available at registration; when factories exist, `onInit` replaces it
  // with the complete declared sequence before the app serves.
  const behaviorChain: IIngressBehavior[] = [...behaviorInstances];
  const declaredBehaviors = behaviors.length > 0;
  // Held while behaviour FACTORIES are still unresolved. Dispatch waits on it
  // so no job reaches a processor through a partial chain; opened at the end
  // of `onInit`, once `behaviorChain` is final.
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

  // Derive plugin name and token using capability token grammar
  const pluginName = name ? `queue-plugin.${name}` : 'queue-plugin';
  const token = name ? createCapabilityToken(`queue.${name}`) : 'queue';

  return {
    name: pluginName,
    version: denoJson.version,
    provides: [token],
    // B5: Declare optional logger dependency so kernel ordering resolves
    // LoggerPlugin first when installed, but remains optional. `METRICS` is
    // optional for the same reason: absent it, no collector is built and every
    // call site is optional-chained (X8-4).
    optionalDependencies: [CAPABILITIES.LOGGER, CAPABILITIES.METRICS],
    priority: 100,

    async register(ctx) {
      // Build adapter based on type
      let adapter;

      switch (adapterType) {
        case 'memory':
          adapter = new MemoryQueue();
          break;
        case 'redis': {
          const client = options?.client;
          adapter = new RedisQueue({
            url: options?.url ?? 'redis://localhost:6379',
            ...(client !== undefined && isRedisQueueClient(client) ? { client } : {}),
            ...(options?.deadLetterTtlMs === undefined
              ? {}
              : { deadLetterTtlMs: options.deadLetterTtlMs }),
          });
          break;
        }
        case 'rabbitmq': {
          const client = options?.client;
          adapter = new RabbitMqQueue(ctx.runtime, {
            url: options?.url ?? 'amqp://localhost:5672',
            ...(client !== undefined && isAmqpQueueConnection(client) ? { client } : {}),
            ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
          });
          break;
        }
        case 'sqs': {
          if (!options?.sqs) {
            throw new Error('SQS adapter requires options.sqs configuration');
          }
          const sqsLogger = resolveLogger(ctx);
          adapter = new SqsQueue(
            ctx.runtime,
            options.sqs,
            sqsLogger ?? undefined,
          );
          break;
        }
        default:
          throw new Error(`Unknown queue adapter: ${adapterType}`);
      }

      // Create runtime services from context
      const runtime = ctx.runtime;

      // Create queue service. The logger is optional: without it, a failing job
      // or a broken adapter is reported nowhere, which is how the worker loop
      // used to behave unconditionally.
      const logger = resolveLogger(ctx);
      // Present only when the application registered the metrics capability.
      const collector = ctx.services.has(CAPABILITIES.METRICS)
        ? new QueueCollector(
          ctx.services.get<IMetricsService>(CAPABILITIES.METRICS),
          // Read through `ctx` at CALL time, never captured here: a logger
          // registered after this plugin would otherwise be missed for the life
          // of the application (the M52b `waitUntil` lesson).
          (error: Error): void => {
            ctx.logger?.warn('queue metrics write failed', { error: error.message });
          },
        )
        : undefined;
      const serviceOptions = {
        defaultMaxAttempts,
        pollIntervalMs,
        ...(logger !== undefined && { logger }),
        ...(collector === undefined ? {} : { collector }),
      };
      // With no behaviours declared the service is constructed exactly as
      // before the arms existed — no chain sits in front of any processor
      // (M86 §3.9). With behaviours declared, the subclass routes every
      // registration — declarative arm entries AND imperative `process()`
      // calls — through the ingress behaviour chain.
      const service = declaredBehaviors
        ? new BehaviorChainQueueService(
          adapter,
          runtime,
          serviceOptions,
          behaviorChain,
          behaviorFactories.length === 0 ? undefined : chainReady,
        )
        : new QueueService(adapter, runtime, serviceOptions);

      // Connect the service
      await service.connect();

      // Register the service
      ctx.services.register<IQueue>(token, service);

      // Declared processor INSTANCES register now, exactly as an imperative
      // `process()` call made before this arm existed.
      //
      // UNLESS a behaviour FACTORY is declared. Registering a processor arms
      // the poll loop, so a job already sitting in a durable queue can be
      // reserved and dispatched before `onInit` resolved the factory
      // behaviours — reaching the processor through a PARTIAL chain, skipping
      // exactly the behaviours that needed a resolved capability. Deferring
      // the whole set into the same `onInit` hook, after the chain is final,
      // is what makes the arm's guarantee true. With no factory declared the
      // chain is already complete here and the timing is unchanged.
      // With no factory in the array, declared order IS registration order and
      // the instances register here, at their pre-arm timing. With a factory
      // present the WHOLE array is registered in `onInit` instead, in declared
      // order — because `process()` is last-wins on a job name, and splitting
      // the arms made `[factoryA, instanceB]` on one name resolve to factoryA,
      // contradicting this option's own documented last-wins contract.
      if (processorFactories.length === 0) {
        for (const definition of processorInstances) {
          service.process(definition.name, definition.processor, definition.options);
        }
      }

      // Register health indicator using the same token
      const healthIndicator: HealthIndicatorFn = service.createHealthIndicator();
      ctx.health.register(token, healthIndicator);

      // Register lifecycle hook for cleanup
      ctx.lifecycle.onClose(async () => {
        await service.disconnect();
      });

      // Factory entries resolve at `onInit` — the first phase at which the
      // registry holds every capability, and still before the application
      // serves. A throwing factory rejects `start()` naming the option and the
      // entry's DECLARED index. The hook is registered only when a factory is
      // configured: with instances alone there is nothing to resolve, so a
      // zero-factory configuration gains no lifecycle hook at all.
      if (processorFactories.length > 0 || behaviorFactories.length > 0) {
        ctx.lifecycle.onInit(() => {
          try {
            // The chain is completed FIRST, before any factory processor is
            // registered below.
            behaviorChain.splice(
              0,
              behaviorChain.length,
              ...behaviors.map((entry, index) =>
                typeof entry === 'function'
                  ? resolveRegistryEntry(
                    entry,
                    ctx.services,
                    `QueuePlugin({ behaviors })[${index}]`,
                  )
                  : entry
              ),
            );

            // DECLARED order, walking the original array — not instances then
            // factories — so the last entry for a job name wins, as documented.
            if (processorFactories.length > 0) {
              processors.forEach((entry, index) => {
                const definition = typeof entry === 'function'
                  ? resolveRegistryEntry(
                    entry,
                    ctx.services,
                    `QueuePlugin({ processors })[${index}]`,
                  )
                  : entry;
                service.process(definition.name, definition.processor, definition.options);
              });
            }

            // LAST: the chain is final, so any job held during startup may run.
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
 * Internal {@linkcode QueueService} variant used when the plugin is
 * configured with ingress behaviours: it routes EVERY processor registration
 * — declarative arm entries and imperative `process()` calls alike — through
 * the queue behaviour chain, so a mixed application cannot leave a handler
 * unchained. The wrapper reads the live behaviour list at dispatch, so the
 * full factory-resolved sequence installed in `onInit` also wraps
 * registrations made earlier in `register()`. Not barrel-exported.
 *
 * With no behaviours declared the plugin constructs the plain
 * {@linkcode QueueService}, keeping the zero-configuration dispatch
 * byte-identical.
 */
class BehaviorChainQueueService extends QueueService {
  readonly #behaviors: readonly IIngressBehavior[];
  readonly #chainReady: Promise<void> | undefined;

  constructor(
    adapter: QueueAdapter,
    runtime: IRuntimeServices,
    options: {
      defaultMaxAttempts?: number;
      pollIntervalMs?: number;
      logger?: QueueLogger | undefined;
      collector?: QueueCollector | undefined;
    },
    behaviors: readonly IIngressBehavior[],
    chainReady?: Promise<void>,
  ) {
    super(adapter, runtime, options);
    this.#behaviors = behaviors;
    this.#chainReady = chainReady;
  }

  /**
   * Registers the processor wrapped in the ingress behaviour chain.
   *
   * @typeParam T - The job payload type
   * @param name - Job name
   * @param processor - The processor being registered
   * @param options - Concurrency and failure callback, passed through
   */
  override process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void {
    super.process(
      name,
      withIngressBehaviors(processor, this.#behaviors, this.#chainReady),
      options,
    );
  }
}

/**
 * Resolves the optional logger capability so background failures have somewhere
 * to go. Returns `undefined` when no logger is registered — the queue never
 * requires one (AI_GUIDELINES: no plugin depends on another plugin).
 *
 * @param ctx - The plugin context
 * @returns A logger surface, or `undefined`
 */
function resolveLogger(ctx: IPluginContext): QueueLogger | undefined {
  if (!ctx.services.has(CAPABILITIES.LOGGER)) {
    return undefined;
  }
  const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
  return { error: (message, metadata) => logger.error(message, metadata) };
}
