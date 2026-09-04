import type {
  HealthIndicatorFn,
  IIngressBehavior,
  IMessageBroker,
  IPlugin,
  IPluginContext,
  ITelemetryService,
  RegistryFactory,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  createCapabilityToken,
  PLUGIN_PRIORITY,
  resolveRegistryEntry,
} from '@setu-ts/common';
import { InMemoryBroker } from '../brokers/in-memory-broker.ts';
import { RedisStreamsBroker } from '../brokers/redis-streams-broker.ts';
import { RabbitMqBroker } from '../brokers/rabbitmq-broker.ts';
import { NatsBroker } from '../brokers/nats-broker.ts';
import { KafkaBroker } from '../brokers/kafka-broker.ts';
import { GcpPubSubBroker } from '../brokers/pubsub-broker.ts';
import { ServiceBusBroker } from '../brokers/service-bus-broker.ts';
import type { MessageBrokerAdapter } from '../brokers/message-broker.ts';
import { asBrokerAdapter } from '../brokers/custom-adapter.ts';
import { TracedBroker } from '../tracing/traced-broker.ts';
import { PipelinedBroker } from '../pipeline/pipelined-broker.ts';
import { JsonSerializer } from '../serializers/json-serializer.ts';
import type {
  IAmqpConnection,
  IKafkaFactory,
  INatsConnection,
  IRedisStreamsClient,
  KafkaOptions,
  MessagingPluginOptions,
  NatsOptions,
  RabbitMqOptions,
  RedisStreamsOptions,
  SubscriptionDefinition,
  SubscriptionEntry,
} from '../interfaces/index.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/**
 * Creates a capability token for a named messaging instance.
 *
 * @param name - The instance name
 * @returns The dot-namespaced capability token
 * @throws {TypeError} If the name contains invalid characters
 */
function createNamedToken(name: string): string {
  return createCapabilityToken(`messaging.${name}`);
}

/**
 * Creates a capability token for a named messaging plugin.
 *
 * @param name - The instance name
 * @returns The plugin name for the named instance
 */
function createPluginName(name?: string): string {
  return name ? `messaging-plugin.${name}` : 'messaging-plugin';
}

/**
 * Validates the `chainReadyTimeoutMs` domain at the single point the option is
 * resolved into the chain-gate clock. `NaN`, a negative value, or `Infinity`
 * would otherwise reach `setTimeout`, which clamps them to ~0–1 ms — silently
 * INVERTING the bound into an immediate refusal of every startup-window
 * dispatch (`Infinity` intuitively means "never refuse"; a `NaN` from a bad
 * env parse would refuse everything). `0` is the documented wait-forever value
 * and is accepted.
 *
 * @param value - The configured `chainReadyTimeoutMs`
 * @returns The validated value, unchanged
 * @throws {RangeError} Naming the option unless the value is a finite,
 * non-negative number of milliseconds
 */
function assertChainReadyTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `MessagingPlugin option 'chainReadyTimeoutMs' must be a finite, ` +
        `non-negative number of milliseconds (received ${value}); 0 waits forever.`,
    );
  }
  return value;
}

/**
 * MessagingPlugin factory.
 *
 * Creates a plugin that registers an IMessageBroker implementation based on
 * the configured backend type. Supports multi-instance deployment via the
 * `name` option.
 *
 * @param options - Plugin configuration options (discriminated union on `broker`)
 * @returns A configured IPlugin instance
 *
 * @example
 * ```typescript
 * // Default in-memory broker
 * app.register(MessagingPlugin());
 *
 * // GCP Pub/Sub
 * app.register(MessagingPlugin({
 *   broker: 'pubsub',
 *   projectId: 'my-project',
 * }));
 *
 * // Azure Service Bus
 * app.register(MessagingPlugin({
 *   broker: 'service-bus',
 *   connectionString: 'Endpoint=sb://...',
 * }));
 *
 * // Custom broker instance
 * app.register(MessagingPlugin({
 *   broker: 'custom',
 *   instance: myCustomBroker,
 * }));
 * ```
 *
 * @since 0.1.0
 */
