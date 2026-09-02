/**
 * @module
 *
 * Queue plugin for Setu-TS.
 *
 * Provides background job queue capability with Memory, Redis, RabbitMQ,
 * and SQS adapters, plus an SNS publisher for fan-out messaging.
 */

// Re-export the IQueue contract from common
export type {
  AddJobOptions,
  IJob,
  IQueue,
  JobProcessor,
  ProcessOptions,
  RecurringOptions,
} from '@setu-ts/common';

// Export plugin factory and types
export { QueuePlugin } from './plugin/queue-plugin.ts';
export type { QueuePluginOptions } from './interfaces/index.ts';
export type {
  QueueAdapterType,
  QueueProcessorDefinition,
  QueueProcessorEntry,
  RabbitMqQueueOptions,
  RedisQueueOptions,
} from './interfaces/index.ts';

// Export adapter classes
export type { QueueLogger } from './services/queue-service.ts';

/**
 * The shape of the per-name depths the `queue` health indicator publishes.
 *
 * Exported because it appears in a PUBLIC signature — `MemoryQueue.depths` and
 * `RedisQueue.depths` are methods on barrel-exported classes, and a type a
 * consumer can see but cannot name is the defect M52c found on
 * `NormalizedQuery`.
 */
export type { QueueDepths } from './adapters/queue-adapter.ts';

export { MemoryQueue } from './adapters/memory-queue.ts';
export { RedisQueue } from './adapters/redis-queue.ts';
export { RabbitMqQueue } from './adapters/rabbitmq-queue.ts';
export { SqsQueue } from './adapters/sqs-queue.ts';

// SNS publisher
export { SnsPublisher } from './sns/sns-publisher.ts';
export type { SnsPublisherOptions } from './sns/sns-publisher.ts';

// SQS adapter types
export type { SqsQueueOptions } from './adapters/sqs-queue.ts';
export type { ISqsTransport, SqsReceivedMessage, SqsSdkModule } from './adapters/sqs-queue.ts';

// SNS transport types
export type { ISnsTransport, SnsSdkModule } from './sns/sns-publisher.ts';

// Adapter / load helpers
export { adaptSqsModule, loadSqsModule } from './adapters/sqs-queue.ts';
export { adaptSnsModule, loadSnsModule } from './sns/sns-publisher.ts';

// Error classes
export {
  QueueBackendUnavailableError,
  SqsDelayTooLongError,
  SqsQueueNotConfiguredError,
} from './errors.ts';
