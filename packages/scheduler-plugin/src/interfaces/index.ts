/**
 * Internal interfaces and types for the scheduler plugin.
 *
 * This barrel is intentionally NOT exported from `src/index.ts` — it is an
 * internal seam used only by scheduler-plugin implementation files.
 *
 * @module
 */

/**
 * Distributed lock interface.
 *
 * Implementations acquire a lock before running a scheduled job handler
 * and release it afterward. When another instance holds the lock, the
 * fire is skipped.
 */
export interface IDistributedLock {
  /**
   * Attempt to acquire the lock.
   *
   * @param key - The lock key
   * @param ttlMs - Time-to-live in milliseconds
   * @returns A unique token if acquired, or `null` if held by another instance
   */
  acquire(key: string, ttlMs: number): Promise<string | null>;

  /**
   * Release a previously acquired lock.
   *
   * Only releases if the provided token matches the held token.
   *
   * @param key - The lock key
   * @param token - The token returned by `acquire`
   */
  release(key: string, token: string): Promise<void>;
}

/**
 * Plugin options passed to `SchedulerPlugin()`.
 */
export interface SchedulerPluginOptions {
  /**
   * Timezone for cron evaluation. Only `'UTC'` is supported in this release.
   *
   * @default 'UTC'
   */
  timezone?: string;

  /**
   * Distributed lock configuration.
   *
   * When absent or `enabled: false` a `MemoryLock` is used (process-local).
   * When `storage: 'redis'` a `RedisLock` is used for multi-instance safety.
   */
  distributedLock?: DistributedLockOptions;
}

/**
 * Options for distributed locking.
 */
export interface DistributedLockOptions {
  /** Enable distributed locking. Default `false`. */
  enabled?: boolean;

  /** Lock backend. Only `'redis'` is supported when `enabled: true`. */
  storage?: 'redis';

  /** Redis connection URL. Default `'redis://localhost:6379'`. */
  url?: string;

  /** Injected ioredis-compatible client (preferred over lazy load). */
  client?: IRedisLockClient;

  /**
   * Custom lock implementation. Takes priority over `storage` when present.
   */
  lock?: IDistributedLock;

  /**
   * Lock TTL in milliseconds. Must exceed the job's worst-case runtime.
   *
   * @default 30000
   */
  ttlMs?: number;
}

/**
 * Internal registry entry for a scheduled job.
 */
export interface RegistryEntry<T = unknown> {
  /** Unique job name (registry key). */
  name: string;
  /** Job kind. */
  kind: 'cron' | 'every' | 'delay';
  /** Cron expression (for `cron` kind). */
  expression?: string;
  /** Interval in ms (for `every` kind). */
  intervalMs?: number;
  /** Original delay in ms (for `delay` kind). */
  delayMs?: number;
  /** Handler callback. */
  handler: (job: import('@hono-enterprise/common').ScheduledJob<T>) => void | Promise<void>;
  /** Optional payload. */
  data?: T;
  /** Optional retry config. */
  retry?: import('@hono-enterprise/common').RetryOptions;
  /** Current pause state. */
  paused: boolean;
  /** Next fire time (epoch ms). */
  nextRunAtMs: number;
  /** Armed timer handle. */
  timerHandle: import('@hono-enterprise/common').TimerHandle | null;
}

/**
 * Minimal ioredis client shape required by RedisLock.
 */
export interface IRedisLockClient {
  /** SET key value [NX] [PX ttl] */
  set(key: string, value: string, option: string, ttl: number): Promise<string | null>;
  /** GET key */
  get(key: string): Promise<string | null>;
  /** DEL key */
  del(key: string): Promise<number>;
  /** Quit the connection */
  quit(): Promise<void>;
}

/**
 * Options for RedisLock construction.
 */
export interface RedisLockOptions {
  /** Redis connection URL. */
  url: string;
  /** Injected ioredis-compatible client. */
  client?: IRedisLockClient;
}