export function MessagingPlugin(
  options: MessagingPluginOptions = {},
): IPlugin {
  const brokerType: string = (options as { broker?: string }).broker ?? 'memory';
  const instanceName = (options as { name?: string }).name;
  const serializer =
    (options as { serializer?: import('../serializers/serializer.ts').ISerializer })
      .serializer ??
      new JsonSerializer();

  // Determine the token based on whether this is a named instance
  const token = instanceName ? createNamedToken(instanceName) : CAPABILITIES.MESSAGING;

  const pluginName = createPluginName(instanceName);

  // The registration arms are split ONCE, here at plugin construction, so
  // `register` and the `onInit` hook each read a single list (the M70d arm
  // pattern, M86 §3.5). Instance entries keep their pre-arm `register()`
  // timing; factories are resolved in `onInit`, the first phase at which the
  // registry holds every capability. Each factory carries the index it holds
  // in the DECLARED array, not its position among the factories: the index is
  // the only thing the error label has to point a developer at the failing
  // entry, and filtering first made it name a different — working — entry
  // whenever the two arms were mixed.
  const subscriptions: readonly SubscriptionEntry[] = options.subscriptions ?? [];
  const behaviors: readonly (IIngressBehavior | RegistryFactory<IIngressBehavior>)[] =
    options.behaviors ?? [];
  const subscriptionInstances = subscriptions.filter(
    (entry): entry is SubscriptionDefinition => typeof entry !== 'function',
  );
  const subscriptionFactories = subscriptions
    .map((entry, index) => ({ entry, index }))
    .filter(
      (slot): slot is { entry: RegistryFactory<SubscriptionDefinition>; index: number } =>
        typeof slot.entry === 'function',
    );
  const behaviorInstances = behaviors.filter(
    (entry): entry is IIngressBehavior => typeof entry !== 'function',
  );
  const behaviorFactories = behaviors
    .map((entry, index) => ({ entry, index }))
    .filter(
      (slot): slot is { entry: RegistryFactory<IIngressBehavior>; index: number } =>
        typeof slot.entry === 'function',
    );
  // The LIVE behaviour list the chain reads on every delivery. Instances are
  // available at registration; when factories exist, `onInit` replaces it
  // with the complete declared sequence before the app serves.
  const behaviorChain: IIngressBehavior[] = [...behaviorInstances];
  const declaredBehaviors = behaviors.length > 0;
  // Held while behaviour FACTORIES are still unresolved. Delivery waits on it
  // so no message reaches a handler through a partial chain; `openChainGate`
  // is called at the end of `onInit`, once `behaviorChain` is final.
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
    name: pluginName,
    version: denoJson.version,
    provides: [token],
    optionalDependencies: ['logger', CAPABILITIES.TELEMETRY],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      // Resolve optional logger
      let logger: { error: (msg: string) => void } | undefined;
      if (ctx.services.has('logger')) {
        logger = ctx.services.get('logger');
      }
      const telemetry = options.tracing !== false && ctx.services.has(CAPABILITIES.TELEMETRY)
        ? ctx.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY)
        : undefined;

      // Build the broker based on type
      let broker: MessageBrokerAdapter;

      if (brokerType === 'memory') {
        broker = new InMemoryBroker(ctx.runtime, serializer, {
          // `publish` resolves on dispatch hand-off (M89c), so a rejected
          // handler's only observable outcome is this report. The logger is
          // read at CALL time, not captured here — the M52b lesson, where a
          // logger captured at register() silenced every later report.
          onDispatchError: (error, metadata) => {
            const logger = ctx.services.has('logger')
              ? ctx.services.get<{ error: (msg: string) => void }>('logger')
              : undefined;
            const detail = error instanceof Error ? error.message : String(error);
            logger?.error(
              `In-memory broker handler rejected for topic "${metadata.topic}" ` +
                `(messageId: ${metadata.messageId}): ${detail}`,
            );
          },
        });
      } else if (brokerType === 'redis-streams') {
        const opts = options as {
          url?: string;
          client?: IRedisStreamsClient;
          defaultQueue?: string;
          pollIntervalMs?: number;
          blockSizeMs?: number;
        };
        const redisOptions: RedisStreamsOptions = {};
        if (opts.url !== undefined) redisOptions.url = opts.url;
        if (opts.client !== undefined) redisOptions.client = opts.client;
        if (opts.defaultQueue !== undefined) redisOptions.defaultQueue = opts.defaultQueue;
        if (opts.pollIntervalMs !== undefined) redisOptions.pollIntervalMs = opts.pollIntervalMs;
        if (opts.blockSizeMs !== undefined) redisOptions.blockSizeMs = opts.blockSizeMs;
        if (logger !== undefined) redisOptions.logger = logger;
        broker = new RedisStreamsBroker(ctx.runtime, serializer, redisOptions);
      } else if (brokerType === 'rabbitmq') {
        const opts = options as {
          url?: string;
          client?: IAmqpConnection;
          exchangeName?: string;
          defaultQueue?: string;
        };
        const rabbitOptions: RabbitMqOptions = {};
        if (opts.url !== undefined) rabbitOptions.url = opts.url;
        if (opts.client !== undefined) rabbitOptions.client = opts.client;
        if (opts.exchangeName !== undefined) rabbitOptions.exchangeName = opts.exchangeName;
        if (opts.defaultQueue !== undefined) rabbitOptions.defaultQueue = opts.defaultQueue;
        if (logger !== undefined) rabbitOptions.logger = logger;
        broker = new RabbitMqBroker(ctx.runtime, serializer, rabbitOptions);
      } else if (brokerType === 'nats') {
        const opts = options as {
          url?: string;
          client?: INatsConnection;
          streamName?: string;
          defaultQueue?: string;
          headersFactory?: NatsOptions['headersFactory'];
        };
        const natsOptions: NatsOptions = {};
        if (opts.url !== undefined) natsOptions.url = opts.url;
        if (opts.client !== undefined) natsOptions.client = opts.client;
        if (opts.streamName !== undefined) natsOptions.streamName = opts.streamName;
        if (opts.defaultQueue !== undefined) natsOptions.defaultQueue = opts.defaultQueue;
        if (opts.headersFactory !== undefined) natsOptions.headersFactory = opts.headersFactory;
        if (logger !== undefined) natsOptions.logger = logger;
        broker = new NatsBroker(ctx.runtime, serializer, natsOptions);
      } else if (brokerType === 'kafka') {
        const opts = options as {
          brokers?: readonly string[];
          client?: IKafkaFactory;
          clientId?: string;
          defaultQueue?: string;
          replyTopic?: string;
        };
        const kafkaOptions: KafkaOptions = {};
        if (opts.brokers !== undefined) kafkaOptions.brokers = opts.brokers;
        if (opts.client !== undefined) kafkaOptions.client = opts.client;
        if (opts.clientId !== undefined) kafkaOptions.clientId = opts.clientId;
        if (opts.defaultQueue !== undefined) kafkaOptions.defaultQueue = opts.defaultQueue;
        if (opts.replyTopic !== undefined) kafkaOptions.replyTopic = opts.replyTopic;
        if (logger !== undefined) kafkaOptions.logger = logger;
        broker = new KafkaBroker(ctx.runtime, serializer, kafkaOptions);
      } else if (brokerType === 'pubsub') {
        const pubSubOpts = options as {
          projectId?: string;
          credentials?: unknown;
          client?: import('../brokers/pubsub-broker.ts').IPubSubTransport;
          defaultQueue?: string;
          replyTopic?: string;
        };
        const pubSubOptions: import('../brokers/pubsub-broker.ts').PubSubOptions = {};
        if (pubSubOpts.projectId !== undefined) pubSubOptions.projectId = pubSubOpts.projectId;
        if (pubSubOpts.credentials !== undefined) {
          pubSubOptions.credentials = pubSubOpts.credentials;
        }
        if (pubSubOpts.client !== undefined) pubSubOptions.client = pubSubOpts.client;
        if (pubSubOpts.defaultQueue !== undefined) {
          pubSubOptions.defaultQueue = pubSubOpts.defaultQueue;
        }
        if (pubSubOpts.replyTopic !== undefined) pubSubOptions.replyTopic = pubSubOpts.replyTopic;
        if (logger !== undefined) pubSubOptions.logger = logger;
        broker = new GcpPubSubBroker(ctx.runtime, serializer, pubSubOptions);
      } else if (brokerType === 'service-bus') {
        const serviceBusOpts = options as {
          connectionString?: string;
          adminConnectionString?: string;
          client?: import('../brokers/service-bus-broker.ts').IServiceBusTransport;
          defaultQueue?: string;
          replyTopic?: string;
        };
        const serviceBusOptions: import('../brokers/service-bus-broker.ts').ServiceBusOptions = {};
        if (serviceBusOpts.connectionString !== undefined) {
          serviceBusOptions.connectionString = serviceBusOpts.connectionString;
        }
        if (serviceBusOpts.adminConnectionString !== undefined) {
          serviceBusOptions.adminConnectionString = serviceBusOpts.adminConnectionString;
        }
        if (serviceBusOpts.client !== undefined) serviceBusOptions.client = serviceBusOpts.client;
        if (serviceBusOpts.defaultQueue !== undefined) {
          serviceBusOptions.defaultQueue = serviceBusOpts.defaultQueue;
        }
        if (serviceBusOpts.replyTopic !== undefined) {
          serviceBusOptions.replyTopic = serviceBusOpts.replyTopic;
        }
        if (logger !== undefined) serviceBusOptions.logger = logger;
        broker = new ServiceBusBroker(ctx.runtime, serializer, serviceBusOptions);
      } else if (brokerType === 'custom') {
        const opts = options as { instance: IMessageBroker };
        broker = asBrokerAdapter(opts.instance);
      } else {
        throw new Error(`Unknown broker type: ${brokerType}`);
      }

      // Connect the broker (async for Redis)
      await broker.connect();

      if (telemetry) {
        broker = new TracedBroker(broker, telemetry, brokerType);
      }

      // M86 §3.8: ONE decorator composes the behaviour chain inside
      // `subscribe`/`subscribeWithHeaders` for every broker arm — the broker
      // constructors above are untouched. Applied ONLY when at least one
      // behaviour is configured, so the zero-configuration broker chain is
      // byte-identical to the pre-arm behaviour (§3.9). The chain reads the
      // live list, so `onInit`-resolved factory behaviours also wrap
      // subscriptions registered here.
      if (declaredBehaviors) {
        // The gate exists only when a FACTORY is declared: with instances
        // alone the chain is already final here and delivery is never
        // deferred. It closes the startup window for EVERY subscription —
        // this plugin's own declared entries and any a later plugin makes
        // imperatively through the registered broker — so no registration's
        // timing has to change.
        broker = behaviorFactories.length === 0
          ? new PipelinedBroker(broker, behaviorChain)
          : new PipelinedBroker(broker, behaviorChain, chainReady, {
            runtime: ctx.runtime,
            // exactOptionalPropertyTypes: omit the option when unset so the
            // broker applies its own default bound. The value is validated
            // where it resolves into the clock — a `NaN`/negative/`Infinity`
            // bound would reach `setTimeout` and clamp to ~0, refusing every
            // held dispatch instead of bounding the wait.
            ...(options.chainReadyTimeoutMs !== undefined
              ? { timeoutMs: assertChainReadyTimeoutMs(options.chainReadyTimeoutMs) }
              : {}),
          });
      }

      // Register the broker as IMessageBroker
      ctx.services.register<IMessageBroker>(token, broker);

      // Declared subscription INSTANCES register now, exactly as an
      // imperative `broker.subscribe()` call made before this arm existed
      // (M86 §3.5) — and they coexist with imperative subscriptions.
      //
      // UNLESS a behaviour FACTORY is declared. A subscription goes live the
      // moment it is established against the already-connected broker, and a
      // broker holding a backlog delivers immediately — so a message arriving
      // before `onInit` resolved the factory behaviours would reach the
      // handler through a PARTIAL chain, skipping exactly the behaviours that
      // needed a resolved capability. Deferring the whole set into the same
      // `onInit` hook, after the chain is final, is what makes the arm's
      // guarantee true. With no factory declared the chain is already
      // complete here and the timing is unchanged.
      for (const definition of subscriptionInstances) {
        await subscribeDefinition(broker, definition);
      }

      // Register health indicator. M70c: reports BOTH signals. `isReady()` is
      // lifecycle (never started / shut down → `down`); `reachability()` is
      // reachability (the backend answers right now). A ready-but-unreachable
      // broker is `down` with `data.reachable: false` — the distinction an
      // operator needs to tell "we never started" from "the broker restarted
      // under us". An unprobeable broker (custom arm without `isHealthy`) is
      // `up` with `data.reachable: 'unknown'`, honestly reporting "we did not
      // check".
      const healthIndicator: HealthIndicatorFn = async () => {
        if (!broker.isReady()) {
          return { status: 'down', data: { broker: brokerType, reachable: false } };
        }
        const reachable = await broker.reachability();
        if (reachable === false) {
          return { status: 'down', data: { broker: brokerType, reachable: false } };
        }
        if (reachable === undefined) {
          return { status: 'up', data: { broker: brokerType, reachable: 'unknown' } };
        }
        return { status: 'up', data: { broker: brokerType, reachable: true } };
      };
      ctx.health.register(token, healthIndicator);

      // Register close handler
      ctx.lifecycle.onClose(async () => {
        await broker.disconnect();
      });

      // Factory entries resolve at `onInit` — the first phase at which the
      // registry holds every capability, and still before the application
      // serves. Each `subscribe()` is AWAITED there so a declared subscription
      // is established before the app accepts traffic (M86 §3.5). A throwing
      // factory rejects `start()` naming the option and the entry's DECLARED
      // index. The hook is registered only when a factory is configured: with
      // instances alone there is nothing to resolve, so a zero-factory
      // configuration gains no lifecycle hook at all.
      if (subscriptionFactories.length > 0 || behaviorFactories.length > 0) {
        ctx.lifecycle.onInit(async () => {
          try {
            // The chain is completed FIRST, before any factory subscription is
            // established below, so nothing ever subscribes against a partial
            // chain.
            behaviorChain.splice(
              0,
              behaviorChain.length,
              ...behaviors.map((entry, index) =>
                typeof entry === 'function'
                  ? resolveRegistryEntry(
                    entry,
                    ctx.services,
                    `MessagingPlugin({ behaviors })[${index}]`,
                  )
                  : entry
              ),
            );

            for (const slot of subscriptionFactories) {
              const definition = resolveRegistryEntry(
                slot.entry,
                ctx.services,
                `MessagingPlugin({ subscriptions })[${slot.index}]`,
              );
              await subscribeDefinition(broker, definition);
            }

            // LAST: the chain is final, so any delivery held during startup may
            // now proceed. A hook that threw above never reaches this, leaving
            // the gate closed — which is correct, since `start()` has failed and
            // delivering through a partial chain is what this prevents.
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
 * Registers one declarative subscription — the declarative form of exactly
 * one imperative `broker.subscribe()` call (M86 §3.5).
 *
 * @param broker - The broker the plugin registered (already wrapped with
 * `TracedBroker`/`PipelinedBroker` when configured)
 * @param definition - The definition to register
 * @returns Resolves when the subscription is established
 */
async function subscribeDefinition(
  broker: IMessageBroker,
  definition: SubscriptionDefinition,
): Promise<void> {
  await broker.subscribe(definition.topic, definition.handler, definition.options);
}
