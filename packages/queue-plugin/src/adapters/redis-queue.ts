/**
 * Redis queue adapter implementation.
 *
 * Uses Redis sorted sets (ZSET) and hashes (HASH) for delayed job storage.
 * Follows the inject-or-lazy pattern from RedisStreamsBroker and RedisStore.
 *
 * @module
 */

import type { QueueAdapter } from './queue-adapter.ts';
import type {
  IRedisQueueClient,
  RedisQueueOptions,
  StoredJob,
  StoredRecurring,
} from '../interfaces/index.ts';

/**
 * Lazily load ioredis at runtime. Pin to 5.x for stability.
 *
 * @returns The ioredis constructor
 * @throws {Error} If the npm:ioredis package cannot be resolved
 */
async function loadIoredis(): Promise<typeof import('npm:ioredis@5.x').Redis> {
  const mod = await import('npm:ioredis@5.x');
  return mod.Redis;
}

/**
 * Validate that the supplied object has the structural shape required by
 * RedisQueue. Checks the exact Redis commands used.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IRedisQueueClient {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['zadd', 'zrangebyscore', 'zrem', 'hset', 'hget', 'hdel', 'del', 'quit'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the Redis client: prefer injected `options.client`, then lazy-load
 * ioredis from npm.
 *
 * @param url - Redis connection URL
 * @param injectedClient - Optionally injected ioredis-compatible client
 * @returns The resolved client instance
 * @throws {Error} If no client injected and ioredis cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: IRedisQueueClient,
): Promise<IRedisQueueClient> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected Redis client does not match the required structural shape ' +
          '(needs: zadd, zrangebyscore, zrem, hset, hget, hdel, del, quit)',
      );
    }
    return injectedClient;
  }
  const RedisCtor = await loadIoredis();
  return new RedisCtor(url) as unknown as IRedisQueueClient;
}

/**
 * Redis queue adapter implementation.
 *
 * Uses Redis sorted sets (ZSET) for ready/processing/dead sets and
 * hashes (HASH) for job payloads. Implements the claim-based reserve
 * pattern to prevent double-dispatch.
 *
 * Key structure per job name:
 * - `queue:<name>:ready` - ZSET (score = availableAtMs, member = jobId)
 * - `queue:<name>:processing` - ZSET (score = reservedAtMs, member = jobId)
 * - `queue:<name>:dead` - ZSET (score = deadLetterAtMs, member = jobId)
 * - `queue:<name>:jobs` - HASH (field = jobId, value = JSON job)
 *
 * Recurring jobs:
 * - `queue:recurring:due` - ZSET (score = nextRunAtMs, member = recurringId)
 * - `queue:recurring:jobs` - HASH (field = recurringId, value = JSON recurring)
 *
 * @since 0.1.0
 */
export class RedisQueue implements QueueAdapter {
  #client: IRedisQueueClient | null = null;
  #url: string;
  #injectedClient: IRedisQueueClient | undefined;
  #ready = false;

