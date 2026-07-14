/**
 * RabbitMQ queue adapter implementation.
 *
 * Uses AMQP 0-9-1 via amqplib for delayed job storage.
 * Implements polling via basicGet (NOT push consume) and uses
 * per-message TTL + dead-letter-exchange for delayed re-delivery.
 *
 * NOTE: This adapter uses a static `node:buffer` import because amqplib's
 * frame codec requires `Buffer.isBuffer(content)` and throws otherwise.
 * This is a forced, scoped deviation (no web-standard substitute exists).
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import type { QueueAdapter } from './queue-adapter.ts';
import type {
  IAmqpQueueChannel,
  IAmqpQueueConnection,
  StoredJob,
  StoredRecurring,
} from '../interfaces/index.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';

/**
 * Lazily load amqplib at runtime. Pin to 0.10.x for stability.
 *
 * @returns The amqplib module
 * @throws {Error} If the npm:amqplib package cannot be resolved
 */
async function loadAmqplib(): Promise<typeof import('npm:amqplib@0.10.x')> {
  const mod = await import('npm:amqplib@0.10.x');
  return mod;
}

/**
 * Validate that the supplied object has the structural shape required by
 * RabbitMqQueue. Checks the exact AMQP methods used.
 *
 * @param client - The object to validate
 * @returns `true` if structural checks pass
 */
