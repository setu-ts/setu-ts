/**
 * Queue plugin factory.
 *
 * Creates a plugin that registers a QueueService with the specified adapter.
 *
 * @module
 */

import type {
  HealthIndicatorFn,
  ILogger,
  IPlugin,
  IPluginContext,
  IQueue,
} from '@hono-enterprise/common';
import { CAPABILITIES, createCapabilityToken } from '@hono-enterprise/common';
import type { QueueAdapterType, QueuePluginOptions } from '../interfaces/index.ts';
import { MemoryQueue } from '../adapters/memory-queue.ts';
import { RedisQueue, validateClient as isRedisQueueClient } from '../adapters/redis-queue.ts';
import {
  RabbitMqQueue,
  validateClient as isAmqpQueueConnection,
} from '../adapters/rabbitmq-queue.ts';
import { SqsQueue } from '../adapters/sqs-queue.ts';
import { QueueService } from '../services/queue-service.ts';
import type { QueueLogger } from '../services/queue-service.ts';

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

  // Derive plugin name and token using capability token grammar
  const pluginName = name ? `queue-plugin.${name}` : 'queue-plugin';
  const token = name ? createCapabilityToken(`queue.${name}`) : 'queue';

  return {
    name: pluginName,
    version: '0.1.0',
    provides: [token],
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
          adapter = new SqsQueue(ctx.runtime, options.sqs);
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
      const service = new QueueService(adapter, runtime, {
        defaultMaxAttempts,
        pollIntervalMs,
        ...(logger !== undefined && { logger }),
      });

      // Connect the service
      await service.connect();

      // Register the service
      ctx.services.register<IQueue>(token, service);

      // Register health indicator using the same token
      const healthIndicator: HealthIndicatorFn = service.createHealthIndicator();
      ctx.health.register(token, healthIndicator);

      // Register lifecycle hook for cleanup
      ctx.lifecycle.onClose(async () => {
        await service.disconnect();
      });
    },
  };
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