  constructor(options?: RedisQueueOptions) {
    this.#url = options?.url ?? 'redis://localhost:6379';
    this.#injectedClient = options?.client;
  }

  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#client = await resolveClient(this.#url, this.#injectedClient);
    if (typeof this.#client.connect === 'function') {
      await this.#client.connect();
    }
    this.#ready = true;
  }

  async disconnect(): Promise<void> {
    if (this.#client) {
      await this.#client.quit();
    }
    this.#client = null;
    this.#ready = false;
  }

  isReady(): boolean {
    return this.#ready;
  }

  async enqueue<T>(job: StoredJob<T>): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const readyKey = `queue:${job.name}:ready`;
    const jobsKey = `queue:${job.name}:jobs`;

    // Store job payload
    await this.#client.hset(jobsKey, job.id, JSON.stringify(job));

    // Add to ready set with score = availableAtMs
    await this.#client.zadd(readyKey, job.availableAtMs, job.id);
  }

  async reserve<T>(name: string, limit: number, nowMs: number): Promise<readonly StoredJob<T>[]> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const readyKey = `queue:${name}:ready`;
    const processingKey = `queue:${name}:processing`;
    const jobsKey = `queue:${name}:jobs`;

    // Get due jobs (score <= nowMs)
    const dueIds = await this.#client.zrangebyscore(readyKey, '-inf', nowMs, 0, limit);

    if (dueIds.length === 0) {
      return [];
    }

    const jobs: StoredJob<T>[] = [];

    // For each due job: remove from ready, add to processing, fetch payload
    for (const id of dueIds) {
      // Remove from ready
      await this.#client.zrem(readyKey, id);

      // Add to processing with score = nowMs (reserved timestamp)
      await this.#client.zadd(processingKey, nowMs, id);

      // Fetch payload
      const raw = await this.#client.hget(jobsKey, id);
      if (raw) {
        const job = JSON.parse(raw) as StoredJob<T>;
        jobs.push(job);
      }
    }

    return jobs as readonly StoredJob<T>[];
  }

  async ack(name: string, id: string): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const processingKey = `queue:${name}:processing`;
    const jobsKey = `queue:${name}:jobs`;

    // Remove from processing
    await this.#client.zrem(processingKey, id);

    // Optionally delete job payload (could keep for debugging)
    await this.#client.hdel(jobsKey, id);
  }

  async requeue<T>(
    name: string,
    id: string,
    availableAtMs: number,
    attempts: number,
  ): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const processingKey = `queue:${name}:processing`;
    const readyKey = `queue:${name}:ready`;
    const jobsKey = `queue:${name}:jobs`;

    // Fetch current job
    const raw = await this.#client.hget(jobsKey, id);
    if (!raw) {
      return;
    }

    const job = JSON.parse(raw) as StoredJob<T>;

    // Update job
    const updated: StoredJob<T> = { ...job, availableAtMs, attempts };

    // Update payload
    await this.#client.hset(jobsKey, id, JSON.stringify(updated));

    // Remove from processing
    await this.#client.zrem(processingKey, id);

    // Add back to ready with new score
    await this.#client.zadd(readyKey, availableAtMs, id);
  }

  async deadLetter(name: string, id: string, nowMs: number): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const processingKey = `queue:${name}:processing`;
    const deadKey = `queue:${name}:dead`;

    // Remove from processing
    await this.#client.zrem(processingKey, id);

    // Add to dead set with score = nowMs (keep payload in jobs hash for debugging)
    await this.#client.zadd(deadKey, nowMs, id);
  }

  async storeRecurring(rec: StoredRecurring): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const dueKey = 'queue:recurring:due';
    const jobsKey = 'queue:recurring:jobs';

    // Store recurring job
    await this.#client.hset(jobsKey, rec.id, JSON.stringify(rec));

    // Add to due set with score = nextRunAtMs
    await this.#client.zadd(dueKey, rec.nextRunAtMs, rec.id);
  }

  async fetchRecurringDue(nowMs: number): Promise<readonly StoredRecurring[]> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const dueKey = 'queue:recurring:due';
    const jobsKey = 'queue:recurring:jobs';

    // Get due recurring jobs
    const dueIds = await this.#client.zrangebyscore(dueKey, '-inf', nowMs);

    const recs: StoredRecurring[] = [];
    for (const id of dueIds) {
      const raw = await this.#client.hget(jobsKey, id);
      if (raw) {
        recs.push(JSON.parse(raw) as StoredRecurring);
      }
    }

    return recs as readonly StoredRecurring[];
  }

  async advanceRecurring(id: string, nextRunAtMs: number): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const dueKey = 'queue:recurring:due';
    const jobsKey = 'queue:recurring:jobs';

    // Fetch current recurring job
    const raw = await this.#client.hget(jobsKey, id);
    if (!raw) {
      return;
    }

    const rec = JSON.parse(raw) as StoredRecurring;

    // Update
    const updated: StoredRecurring = { ...rec, nextRunAtMs };
    await this.#client.hset(jobsKey, id, JSON.stringify(updated));

    // Update score in due set
    await this.#client.zadd(dueKey, nextRunAtMs, id);
  }
}