export function validateClient(client: unknown): client is IAmqpQueueConnection {
  if (client === null || typeof client !== 'object') {
    return false;
  }
  const required = ['createChannel', 'close'];
  for (const method of required) {
    if (typeof (client as Record<string, unknown>)[method] !== 'function') {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the AMQP connection: prefer injected client, then lazy-load amqplib.
 *
 * @param url - RabbitMQ connection URL
 * @param injectedClient - Optionally injected AMQP connection
 * @returns The resolved connection
 * @throws {Error} If no client injected and amqplib cannot be loaded
 */
async function resolveClient(
  url: string,
  injectedClient?: IAmqpQueueConnection,
): Promise<IAmqpQueueConnection> {
  if (injectedClient !== undefined) {
    if (!validateClient(injectedClient)) {
      throw new Error(
        'Injected AMQP client does not match the required structural shape ' +
          '(needs: createChannel, close)',
      );
    }
    return injectedClient;
  }
  const amqplib = await loadAmqplib();
  const connection = await amqplib.connect(url);
  return connection as unknown as IAmqpQueueConnection;
}

/**
 * Options for configuring RabbitMqQueue.
 */
export interface RabbitMqQueueOptions {
  /** RabbitMQ connection URL (default 'amqp://localhost:5672'). */
  url?: string;
  /** Injected AMQP connection (bypasses lazy import). */
  client?: IAmqpQueueConnection;
  /** Queue name prefix (default 'he.queue'). */
  prefix?: string;
}

/**
 * RabbitMQ queue adapter implementation.
 *
 * Uses AMQP 0-9-1 via amqplib. Implements the claim-based reserve
 * pattern to prevent double-dispatch. Uses polling via basicGet
 * (NOT push consume) and per-message TTL + DLX for delayed re-delivery.
 *
 * Key topology per job name `<n>`:
 * - `he.queue.<n>.ready` - Ready queue (polling via basicGet)
 * - `he.queue.<n>.delay` - Delay queue (TTL + DLX → ready)
 * - `he.queue.<n>.dead` - Dead queue (final resting place)
 *
 * All queues are reached via the default exchange (routing key = queue name).
 *
 * @since 0.1.0
 */
export class RabbitMqQueue implements QueueAdapter {
  #runtime: IRuntimeServices;
  #url: string;
  #injectedClient: IAmqpQueueConnection | undefined;
  #prefix: string;
  #connection: IAmqpQueueConnection | null = null;
  #channel: IAmqpQueueChannel | null = null;
  #ready = false;
  // Per-name: processing jobs (reserved but not acked/dead-lettered)
  #processing: Map<string, Map<string, { message: unknown; job: StoredJob<unknown> }>>;
  // Recurring jobs (in-memory, non-durable)
  #recurringJobs: Map<string, StoredRecurring>;
  // Track asserted queues to avoid redundant asserts
  #asserted: Set<string>;

  /**
   * Creates a new RabbitMQ queue adapter.
   *
   * @param runtime - Runtime services for clock conversion (absolute → relative TTL)
   * @param options - RabbitMQ connection and configuration options
   */
  constructor(runtime: IRuntimeServices, options?: RabbitMqQueueOptions) {
    this.#runtime = runtime;
    this.#url = options?.url ?? 'amqp://localhost:5672';
    this.#injectedClient = options?.client;
    this.#prefix = options?.prefix ?? 'he.queue';
    this.#processing = new Map();
    this.#recurringJobs = new Map();
    this.#asserted = new Set();
  }

  /**
   * Get the ready queue name for a job name.
   */
  #readyQueue(name: string): string {
    return `${this.#prefix}.${name}.ready`;
  }

  /**
   * Get the delay queue name for a job name.
   */
  #delayQueue(name: string): string {
    return `${this.#prefix}.${name}.delay`;
  }

  /**
   * Get the dead queue name for a job name.
   */
  #deadQueue(name: string): string {
    return `${this.#prefix}.${name}.dead`;
  }

  /**
   * Assert the per-name queues (ready, delay, dead) lazily and idempotently.
   */
  async #assertQueues(name: string): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    const readyQ = this.#readyQueue(name);
    const delayQ = this.#delayQueue(name);
    const deadQ = this.#deadQueue(name);

    // Assert all three queues if not already done
    for (const q of [readyQ, delayQ, deadQ]) {
      if (!this.#asserted.has(q)) {
        if (q === delayQ) {
          // Delay queue with DLX → ready
          await this.#channel.assertQueue(q, {
            durable: true,
            deadLetterExchange: '',
            deadLetterRoutingKey: readyQ,
          });
        } else {
          // Ready and dead queues: durable only
          await this.#channel.assertQueue(q, { durable: true });
        }
        this.#asserted.add(q);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.#connection = await resolveClient(this.#url, this.#injectedClient);
    // Create channel unconditionally from the resolved connection
    this.#channel = await this.#connection.createChannel();
    this.#ready = true;
  }

  async disconnect(): Promise<void> {
    // Clear processing state
    this.#processing.clear();
    // Clear asserted queues so they are re-asserted on next connect
    this.#asserted.clear();
    // Close channel
    if (this.#channel) {
      await this.#channel.close();
      this.#channel = null;
    }
    // Close connection only if not injected (lazy-loaded)
    if (this.#connection && !this.#injectedClient) {
      await this.#connection.close();
      this.#connection = null;
    }
    this.#ready = false;
  }

  isReady(): boolean {
    return this.#ready;
  }

  async enqueue<T>(job: StoredJob<T>): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    await this.#assertQueues(job.name);

    const content = Buffer.from(JSON.stringify(job), 'utf8');
    const readyQ = this.#readyQueue(job.name);
    const delayQ = this.#delayQueue(job.name);

    // Check if delayed (availableAtMs > now)
    const now = this.#runtime.now();
    if (job.availableAtMs <= now) {
      // No delay: publish directly to ready queue
      this.#channel.publish('', readyQ, content);
    } else {
      // Delayed: publish to delay queue with TTL
      const expiration = job.availableAtMs - now;
      this.#channel.publish('', delayQ, content, { expiration });
    }
  }

  async reserve<T>(name: string, limit: number, _nowMs: number): Promise<readonly StoredJob<T>[]> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    await this.#assertQueues(name);

    const readyQ = this.#readyQueue(name);
    const processing = this.#getOrCreateProcessing(name);
    const result: StoredJob<T>[] = [];

    // Poll up to limit times, stopping at first false (BasicGetEmpty)
    for (let i = 0; i < limit; i++) {
      const msg = await this.#channel.get(readyQ, { noAck: false });
      if (msg === false) {
        // Empty queue sentinel - stop polling
        break;
      }

      // Decode Buffer to string, then parse JSON
      const payload = msg.content.toString('utf8');
      const job = JSON.parse(payload) as StoredJob<T>;

      // Claim the job
      processing.set(job.id, { message: msg, job: job as StoredJob<unknown> });
      result.push(job);
    }

    return result as readonly StoredJob<T>[];
  }

  async ack(name: string, id: string): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    const processing = this.#getOrCreateProcessing(name);
    const entry = processing.get(id);
    if (!entry) {
      return;
    }

    // Ack the message
    this.#channel.ack(entry.message);
    processing.delete(id);
  }

  async requeue<T>(
    name: string,
    id: string,
    availableAtMs: number,
    attempts: number,
  ): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    await this.#assertQueues(name);

    const processing = this.#getOrCreateProcessing(name);
    const entry = processing.get(id);
    if (!entry) {
      return;
    }

    // Update job
    const updated = { ...entry.job, availableAtMs, attempts } as StoredJob<T>;

    // Publish to delay queue with fresh TTL
    const content = Buffer.from(JSON.stringify(updated), 'utf8');
    const delayQ = this.#delayQueue(name);
    const now = this.#runtime.now();
    const expiration = Math.max(1, availableAtMs - now);
    this.#channel.publish('', delayQ, content, { expiration });

    // Ack the original message
    this.#channel.ack(entry.message);

    // Remove from processing
    processing.delete(id);
  }

  async deadLetter(name: string, id: string, nowMs: number): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    await this.#assertQueues(name);

    const processing = this.#getOrCreateProcessing(name);
    const entry = processing.get(id);
    if (!entry) {
      return;
    }

    // Publish to dead queue
    const content = Buffer.from(JSON.stringify(entry.job), 'utf8');
    const deadQ = this.#deadQueue(name);
    this.#channel.publish('', deadQ, content, { timestamp: nowMs });

    // Ack the original message
    this.#channel.ack(entry.message);

    // Remove from processing
    processing.delete(id);
  }

  async storeRecurring(rec: StoredRecurring): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    this.#recurringJobs.set(rec.id, { ...rec });
  }

  async fetchRecurringDue(nowMs: number): Promise<readonly StoredRecurring[]> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    const due: StoredRecurring[] = [];
    for (const rec of this.#recurringJobs.values()) {
      if (rec.nextRunAtMs <= nowMs) {
        due.push({ ...rec });
      }
    }
    return due as readonly StoredRecurring[];
  }

  async advanceRecurring(id: string, nextRunAtMs: number): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    const rec = this.#recurringJobs.get(id);
    if (!rec) {
      return;
    }
    this.#recurringJobs.set(id, { ...rec, nextRunAtMs });
  }

  /**
   * Get or create the processing map for a job name.
   */
  #getOrCreateProcessing(name: string): Map<string, { message: unknown; job: StoredJob<unknown> }> {
    if (!this.#processing.has(name)) {
      this.#processing.set(name, new Map());
    }
    return this.#processing.get(name)!;
  }
}
