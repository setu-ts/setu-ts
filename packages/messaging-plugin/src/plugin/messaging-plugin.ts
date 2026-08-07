import type { HealthIndicatorFn, IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { InMemoryBroker } from '../brokers/in-memory-broker.ts';
import { RedisStreamsBroker } from '../brokers/redis-streams-broker.ts';
import { RabbitMqBroker } from '../brokers/rabbitmq-broker.ts';
import { NatsBroker } from '../brokers/nats-broker.ts';
import { KafkaBroker } from '../brokers/kafka-broker.ts';
import { GcpPubSubBroker } from '../brokers/pubsub-broker.ts';
import { ServiceBusBroker } from '../brokers/service-bus-broker.ts';
import type { MessageBrokerAdapter } from '../brokers/message-broker.ts';
import { asBrokerAdapter } from '../brokers/custom-adapter.ts';
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
} from '../interfaces/index.ts';

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

  return {
    name: pluginName,
    version: '0.1.0',
    provides: [token],
    optionalDependencies: ['logger'],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      // Resolve optional logger
      let logger: { error: (msg: string) => void } | undefined;
      if (ctx.services.has('logger')) {
        logger = ctx.services.get('logger');
      }

      // Build the broker based on type
      let broker: MessageBrokerAdapter;

      if (brokerType === 'memory') {
        broker = new InMemoryBroker(ctx.runtime, serializer);
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
        };
        const natsOptions: NatsOptions = {};
        if (opts.url !== undefined) natsOptions.url = opts.url;
        if (opts.client !== undefined) natsOptions.client = opts.client;
        if (opts.streamName !== undefined) natsOptions.streamName = opts.streamName;
        if (opts.defaultQueue !== undefined) natsOptions.defaultQueue = opts.defaultQueue;
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

      // Register the broker as IMessageBroker
      ctx.services.register<IMessageBroker>(token, broker);

      // Register health indicator
      // deno-lint-ignore require-await
      const healthIndicator: HealthIndicatorFn = async () => {
        return {
          status: broker.isReady() ? 'up' : 'down',
          data: { broker: brokerType },
        };
      };
      ctx.health.register(token, healthIndicator);

      // Register close handler
      ctx.lifecycle.onClose(async () => {
        await broker.disconnect();
      });
    },
  };
}
