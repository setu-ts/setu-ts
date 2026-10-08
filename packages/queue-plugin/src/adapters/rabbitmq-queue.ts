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
  RabbitMqQueueOptions,
  StoredJob,
  StoredRecurring,
} from '../interfaces/index.ts';
import type { IRuntimeServices } from '@setu-ts/common';
import { deadlineRangeError, withDeadline } from '@setu-ts/common';

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

/** Default bound on one job publish, including its confirm, in ms. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

/**
 * Resolves and validates `publishTimeoutMs`. Shared by
 * `QueuePlugin(...)` (which refuses a bad value at construction) and the
 * adapter constructor, so both read one rule.
 *
 * `messaging-plugin`'s RabbitMQ broker carries the same rule; it is restated
 * here because AI_GUIDELINES §2.2 forbids a plugin importing another plugin,
 * and the validation itself is the shared `deadlineRangeError` in `common`.
 *
 * @param value - The configured bound, or `undefined` for the default
 * @returns The bound in milliseconds (`0` = unbounded)
 * @throws {RangeError} When the value is outside `0`–`2147483647` or not finite
 */
export function resolvePublishTimeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const refusal = deadlineRangeError('queue-plugin: options.publishTimeoutMs', resolved);
  if (refusal !== null) {
    throw refusal;
  }
  return resolved;
}

/**
 * The close-listener members of an amqplib channel (an `EventEmitter`). Read
 * structurally, so an injected facade without them still publishes; it then
 * relies on `publishTimeoutMs` alone to settle a confirm that never arrives.
 */
interface CloseObservable {
  on(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

/**
 * Whether a channel exposes the `on`/`off` pair a per-publish close listener
 * needs.
 *
 * @param channel - The channel to inspect
 * @returns `true` when both members are functions
 */
function isCloseObservable(channel: unknown): channel is CloseObservable {
  return typeof channel === 'object' && channel !== null &&
    typeof (channel as { on?: unknown }).on === 'function' &&
    typeof (channel as { off?: unknown }).off === 'function';
}

/**
 * Publishes on a confirm channel and settles on the broker's answer.
 *
 * amqplib throws SYNCHRONOUSLY when the channel is already closed (probed);
 * the executor turns that into a rejection, so the returned promise is the
 * only failure channel.
 *
 * The promise ALSO rejects when the channel closes before the confirm
 * arrives. amqplib 0.10.x drains its unconfirmed callbacks on close, but the
 * drain stops at the first slot an out-of-order confirm already settled, so
 * a later callback can never run — and with `publishTimeoutMs: 0` nothing
 * else would settle `add()`, `requeue()` or `deadLetter()` (the last two would
 * also never ack the reserved job). The listener is removed once the publish
 * settles either way, so a long-lived channel accumulates none.
 *
 * @param channel - The confirm channel
 * @param queue - Target queue (via the default exchange)
 * @param content - Job body
 * @param options - Publish options
 * @returns Resolves once RabbitMQ accepts the job
 */
function publishConfirmed(
  channel: IAmqpQueueChannel,
  queue: string,
  content: Buffer,
  options: Record<string, unknown>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const observable = isCloseObservable(channel) ? channel : null;
    let settled = false;
    const settle = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      observable?.off('close', onClose);
      if (err === null || err === undefined) {
        resolve();
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      reject(
        new Error(`RabbitMQ did not confirm the job published to queue "${queue}": ${detail}`, {
          cause: err,
        }),
      );
    };
    const onClose = (): void => settle(new Error('channel closed before the confirm arrived'));
    observable?.on('close', onClose);
    try {
      channel.publish('', queue, content, options, settle);
    } catch (error) {
      settled = true;
      observable?.off('close', onClose);
      reject(error);
    }
  });
}

/**
 * Whether a value fits an AMQP short string: at most 255 UTF-8 bytes.
 *
 * Queue names are short strings, and amqplib claims the channel's RPC reply
 * slot BEFORE it encodes a declaration — so an oversized name is refused only
 * after the channel is left waiting for an answer that never comes, and every
 * later operation on it queues behind that (M106 audit O4). Callers check first.
 *
 * @param value - The name to measure
 * @returns Whether it can be encoded
 */
