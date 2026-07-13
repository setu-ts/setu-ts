/**
 * Queue plugin interfaces and types.
 *
 * @module
 */

/**
 * Structural client type for Redis operations used by RedisQueue.
 *
 * Mirrors the IRedisStreamsClient pattern from messaging-plugin.
 * Intentionally not barrel-exported.
 */
export interface IRedisQueueClient {
  /** Add a member to a sorted set. */
  zadd(key: string, score: number, member: string): Promise<number>;
  /** Get members with scores in a range by score. */
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    offset?: number,
    limit?: number,
  ): Promise<string[]>;
  /** Remove members from a sorted set. */
  zrem(key: string, ...members: string[]): Promise<number>;
  /** Set a hash field. */
  hset(key: string, field: string, value: string): Promise<number>;
  /** Get a hash field. */
  hget(key: string, field: string): Promise<string | null>;
  /** Delete hash fields. */
  hdel(key: string, ...fields: string[]): Promise<number>;
  /** Delete a key. */
  del(...keys: string[]): Promise<number>;
  /** Connect to Redis (optional). */
  connect?(): Promise<void>;
  /** Close the connection. */
  quit(): Promise<void>;
}

/**
 * A job stored in the queue adapter.
 *
 * Intentionally not barrel-exported.
 */
export interface StoredJob<T = unknown> {
  /** Job ID. */
  id: string;
  /** Job name. */
  name: string;
  /** Job payload. */
  data: T;
  /** Current attempt count. */
  attempts: number;
  /** Maximum attempts allowed. */
  maxAttempts: number;
  /** Timestamp when the job becomes available (ms since epoch). */
  availableAtMs: number;
}

/**
 * A recurring job stored in the queue adapter.
 *
 * Intentionally not barrel-exported.
 */
export interface StoredRecurring {
  /** Recurring job ID. */
  id: string;
  /** Job name. */
  name: string;
  /** Job payload. */
  data: unknown;
  /** Cron expression. */
  cron: string;
  /** Next run timestamp (ms since epoch). */
  nextRunAtMs: number;
}

/**
 * Queue adapter type for plugin configuration.
 */
export type QueueAdapterType = 'memory' | 'redis';

/**
 * Options for configuring the queue plugin.
 */
export interface QueuePluginOptions {
  /** The adapter type to use (default 'memory'). */
  adapter?: QueueAdapterType;
  /** Instance name for multi-instance support. */
  name?: string;
  /** Redis connection URL (used when adapter is 'redis'). */
  url?: string;
  /** Injected Redis client (bypasses lazy import). */
  client?: IRedisQueueClient;
  /** Default max attempts for jobs (default 3). */
  defaultMaxAttempts?: number;
  /** Poll interval for worker loop (default 1000ms). */
  pollIntervalMs?: number;
}

/**
 * Options for configuring RedisQueue.
 */
export interface RedisQueueOptions {
  /** Redis connection URL (default 'redis://localhost:6379'). */
  url?: string;
  /** Injected Redis client (bypasses lazy import). */
  client?: IRedisQueueClient;
}
