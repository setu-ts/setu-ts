/**
 * `WorkersQueue` — the committed {@linkcode IQueue} over a Cloudflare Queues
 * producer binding, plus the consumer-side dispatch its `queue` handler drives.
 *
 * The two halves of a Cloudflare queue live in different places: producing is a
 * binding method callable from any request, while consuming happens in a
 * separate `queue()` invocation of the Worker. One object owns both so that the
 * processors registered through `IQueue.process` are the processors the batch
 * handler dispatches into.
 *
 * @module
 */

import type {
  AddJobOptions,
  IJob,
  IQueue,
  JobProcessor,
  LogMetadata,
  ProcessOptions,
  RecurringOptions,
} from '@setu-ts/common';
import type { LoggerSource } from '../background/wait-until.ts';
import type {
  IQueueMessage,
  IQueueMessageBatch,
  IQueueProducer,
  QueueSendOptions,
} from '../bindings/facades.ts';
import { describeError } from '@setu-ts/common';
import { CloudflareUnsupportedError } from '../errors.ts';
import { runBounded } from './bounded-map.ts';
import type { JobEnvelope } from './job-envelope.ts';
import { encodeJobEnvelope, isJobEnvelope, readEnvelopeHeaders } from './job-envelope.ts';

/** The platform's maximum `delaySeconds`, and this queue's default cap. */
const PLATFORM_MAX_DELAY_SECONDS = 86_400;

/** Default per-processor concurrency, matching `ProcessOptions`' documented default. */
const DEFAULT_CONCURRENCY = 1;

/** The platform's default `max_retries`, and this queue's default `maxRetries`. */
const DEFAULT_MAX_RETRIES = 3;

/** Serialization for a forwarded body JSON cannot carry: structured clone. */
const STRUCTURED_CLONE: QueueSendOptions = { contentType: 'v8' };

/** Serialization for a binary body forwarded as it arrived: pull consumers can read `bytes`. */
const BYTES: QueueSendOptions = { contentType: 'bytes' };

/** Nesting past this depth is not walked; such a body is sent with structured clone. */
const JSON_CHECK_DEPTH = 64;

/**
 * Whether JSON carries `value` unchanged: strings, finite numbers, booleans,
 * `null`, and arrays and plain objects of those, acyclic and within
 * {@linkcode JSON_CHECK_DEPTH}.
 *
 * @param value - A message body
 * @returns `true` when JSON serialization loses nothing
 */
function isJsonCarried(value: unknown): boolean {
  return carried(value, 0, new Set());
}

/** {@linkcode isJsonCarried}'s walk; `path` holds the objects above `value`. */
function carried(value: unknown, depth: number, path: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= JSON_CHECK_DEPTH || path.has(value)) return false;
  const isArray = Array.isArray(value);
  if (!isArray) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
  }
  path.add(value);
  const items: unknown[] = isArray ? value : Object.values(value);
  const ok = items.every((item) => carried(item, depth + 1, path));
  path.delete(value);
  return ok;
}

/** How a forwarded original JSON cannot carry is sent: bytes alone as `bytes`. */
function originalSerialization(body: unknown): QueueSendOptions {
  return body instanceof ArrayBuffer ? BYTES : STRUCTURED_CLONE;
}

/** The platform's largest `max_retries`. */
const MAX_RETRIES_LIMIT = 100;

/**
 * Retry spacing: a fixed number of seconds, or a function of the attempt that
 * just failed (1 on the first delivery).
 * @since 0.14.0
 */
export type RetryDelaySeconds = number | ((attempts: number) => number);

/**
 * The id source this queue needs. {@linkcode IRuntimeServices} satisfies it.
 *
 * A source rather than a direct `crypto.randomUUID()` call, because
 * AI_GUIDELINES §4.2 routes every runtime capability through
 * `IRuntimeServices` — which is also why the plugin, not the application,
 * constructs this class.
 *
 * @since 0.2.0
 */
export interface JobIdSource {
  /**
   * A fresh unique id.
   *
   * @returns The id
   */
  uuid(): string;
}

/**
 * Options for {@linkcode WorkersQueue}.
 *
 * @since 0.2.0
 */
