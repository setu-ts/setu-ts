import type { HealthIndicatorFn, IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { IMessageBroker } from '@hono-enterprise/common';
import { InMemoryBroker } from '../brokers/in-memory-broker.ts';
import { RedisStreamsBroker } from '../brokers/redis-streams-broker.ts';
import type { MessageBrokerAdapter } from '../brokers/message-broker.ts';
import { JsonSerializer } from '../serializers/json-serializer.ts';
import type { IRedisStreamsClient, MessagingPluginOptions } from '../interfaces/index.ts';

/**
 * Creates a capability token for a named messaging instance.
 *
 * @param name - The instance name
 * @returns The dot-namespaced capability token
 */
function createNamedToken(name: string): string {
  return `messaging.${name}`;
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
 * @param options - Plugin configuration options
 * @returns A configured IPlugin instance
 *
 * @example
 * ```typescript
 * // Default in-memory broker
 * app.register(MessagingPlugin({ broker: 'memory' }));
 *
 * // Redis Streams broker
 * app.register(MessagingPlugin({
 *   broker: 'redis-streams',
 *   url: 'redis://localhost:6379',
 * }));
 *
 * // Named instance for multi-broker setup
 * app.register(MessagingPlugin({
 *   name: 'events',
 *   broker: 'redis-streams',
 * }));
 * ```
 *
 * @since 0.1.0
 */
export function MessagingPlugin(
  options: MessagingPluginOptions = {},
): IPlugin {
  const brokerType = options.broker ?? 'memory';
  const instanceName = options.name;
  const serializer = options.serializer ?? new JsonSerializer();

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
        // Build options object only with defined values to satisfy exactOptionalPropertyTypes
        const redisOptions: {
          url?: string;
          client?: IRedisStreamsClient;
          defaultQueue?: string;
          pollIntervalMs?: number;
          blockSizeMs?: number;
          logger?: { error: (msg: string) => void };
        } = {};
        if (options.url !== undefined) redisOptions.url = options.url;
        if (options.client !== undefined) redisOptions.client = options.client;
        if (options.defaultQueue !== undefined) redisOptions.defaultQueue = options.defaultQueue;
        if (options.pollIntervalMs !== undefined) {
          redisOptions.pollIntervalMs = options.pollIntervalMs;
        }
        if (options.blockSizeMs !== undefined) redisOptions.blockSizeMs = options.blockSizeMs;
        if (logger !== undefined) redisOptions.logger = logger;
        broker = new RedisStreamsBroker(ctx.runtime, serializer, redisOptions);
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
