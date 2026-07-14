/**
 * Queue plugin for Hono Enterprise.
 *
 * Provides background job queue capability with Memory and Redis adapters.
 *
 * @module
 */

// Re-export the IQueue contract from common
export type {
  AddJobOptions,
  IJob,
  IQueue,
  JobProcessor,
  ProcessOptions,
  RecurringOptions,
} from '@hono-enterprise/common';

// Export plugin factory and types
export { QueuePlugin } from './plugin/queue-plugin.ts';
export type { QueuePluginOptions } from './interfaces/index.ts';
export type {
  QueueAdapterType,
  RabbitMqQueueOptions,
  RedisQueueOptions,
} from './interfaces/index.ts';

// Export adapter classes
export { MemoryQueue } from './adapters/memory-queue.ts';
export { RedisQueue } from './adapters/redis-queue.ts';
export { RabbitMqQueue } from './adapters/rabbitmq-queue.ts';