export interface WorkersQueueOptions {
  /**
   * Resolves the logger at the moment a dispatch path needs it, reporting on
   * the four cases that would otherwise be silent: a message whose name has no
   * processor, an unreadable body, a processor that threw, and a job that
   * exhausted its attempts.
   *
   * A **thunk**, not an `ILogger`, for the same reason `resolveWaitUntil` takes
   * one: the plugin context resolves `logger` lazily through a Proxy that
   * answers `undefined` until a logger is registered, and a capability may be
   * registered imperatively without a `provides` declaration the resolver can
   * order against. Capturing the value during `register()` freezes whatever was
   * registered by then, so a logger registered afterwards would never receive a
   * report. Omitted leaves every path silent.
   */
  readonly logger?: LoggerSource;
  /**
   * Largest `delayMs` this queue will accept, in **seconds**. Defaults to
   * 86400, the platform maximum. A larger delay throws rather than being
   * silently truncated by the platform.
   */
  readonly maxDelaySeconds?: number;
  /**
   * The consumer's `max_retries` from `wrangler.toml`, which the binding does
   * not expose: a whole number from 1 to 100, default 3 (the platform's
   * default). The two must match. A job's attempt budget is
   * `min(maxAttempts, maxRetries)`, which keeps the platform's last delivery
   * (`maxRetries + 1`) in reserve for a dead-letter send that failed; 0 is
   * refused because it leaves no such reserve.
   * @since 0.14.0
   */
  readonly maxRetries?: number;
  /**
   * Where an exhausted job goes: a Queues producer for the dead-letter queue,
   * or `false` to discard exhausted jobs (one warning per discard, never the
   * payload). Required before `process()`: the adapter cannot see a
   * `dead_letter_queue` in `wrangler.toml`, and without one the platform
   * deletes an exhausted job.
   * @since 0.14.0
   */
  readonly deadLetter?: IQueueProducer | false;
  /**
   * Seconds before a failed job is redelivered: a number, or a function of
   * the attempt that failed. Bounded to 0 to `maxDelaySeconds`. Omitted, the
   * queue's own `retry_delay` applies.
   * @since 0.14.0
   */
  readonly retryDelaySeconds?: RetryDelaySeconds;
  /**
   * Wall clock for the dead-letter copy's `failedAt`. The plugin passes
   * `runtime.now`; omitted, the copy carries no `failedAt`.
   * @since 0.14.0
   */
  readonly now?: () => number;
}

/** A registered processor and the options its registration asked for. */
interface Registration {
  readonly processor: JobProcessor<unknown>;
  readonly concurrency: number;
  readonly onFailed: ProcessOptions['onFailed'];
  /** Where this name's exhausted jobs go, fixed when `process()` accepted it. */
  readonly deadLetter: IQueueProducer | false;
}

/** A message paired with the envelope `dispatch` already read out of it. */
interface Delivery {
  readonly message: IQueueMessage;
  readonly envelope: JobEnvelope;
}

/**
 * A background job queue backed by Cloudflare Queues.
 *
 * Two of the three committed methods map onto the platform directly.
 * {@linkcode addRecurring} does not and throws: Cloudflare has no recurring
 * queue message, and the platform's answer — Cron Triggers — is a different
 * mechanism with its own handler export, reached through `WorkersCron`.
 *
 * Consuming requires the application to export the handler
 * {@linkcode createQueueHandler} builds:
 *
 * @example
 * ```typescript
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin({ env, waitUntil }),
 *     CloudflarePlugin({
 *       env,
 *       queue: { binding: 'JOBS', maxRetries: 3, deadLetterQueue: 'JOBS_DLQ' },
 *     }),
 *   ],
 * });
 * await app.start();
 *
 * const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
 * queue.process<{ to: string }>('send-email', async (job) => {
 *   await mailer.send(job.data);
 * }, { concurrency: 5 });
 *
 * export default { fetch: app.fetch, queue: createQueueHandler(app) };
 * ```
 * @since 0.2.0
 */
export class WorkersQueue implements IQueue {
  readonly #producer: IQueueProducer;
  readonly #ids: JobIdSource;
  readonly #logger: LoggerSource | undefined;
  readonly #maxDelaySeconds: number;
  readonly #maxRetries: number;
  readonly #deadLetter: IQueueProducer | false | undefined;
  readonly #retryDelay: RetryDelaySeconds | undefined;
  readonly #now: (() => number) | undefined;
  readonly #processors = new Map<string, Registration>();
  /** Job names already warned about, so each warning fires once per isolate. */
  readonly #capWarned = new Set<string>();
  readonly #pastBudgetWarned = new Set<string>();
  #retryDelayWarned = false;

