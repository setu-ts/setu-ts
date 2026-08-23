/**
 * Redis queue adapter implementation.
 *
 * Uses Redis sorted sets (ZSET) and hashes (HASH) for delayed job storage.
 * Follows the inject-or-lazy pattern from RedisStreamsBroker and RedisStore.
 *
 * @module
 */

import type { QueueAdapter, QueueDepths } from './queue-adapter.ts';
import type {
  IRedisQueueClient,
  RedisQueueOptions,
  StoredJob,
  StoredRecurring,
} from '../interfaces/index.ts';

/**
 * The client shape the retention path needs: `expire` is optional on the
 * facade, so a fake without it still type-checks, and the retention helpers
 * only ever run once {@link RedisQueue} has established it is there.
 */
type RetentionCommands = { expire: NonNullable<IRedisQueueClient['expire']> };

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

/** Constructs an ioredis client without opening its socket before connect(). */
export function createLazyRedisClient(
  RedisCtor: new (url: string, options: { readonly lazyConnect: true }) => unknown,
  url: string,
): IRedisQueueClient {
  return new RedisCtor(url, { lazyConnect: true }) as IRedisQueueClient;
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
  return createLazyRedisClient(RedisCtor, url);
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
 * - `queue:<name>:dead:jobs` - HASH (dead payloads; only when a TTL is configured)
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
  /** Retention for a dead-lettered job's payload; unbounded when undefined. */
  #deadLetterTtlMs: number | undefined;
  #ready = false;
  /**
   * M70c: present only when the client exposes `ping()`; its absence is
   * *unknown* reachability, not `false` (a minimal injected fake has not told
   * us the server is dead).
   *
   * @since 0.1.0
   */
  isHealthy?: () => Promise<boolean>;

  constructor(options?: RedisQueueOptions) {
    this.#url = options?.url ?? 'redis://localhost:6379';
    this.#injectedClient = options?.client;
    this.#deadLetterTtlMs = options?.deadLetterTtlMs;
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
    this.#installProbe();
    this.#installDepths();
  }

  /**
   * M70c: installs `isHealthy` from the client's `ping()` when present; leaves
   * it absent (unknown) otherwise.
   */
  #installProbe(): void {
    const client = this.#client;
    if (client !== null && typeof client.ping === 'function') {
      const ping = client.ping;
      this.isHealthy = async (): Promise<boolean> => {
        try {
          // ioredis `ping` reads `this.options` — an unbound call throws
          // `TypeError: Cannot read properties of undefined (reading 'options')`
          // and `isHealthy()` would report `false` forever against a healthy server.
          await ping.call(client);
          return true;
        } catch {
          return false;
        }
      };
    } else {
      delete this.isHealthy;
    }
  }

  async disconnect(): Promise<void> {
    if (this.#client) {
      await this.#client.quit();
    }
    this.#client = null;
    this.#ready = false;
    delete this.isHealthy;
    delete this.depths;
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
    const dueIds = await this.#client.zrangebyscore(readyKey, '-inf', nowMs, 'LIMIT', 0, limit);

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

  async ack(name: string, id: string, _claimToken?: string): Promise<void> {
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
    _claimToken?: string,
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

  async deadLetter(name: string, id: string, nowMs: number, _claimToken?: string): Promise<void> {
    if (!this.#client) {
      throw new Error('RedisQueue is not connected');
    }

    const processingKey = `queue:${name}:processing`;
    const deadKey = `queue:${name}:dead`;

    // Remove from processing
    await this.#client.zrem(processingKey, id);

    // X8-4: the retained payload had no TTL and no trim, so the jobs hash grew
    // without bound for the lifetime of the deployment. The TTL is opt-in
    // because dropping a dead job's payload by default would remove the
    // debugging value the retention exists for.
    //
    // The payload moves BEFORE the dead-set insert. These commands are not one
    // atomic unit, so ordering is what keeps a concurrent sweep consistent: a
    // sweep reads the dead set, and reaching a member whose payload has not
    // been written yet deletes the member and leaves the payload behind with
    // nothing that can ever find it again.
    await this.#moveDeadLetterPayload(name, id);

    // Add to dead set with score = nowMs (keep payload in jobs hash for debugging)
    await this.#client.zadd(deadKey, nowMs, id);

    await this.#sweepDeadLetters(name, nowMs);
  }

  /**
   * Moves a dead job's payload out of the LIVE jobs hash, when a TTL is set.
   *
   * The payload goes into a dedicated `queue:<name>:dead:jobs`, and the expiry
   * {@link RedisQueue.#sweepDeadLetters} applies lands on that key and the dead
   * set — never on `queue:<name>:jobs`. That hash holds the payload of every
   * job for this name, not only dead ones, so expiring it destroys work that is
   * merely queued: Redis keeps a key's TTL across later `HSET`s (measured), so
   * jobs enqueued after the first dead-letter inherit the countdown, and
   * `reserve` drops a job whose payload is missing into the processing set and
   * never returns it. That is silent, permanent loss of queued work — caused by
   * an option whose purpose is bounding DEAD payloads.
   *
   * Issued BEFORE the caller's `ZADD` into the dead set. None of these commands
   * is atomic with the next, and a sweep reads the dead set, so a member that
   * became visible before its payload was written can be swept by a concurrent
   * `deadLetter` — deleting the member and stranding the payload where no later
   * sweep can reach it, since every sweep starts from the dead set. Writing
   * first means a sweep either misses the id entirely, and a later one collects
   * it, or finds both together.
   *
   * A no-op when no TTL is configured, and when the injected client does not
   * expose `expire` — the member is optional so an existing fake still
   * type-checks, and reporting a retention the client cannot enforce would be
   * worse than not applying one. Without a TTL the payload stays in the jobs
   * hash exactly as it always has.
   *
   * @param name - Job name
   * @param id - The dead-lettered job's id
   */
  async #moveDeadLetterPayload(name: string, id: string): Promise<void> {
    const retention = this.#retention();
    if (retention === null) {
      return;
    }
    const { client } = retention;
    const jobsKey = `queue:${name}:jobs`;
    const deadJobsKey = `queue:${name}:dead:jobs`;

    // Move the payload out of the LIVE hash: that key holds every queued job's
    // payload for this name, so it can carry no expiry of its own.
    const raw = await client.hget(jobsKey, id);
    if (raw !== null) {
      await client.hset(deadJobsKey, id, raw);
      await client.hdel(jobsKey, id);
    }
  }

  /**
   * Drops every dead-letter that has outlived the retention, and re-arms the
   * key-level backstop.
   *
   * Retention is enforced PER PAYLOAD, by sweeping the dead set — which is
   * scored by dead-letter time — for members older than the TTL and deleting
   * both the member and its payload. Redis has no per-member expiry on a sorted
   * set or a hash, and a key-level `EXPIRE` alone is not equivalent: every new
   * dead-letter renews it, so a queue that keeps failing would retain its
   * oldest payloads forever, which is the opposite of what the option promises
   * and the case where growth actually matters.
   *
   * The key-level expiry is kept BESIDE the sweep, as the backstop for the one
   * case the sweep cannot reach: a queue that dead-letters once and then goes
   * quiet never runs another sweep, so without it that last payload would
   * outlive its retention indefinitely.
   *
   * Together they bound retention rather than pin it: a payload lives at least
   * the TTL, and at most the TTL past the LAST dead-letter — just under twice
   * it for one that dies immediately before a burst that then stops. The
   * backstop is armed from `nowMs` and not from the oldest survivor because one
   * key carries one deadline, and the oldest survivor's would delete the newer
   * payloads sharing the key before their own retention elapsed. Erring late is
   * the deliberate side: an early drop destroys the debugging data the option
   * exists to keep. Exact per-payload expiry is not available — Redis has no
   * per-member TTL on a sorted set, and every payload shares the dead-jobs key.
   *
   * @param name - Job name
   * @param nowMs - Wall-clock time of this dead-letter, the sweep's reference
   */
  async #sweepDeadLetters(name: string, nowMs: number): Promise<void> {
    const retention = this.#retention();
    if (retention === null) {
      return;
    }
    const { client, ttlMs } = retention;
    const deadKey = `queue:${name}:dead`;
    const deadJobsKey = `queue:${name}:dead:jobs`;

    // Sweep whatever has now outlived the retention.
    const expired = await client.zrangebyscore(deadKey, 0, nowMs - ttlMs);
    if (expired.length > 0) {
      await client.hdel(deadJobsKey, ...expired);
      await client.zrem(deadKey, ...expired);
    }

    const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await client.expire(deadKey, seconds);
    await client.expire(deadJobsKey, seconds);
  }

  /**
   * The client and TTL to run the retention path against, or `null` when there
   * is no retention to run — no TTL configured, not connected, or a client that
   * cannot `expire`. One reader, so the move and the sweep cannot disagree
   * about whether retention is active, and it hands back the TTL so neither
   * has to re-test a condition this already decided.
   *
   * @returns The client narrowed to carry `expire`, with the TTL, or `null`
   */
  #retention(): { client: IRedisQueueClient & RetentionCommands; ttlMs: number } | null {
    const client = this.#client;
    const ttlMs = this.#deadLetterTtlMs;
    if (ttlMs === undefined || client === null || typeof client.expire !== 'function') {
      return null;
    }
    return { client: client as IRedisQueueClient & RetentionCommands, ttlMs };
  }

  /**
   * M70k (X8-4): counts this name's three states with one `ZCARD` each.
   *
   * Absent on a client that does not expose `zcard`, which is why the member is
   * an assigned property rather than a declared method — the health indicator
   * must be able to tell "cannot report" from "nothing there". Absent again
   * after {@link disconnect}, for the same reason `isHealthy` is: the closure
   * captures the client it was installed for, so leaving it in place would
   * answer a depth read with that dead client's rejection instead of the
   * absence that says the adapter cannot count right now.
   *
   * @param name - Job name
   * @returns The depth of each state
   * @since 0.3.0
   */
  depths?: (name: string) => Promise<QueueDepths>;

  /**
   * Installs {@link depths} when the resolved client can count a sorted set,
   * and removes it when the client cannot — the same shape as
   * {@link RedisQueue.isHealthy}'s installer, holding the same invariant:
   * `depths` is present exactly when the CURRENT client can answer it.
   */
  #installDepths(): void {
    const client = this.#client;
    if (client === null || typeof client.zcard !== 'function') {
      delete this.depths;
      return;
    }
    const zcard = client.zcard;
    this.depths = async (name: string): Promise<QueueDepths> => {
      // Bound to the client for the same reason M70c bound `ping`: ioredis
      // reads `this.options` and an unbound call throws.
      const [ready, processing, dead] = await Promise.all([
        zcard.call(client, `queue:${name}:ready`),
        zcard.call(client, `queue:${name}:processing`),
        zcard.call(client, `queue:${name}:dead`),
      ]);
      return { ready, processing, dead };
    };
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