function fitsAmqpShortString(value: string): boolean {
  return new TextEncoder().encode(value).length <= 255;
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
  #persistentMessages: boolean;
  #publishTimeoutMs: number;
  #reportWarning: ((message: string) => void) | undefined;
  #connection: IAmqpQueueConnection | null = null;
  #channel: IAmqpQueueChannel | null = null;
  /** Whether `#channel` is a confirm channel (set where the channel is made). */
  #confirmed = false;
  /** Whether the no-confirm-channel warning has been reported (once). */
  #warnedUnconfirmed = false;
  #ready = false;
  /**
   * M70c: set when the connection fires `'error'`/`'close'` — the same fault
   * mechanism as the RabbitMQ broker. `isHealthy` reads it, so a faulted
   * connection is `down` even though it is still "ready".
   */
  #faulted = false;
  /**
   * M70c: present only when the connection exposes `on?`; its absence is
   * *unknown* reachability, not `false`.
   *
   * @since 0.1.0
   */
  isHealthy?: () => Promise<boolean>;
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
    // Refused here rather than at the first queue declaration, which would
    // leave the channel waiting for a reply forever (see fitsAmqpShortString).
    if (!fitsAmqpShortString(`${this.#prefix}.x.ready`)) {
      throw new RangeError(
        "RabbitMqQueue: prefix leaves no room for a job name within AMQP's 255 UTF-8 bytes",
      );
    }
    this.#persistentMessages = options?.persistentMessages ?? true;
    this.#publishTimeoutMs = resolvePublishTimeoutMs(
      options?.publishTimeoutMs,
    );
    this.#reportWarning = options?.reportWarning;
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
   * Why this adapter cannot use a job name, or `null` when it can. The derived
   * `<prefix>.<name>.ready` / `.delay` queue names (the longest suffixes) must
   * each fit an AMQP short string. The text never quotes the name, which may
   * be caller data. `QueueService` calls this at `process()` and
   * `addRecurring()` so an unusable name fails at registration rather than on
   * every poll.
   *
   * @param name - The job name
   * @returns The refusal text, or `null`
   * @internal
   */
  jobNameProblem(name: string): string | null {
    return fitsAmqpShortString(this.#readyQueue(name)) &&
        fitsAmqpShortString(this.#delayQueue(name))
      ? null
      : "RabbitMqQueue cannot use the job name: its queue names exceed AMQP's 255 UTF-8 byte limit";
  }

  /**
   * Assert the per-name queues (ready, delay, dead) lazily and idempotently.
   */
  async #assertQueues(name: string): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    // Checked before any channel operation: every path reaches the channel
    // through here first, and an oversized queue name would leave the
    // channel's RPC slot waiting forever.
    const problem = this.jobNameProblem(name);
    if (problem !== null) throw new RangeError(problem);
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
    // A freshly-resolved connection is not faulted. Set this BEFORE installing
    // the fault listener so a reset that lands during `createChannel()` (right
    // after a backend restart, when the port is open before the AMQP handshake
    // is ready) is recorded, not cleared.
    this.#faulted = false;
    // Install the connection fault listener BEFORE `createChannel()`: the
    // broker can reset the socket while the channel is being created, and an
    // unlistened connection `'error'` is an unhandled event that crashes the
    // host process — a defect a fake-based test can never construct (a fake
    // connection never emits).
    this.#installConnectionFaultListener();
    this.#channel = await this.#openChannel(this.#connection);
    this.#ready = true;
    // Guard the channel the same way: amqplib emits `'error'` on every channel
    // when the underlying connection resets.
    this.#installChannelFaultListener();
    // Expose the probe only once the lifecycle is ready. A connection without
    // an `on` surface is *unknown* reachability, not `false` (the indicator
    // reads absence, not a false positive).
    if (this.#connection !== null && typeof this.#connection.on === 'function') {
      this.isHealthy = (): Promise<boolean> => Promise.resolve(!this.#faulted);
    } else {
      delete this.isHealthy;
    }
  }

  /**
   * Opens the adapter's channel: a confirm channel when the connection can
   * open one (a real amqplib connection always can), otherwise a plain channel
   * — reported once, since its publishes resolve before RabbitMQ has stored
   * the job.
   */
  async #openChannel(connection: IAmqpQueueConnection): Promise<IAmqpQueueChannel> {
    if (typeof connection.createConfirmChannel === 'function') {
      const channel = await connection.createConfirmChannel();
      this.#confirmed = true;
      return channel;
    }
    const channel = await connection.createChannel();
    this.#confirmed = false;
    if (!this.#warnedUnconfirmed) {
      this.#warnedUnconfirmed = true;
      this.#reportWarning?.(
        'RabbitMqQueue: the injected AMQP connection has no createConfirmChannel(), so job ' +
          'publishes are NOT confirmed: add() resolves before RabbitMQ has stored the job, ' +
          'and a broker failure can lose it',
      );
    }
    return channel;
  }

  /**
   * Publishes one job message to `queue` through the default exchange —
   * persistent unless `persistentMessages: false`, and, on a confirm channel,
   * resolving only once the broker has accepted it. Every publish site goes
   * through here, so no site can drift from the durability policy. Bounded by
   * the caller through {@linkcode RabbitMqQueue.#bounded}.
   */
  async #publish(
    channel: IAmqpQueueChannel,
    queue: string,
    content: Buffer,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    // Set only when enabled, so `persistentMessages: false` publishes exactly
    // what every release before 0.9.0 published.
    const options: Record<string, unknown> = this.#persistentMessages
      ? { ...extra, persistent: true }
      : { ...extra };
    if (!this.#confirmed) {
      channel.publish('', queue, content, options);
      return;
    }
    await publishConfirmed(channel, queue, content, options);
  }

  /**
   * Runs one publish operation — queue declarations included — under
   * `publishTimeoutMs`. The bound covers EVERY broker round trip, not only
   * the confirm: a paused broker keeps its socket open, so a queue assert
   * never answers either (measured on the messaging broker's equivalent
   * exchange assert), and bounding only the confirm would leave the call
   * pending before the bound armed.
   */
  async #bounded(queue: string, run: () => Promise<void>): Promise<void> {
    const timeoutMs = this.#publishTimeoutMs;
    await withDeadline(run, {
      timeoutMs,
      onTimeout: () =>
        new Error(
          `RabbitMQ did not accept the job published to queue "${queue}" within ` +
            `${timeoutMs} ms (publishTimeoutMs); it may still be accepted`,
        ),
      timing: {
        setTimer: (fn, ms) => this.#runtime.setTimeout(fn, ms),
        clearTimer: (handle) => this.#runtime.clearTimeout(handle),
      },
    });
  }

  /**
   * M70c: installs the `'error'`/`'close'` fault listener on the connection
   * when it exposes `on?`. Installed before `createChannel()` (see
   * {@linkcode connect}) so a reset during channel creation is handled rather
   * than crashing the host process as an unhandled `'error'` event.
   */
  #installConnectionFaultListener(): void {
    const connection = this.#connection;
    if (connection !== null && typeof connection.on === 'function') {
      const listener = (): void => {
        this.#faulted = true;
      };
      connection.on('error', listener);
      connection.on('close', listener);
    }
  }

  /**
   * M70c: installs an `'error'` listener on the channel when it exposes one.
   * amqplib emits `error` on **every** channel when the underlying connection
   * resets (ECONNRESET during a real backend outage). An unlistened channel
   * `error` is an unhandled `'error'` event that crashes the host process — a
   * defect a fake-based test can never construct (a fake channel never emits).
   * The listener marks the adapter faulted (redundant with the connection
   * listener, but truthful for a channel that faults before the connection
   * event lands).
   */
  #installChannelFaultListener(): void {
    const channel = this.#channel as unknown as {
      on?: (event: string, listener: () => void) => void;
    } | null;
    if (channel !== null && typeof channel.on === 'function') {
      channel.on('error', (): void => {
        this.#faulted = true;
      });
    }
  }

  async disconnect(): Promise<void> {
    // Clear processing state
    this.#processing.clear();
    // Clear asserted queues so they are re-asserted on next connect
    this.#asserted.clear();
    // Clear the fault flag (M70c)
    this.#faulted = false;
    delete this.isHealthy;
    // Close channel. Best-effort: after a backend outage amqplib has already
    // torn the channel down, so `close()` throws `IllegalOperationError:
    // Channel closed`. A `disconnect()` must not throw on a faulted
    // connection — the channel is already gone and there is nothing to close.
    if (this.#channel) {
      try {
        await this.#channel.close();
      } catch {
        // Already closed by the fault; nothing to do.
      }
      this.#channel = null;
    }
    // Close connection only if not injected (lazy-loaded). Same best-effort
    // rationale as the channel above.
    if (this.#connection && !this.#injectedClient) {
      try {
        await this.#connection.close();
      } catch {
        // Already closed by the fault; nothing to do.
      }
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

    const channel = this.#channel;
    const content = Buffer.from(JSON.stringify(job), 'utf8');
    const readyQ = this.#readyQueue(job.name);
    const delayQ = this.#delayQueue(job.name);

    // Check if delayed (availableAtMs > now)
    const now = this.#runtime.now();
    const delayed = job.availableAtMs > now;
    await this.#bounded(delayed ? delayQ : readyQ, async () => {
      await this.#assertQueues(job.name);
      if (!delayed) {
        // No delay: publish directly to ready queue
        await this.#publish(channel, readyQ, content);
      } else {
        // Delayed: publish to delay queue with TTL
        const expiration = job.availableAtMs - now;
        await this.#publish(channel, delayQ, content, { expiration });
      }
    });
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

  // deno-lint-ignore require-await
  async ack(name: string, id: string, _claimToken?: string): Promise<void> {
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
    _claimToken?: string,
  ): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    // The channel is captured BEFORE any await: a `disconnect()` during the
    // publish nulls `#channel`, and the ack must go to the channel the job was
    // reserved on (a closed one throws, leaving the job unacked for RabbitMQ to
    // redeliver — never lost).
    const channel = this.#channel;
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
    // Ack only AFTER the replacement is accepted: acking first would let a
    // broker failure between the two lose the job outright, where this order
    // can at worst run it twice.
    await this.#bounded(delayQ, async () => {
      await this.#assertQueues(name);
      await this.#publish(channel, delayQ, content, { expiration });
    });

    // Ack the original message
    channel.ack(entry.message);

    // Remove from processing
    processing.delete(id);
  }

  async deadLetter(name: string, id: string, nowMs: number, _claimToken?: string): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    // Captured before any await, for the same reason as `requeue`.
    const channel = this.#channel;
    const processing = this.#getOrCreateProcessing(name);
    const entry = processing.get(id);
    if (!entry) {
      return;
    }

    // Publish to dead queue — accepted before the ack, as in `requeue`.
    const content = Buffer.from(JSON.stringify(entry.job), 'utf8');
    const deadQ = this.#deadQueue(name);
    await this.#bounded(deadQ, async () => {
      await this.#assertQueues(name);
      await this.#publish(channel, deadQ, content, { timestamp: nowMs });
    });

    // Ack the original message
    channel.ack(entry.message);

    // Remove from processing
    processing.delete(id);
  }

  // deno-lint-ignore require-await
  async storeRecurring(rec: StoredRecurring): Promise<void> {
    if (!this.#channel) {
      throw new Error('RabbitMqQueue is not connected');
    }

    this.#recurringJobs.set(rec.id, { ...rec });
  }

  // deno-lint-ignore require-await
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

  // deno-lint-ignore require-await
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