  /**
   * @param producer - The Queues producer binding
   * @param ids - Unique id source; pass `IRuntimeServices`
   * @param options - Logger and delay cap
   */
  constructor(producer: IQueueProducer, ids: JobIdSource, options?: WorkersQueueOptions) {
    this.#producer = producer;
    this.#ids = ids;
    this.#logger = options?.logger;
    this.#maxDelaySeconds = options?.maxDelaySeconds ?? PLATFORM_MAX_DELAY_SECONDS;
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > MAX_RETRIES_LIMIT) {
      throw new RangeError(
        `WorkersQueue: maxRetries must be a whole number from 1 to ${MAX_RETRIES_LIMIT} ` +
          `(the consumer's max_retries in wrangler.toml), got ${String(maxRetries)}`,
      );
    }
    const delay = options?.retryDelaySeconds;
    if (typeof delay === 'number' && (!Number.isFinite(delay) || delay < 0)) {
      throw new RangeError(
        `WorkersQueue: retryDelaySeconds must be a finite number of seconds from 0, got ${String(delay)}`,
      );
    }
    if (options?.deadLetter === producer) {
      throw new CloudflareUnsupportedError(
        'WorkersQueue: deadLetter is the producer of the queue it serves; an exhausted job would ' +
          'be re-enqueued and run again without end. Bind a separate dead-letter queue.',
      );
    }
    this.#maxRetries = maxRetries;
    this.#deadLetter = options?.deadLetter;
    this.#retryDelay = delay;
    this.#now = options?.now;
  }

  /**
   * Enqueues a job.
   *
   * The returned id is generated here rather than by the platform, because
   * `producer.send()` resolves to `void`. It travels inside the message
   * envelope, so the id this returns is the id the processor sees as
   * `job.id`.
   *
   * @typeParam T - The payload type
   * @param name - Job name; a processor must be registered under it to consume
   * @param data - Job payload, serialized as JSON by the platform
   * @param options - `delayMs` (converted to whole seconds, rounded up) and
   * `maxAttempts` (enforced at dispatch, since Cloudflare's `max_retries` is
   * queue-wide configuration rather than per message)
   * @returns The job id
   * @throws {CloudflareUnsupportedError} When `delayMs` exceeds the configured
   * cap
   */
  async add<T>(name: string, data: T, options?: AddJobOptions): Promise<string> {
    // Validated before an id is minted, so a refused send does not consume one
    // and a retrying caller sees a clean sequence.
    const sendOptions = this.#sendOptions(name, options?.delayMs);

    const id = this.#ids.uuid();
    const envelope = encodeJobEnvelope(name, id, data, options?.maxAttempts, options?.headers);

    await this.#producer.send(envelope, sendOptions);
    return id;
  }

  /**
   * Registers a processor for a job name.
   *
   * Registering twice under one name replaces the earlier processor, matching
   * `QueueService.process` in `queue-plugin` so the committed port behaves the
   * same way on every backend.
   *
   * @typeParam T - The payload type
   * @param name - Job name
   * @param processor - Invoked per delivered job
   * @param options - `concurrency` bounds how many of one batch's messages for
   * this name run at a time; `onFailed` runs once when a job of this name
   * exhausts its attempts, before it is dead-lettered or discarded
   * @throws {CloudflareUnsupportedError} When the queue has no dead-letter
   * producer and no `deadLetterQueue: false`
   */
  process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void {
    const deadLetter = this.#deadLetter;
    if (deadLetter === undefined) {
      throw new CloudflareUnsupportedError(
        `WorkersQueue cannot consume '${name}' without a dead-letter target: the platform ` +
          'deletes a job that exhausts max_retries unless wrangler.toml configures a ' +
          "dead_letter_queue, and the adapter cannot see that setting. Set the queue arm's " +
          "deadLetterQueue to a producer binding name (deadLetterQueue: 'JOBS_DLQ'), or to " +
          'false to discard exhausted jobs.',
      );
    }
    this.#processors.set(name, {
      processor: processor as JobProcessor<unknown>,
      concurrency: options?.concurrency ?? DEFAULT_CONCURRENCY,
      onFailed: options?.onFailed,
      deadLetter,
    });
  }

  /**
   * Not supported on Cloudflare Queues.
   *
   * @typeParam T - The payload type
   * @param name - Job name
   * @param _data - Ignored
   * @param options - The cron expression that cannot be honored here
   * @returns Never resolves
   * @throws {CloudflareUnsupportedError} Always
   */
  // eslint-disable-next-line require-await -- IQueue.addRecurring is async by contract
  async addRecurring<T>(name: string, _data: T, options: RecurringOptions): Promise<void> {
    throw new CloudflareUnsupportedError(
      `Cloudflare Queues has no recurring message, so addRecurring('${name}', …) with cron ` +
        `'${options.cron}' cannot be honored. Declare the schedule in wrangler.toml under ` +
        '[triggers] crons, register a handler on a WorkersCron for the same expression, and ' +
        'export createScheduledHandler(cron) as `scheduled` — that handler can call ' +
        `queue.add('${name}', …) itself if the work belongs on the queue.`,
    );
  }

  /**
   * Dispatches one delivered batch into the registered processors.
   *
   * Every message is settled exactly once:
   *
   * - a body that is not a readable envelope, or a name with no registered
   *   processor → `retry()` while it has attempts left, because acking would
   *   discard it permanently and silently; on its last processor attempt
   *   (`maxRetries`) it is forwarded to the dead-letter producer, or discarded
   *   with a warning when the target is `false`, or (no target at all, a
   *   producer-only queue) retried for the platform's own `dead_letter_queue`;
   * - `attempts` past the job's budget (`min(maxAttempts, maxRetries)`) →
   *   forwarded or discarded without running the processor;
   * - a processor that throws before its last attempt → `retry()` (spaced by
   *   `retryDelaySeconds`); on its last attempt → `onFailed`, then forwarded
   *   or discarded;
   * - a processor that resolves → `ack()`.
   *
   * @param batch - The delivered batch
   * @returns Resolves once every message has been acked or retried
   */
  async dispatch(batch: IQueueMessageBatch): Promise<void> {
    // Unroutable messages settled on their last attempt, awaited with the rest.
    const pending: Promise<void>[] = [];
    // Grouped by name first so each processor's own `concurrency` bounds only
    // its own messages — a batch legitimately mixes names, and one name's
    // limit must not throttle another's. The envelope is carried alongside the
    // message rather than re-read later, so the narrowing done here is the
    // narrowing the processor path uses.
    const routable = new Map<string, { readonly at: Registration; readonly work: Delivery[] }>();

    for (const message of batch.messages) {
      const envelope = isJobEnvelope(message.body) ? message.body : undefined;
      const registration = envelope === undefined ? undefined : this.#processors.get(envelope.name);

      if (envelope === undefined || registration === undefined) {
        const target = this.#deadLetter;
        const last = message.attempts >= this.#maxRetries && target !== undefined;
        this.#reportUnroutable(
          batch.queue,
          message,
          envelope,
          !last
            ? 'retried'
            : target === false
              ? 'discarded'
              : 'forwarding to the dead-letter queue',
        );
        if (last) {
          // The platform's next exhaustion would delete it: keep it instead.
          const reason =
            envelope === undefined ? 'body is not a job envelope' : 'no processor registered';
          pending.push(this.#settleExhausted(target, batch.queue, message, envelope, reason));
        } else {
          this.#retry(message);
        }
        continue;
      }

      const group = routable.get(envelope.name);
      if (group === undefined) {
        routable.set(envelope.name, { at: registration, work: [{ message, envelope }] });
      } else {
        group.work.push({ message, envelope });
      }
    }

    await Promise.all([
      ...pending,
      ...[...routable].map(([name, group]) =>
        runBounded(group.work, group.at.concurrency, (delivery) =>
          this.#runOne(batch.queue, name, group.at, delivery),
        ),
      ),
    ]);
  }

  /** Runs one message through its processor and settles its disposition. */
  async #runOne(
    queue: string,
    name: string,
    registration: Registration,
    delivery: Delivery,
  ): Promise<void> {
    const { message, envelope } = delivery;
    const budget = this.#budget(name, envelope);

    if (message.attempts > budget) {
      // A redelivery after a failed dead-letter send, an older message, or a
      // budget lowered by a deploy: onFailed already ran, or cannot be told
      // apart from a job whose final attempt did, so it is not run again.
      if (!this.#pastBudgetWarned.has(name)) {
        this.#pastBudgetWarned.add(name);
        this.#logger?.()?.warn('cloudflare-queue: job arrived past its attempt budget', {
          queue,
          job: name,
          id: envelope.id,
          attempts: message.attempts,
          budget,
        });
      }
      await this.#settleExhausted(
        registration.deadLetter,
        queue,
        message,
        envelope,
        'attempt budget exhausted',
      );
      return;
    }

    const headers = readEnvelopeHeaders(envelope.headers);
    const job: IJob = {
      id: envelope.id,
      name,
      data: envelope.data,
      attempts: message.attempts,
      ...(headers === undefined ? {} : { headers }),
    };

    try {
      await registration.processor(job);
    } catch (error: unknown) {
      if (message.attempts >= budget) {
        this.#logger?.()?.warn('cloudflare-queue: job exhausted its attempts', {
          queue,
          job: name,
          id: envelope.id,
          attempts: message.attempts,
          budget,
        });
        await this.#notifyFailed(registration, job, error);
        await this.#settleExhausted(registration.deadLetter, queue, message, envelope, error);
        return;
      }
      this.#logger?.()?.error('cloudflare-queue: processor failed, message retried', {
        queue,
        job: name,
        id: envelope.id,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#retry(message);
      return;
    }

    message.ack();
  }

  /**
   * A job's attempt budget: `maxRetries`, or the job's own `maxAttempts` when
   * lower. A larger `maxAttempts` is capped (the platform stops first), with
   * one warning per job name.
   */
  #budget(name: string, envelope: JobEnvelope): number {
    const requested = envelope.maxAttempts;
    if (requested === undefined) return this.#maxRetries;
    if (requested > this.#maxRetries && !this.#capWarned.has(name)) {
      this.#capWarned.add(name);
      this.#logger?.()?.warn('cloudflare-queue: maxAttempts above what the queue retries; capped', {
        job: name,
        maxAttempts: requested,
        maxRetries: this.#maxRetries,
        budget: this.#maxRetries,
        advice: "raise max_retries in wrangler.toml and the queue arm's maxRetries together",
      });
    }
    return Math.min(requested, this.#maxRetries);
  }

  /** Runs the registration's `onFailed`, guarded: a throw is logged, never rethrown. */
  async #notifyFailed(registration: Registration, job: IJob, error: unknown): Promise<void> {
    if (registration.onFailed === undefined) return;
    try {
      await registration.onFailed(job, error);
    } catch (callbackError: unknown) {
      this.#logger?.()?.error('cloudflare-queue: onFailed callback threw', {
        job: job.name,
        id: job.id,
        error: callbackError instanceof Error ? callbackError.name : typeof callbackError,
      });
    }
  }

  /**
   * Settles an exhausted message: forwards it to the dead-letter producer and
   * acks, or acks and warns when the target is `false`. A failed send retries,
   * so the payload is not lost while a delivery remains; on the platform's
   * last delivery a refused copy is sent once more as the job arrived, without
   * the dead-letter fields, and only if that fails too does the job leave the
   * adapter's hands (the platform writes it to `dead_letter_queue` or deletes
   * it), which is logged.
   * @param reason - The processor's error, or the reason no processor ran
   */
  async #settleExhausted(
    target: IQueueProducer | false,
    queue: string,
    message: IQueueMessage,
    envelope: JobEnvelope | undefined,
    reason: unknown,
  ): Promise<void> {
    const where =
      envelope === undefined ? { messageId: message.id } : { job: envelope.name, id: envelope.id };
    if (target === false) {
      message.ack();
      this.#reportQuietly(
        'warn',
        `cloudflare-queue: job discarded after ${message.attempts} attempts; deadLetterQueue is false`,
        { queue, ...where, attempts: message.attempts },
      );
      return;
    }
    // On a delivery past the processor's last attempt the copy carries no
    // error text, so a payload near the Queues size limit is not pushed over it.
    const lastChance = message.attempts > this.#maxRetries;
    const now = this.#now;
    const copy = {
      ...(envelope === undefined ? { body: message.body } : envelope),
      ...(now === undefined ? {} : { failedAt: now() }),
      attempts: message.attempts,
      ...(lastChance ? {} : { error: describeError(reason) }),
    };
    // A body from another producer that JSON cannot carry (an ArrayBuffer
    // becomes `{}`, a Date a string) is forwarded with structured clone.
    // Everything else, envelopes included, stays JSON: pull consumers and the
    // dashboard cannot decode `v8`.
    const lossless = envelope === undefined && !isJsonCarried(message.body);
    try {
      await (lossless ? target.send(copy, STRUCTURED_CLONE) : target.send(copy));
    } catch (error: unknown) {
      // On the last delivery the added fields can push a job near the Queues
      // size limit over it; the original body is sent instead, once, so
      // the job still reaches the dead-letter queue.
      if (lastChance && (await this.#sendOriginal(target, message, lossless))) {
        // Settled before it is reported, so a logger that throws cannot undo it.
        message.ack();
        this.#reportQuietly(
          'warn',
          'cloudflare-queue: dead-letter copy refused on the last delivery; the original job was sent',
          {
            queue,
            ...where,
            attempts: message.attempts,
          },
        );
        return;
      }
      this.#retry(message);
      this.#reportQuietly(
        'error',
        lastChance
          ? 'cloudflare-queue: dead-letter send failed on the last delivery; the job leaves the ' +
              "adapter (the platform's dead_letter_queue, or deleted)"
          : 'cloudflare-queue: dead-letter send failed, message retried',
        {
          queue,
          ...where,
          attempts: message.attempts,
          error: error instanceof Error ? error.name : typeof error,
        },
      );
      return;
    }
    message.ack();
  }

  /**
   * Sends the message's body as it arrived (a job envelope, or an unroutable
   * body as is), so nothing is added to a message near the size limit.
   *
   * @param lossless - Whether the body needs more than JSON to arrive intact
   * @returns Whether the send succeeded
   */
  async #sendOriginal(
    target: IQueueProducer,
    message: IQueueMessage,
    lossless: boolean,
  ): Promise<boolean> {
    try {
      await (lossless
        ? target.send(message.body, originalSerialization(message.body))
        : target.send(message.body));
      return true;
    } catch {
      return false;
    }
  }

  /** Logs a settled message's outcome; a logger that throws does not reach dispatch. */
  #reportQuietly(level: 'warn' | 'error', text: string, meta?: LogMetadata): void {
    try {
      this.#logger?.()?.[level](text, meta);
    } catch {
      // The message is already settled; only the log line is lost.
    }
  }

  /** Retries a message with the configured spacing, or the queue's own `retry_delay`. */
  #retry(message: IQueueMessage): void {
    const delay = this.#retryDelay;
    if (delay === undefined) {
      message.retry();
      return;
    }
    let seconds: number;
    try {
      seconds = typeof delay === 'number' ? delay : delay(message.attempts);
    } catch {
      seconds = Number.NaN;
    }
    if (!Number.isFinite(seconds)) {
      message.retry();
      if (!this.#retryDelayWarned) {
        this.#retryDelayWarned = true;
        this.#reportQuietly(
          'warn',
          "cloudflare-queue: retryDelaySeconds threw or returned a non-finite value; retried with the queue's own retry_delay",
        );
      }
      return;
    }
    // Passed even when 0: a bare retry() keeps the consumer's `retry_delay`,
    // and an explicit 0 is how Cloudflare overrides it.
    const bounded = Math.min(this.#maxDelaySeconds, Math.max(0, Math.ceil(seconds)));
    message.retry({ delaySeconds: bounded });
  }

  /**
   * Reports a message the consumer could not route.
   *
   * @param queue - The queue the batch came from
   * @param message - The message being retried
   * @param envelope - Present when the body parsed but its name had no
   * processor; absent when the body is not an envelope at all
   */
  #reportUnroutable(
    queue: string,
    message: IQueueMessage,
    envelope: JobEnvelope | undefined,
    outcome: 'retried' | 'discarded' | 'forwarding to the dead-letter queue' = 'retried',
  ): void {
    this.#logger?.()?.error(
      outcome === 'retried'
        ? 'cloudflare-queue: message not routable, retried'
        : `cloudflare-queue: message not routable on its last attempt, ${outcome}`,
      {
        queue,
        messageId: message.id,
        ...(envelope === undefined
          ? { reason: 'body is not a job envelope' }
          : { reason: 'no processor registered', job: envelope.name }),
        registered: [...this.#processors.keys()],
      },
    );
  }

  /**
   * Translates `AddJobOptions.delayMs` into the platform's `delaySeconds`.
   *
   * Rounded **up**, so a caller asking for 1500 ms never has the job delivered
   * early; clamped at zero, so a negative delay is "now" rather than a value
   * the platform rejects.
   */
  #sendOptions(name: string, delayMs: number | undefined): { readonly delaySeconds?: number } {
    if (delayMs === undefined) return {};

    const delaySeconds = Math.max(0, Math.ceil(delayMs / 1000));
    if (delaySeconds > this.#maxDelaySeconds) {
      throw new CloudflareUnsupportedError(
        `Cloudflare Queues accepts a delay of at most ${this.#maxDelaySeconds}s, but ` +
          `add('${name}', …) asked for ${delaySeconds}s (${delayMs}ms). Schedule the work with ` +
          'a Cron Trigger instead, or enqueue it closer to when it should run.',
      );
    }
    return { delaySeconds };
  }
}
