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
  ProcessOptions,
  RecurringOptions,
} from '@hono-enterprise/common';
import type { LoggerSource } from '../background/wait-until.ts';
import type { IQueueMessage, IQueueMessageBatch, IQueueProducer } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import { runBounded } from './bounded-map.ts';
import type { JobEnvelope } from './job-envelope.ts';
import { encodeJobEnvelope, isJobEnvelope } from './job-envelope.ts';

/** The platform's maximum `delaySeconds`, and this queue's default cap. */
const PLATFORM_MAX_DELAY_SECONDS = 86_400;

/** Default per-processor concurrency, matching `ProcessOptions`' documented default. */
const DEFAULT_CONCURRENCY = 1;

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
}

/** A registered processor and the concurrency its registration asked for. */
interface Registration {
  readonly processor: JobProcessor<unknown>;
  readonly concurrency: number;
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
 *   plugins: [RuntimePlugin({ env }), CloudflarePlugin({ env, queue: { binding: 'JOBS' } })],
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
  readonly #processors = new Map<string, Registration>();

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
    const envelope = encodeJobEnvelope(name, id, data, options?.maxAttempts);

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
   * this name run at a time
   */
  process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void {
    this.#processors.set(name, {
      processor: processor as JobProcessor<unknown>,
      concurrency: options?.concurrency ?? DEFAULT_CONCURRENCY,
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
  // deno-lint-ignore require-await -- IQueue.addRecurring is async by contract
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
   * Every message is acked or retried exactly once:
   *
   * - a body that is not a readable envelope → `retry()`, because a message the
   *   consumer cannot route is a configuration problem and acking would discard
   *   it permanently and silently;
   * - a name with no registered processor → `retry()`, same reason;
   * - `attempts` past the envelope's `maxAttempts` → `ack()` without running
   *   the processor, since the caller asked for the job to stop;
   * - a processor that throws → `retry()`, leaving the queue's own
   *   `max_retries` and dead-letter configuration to decide what happens next;
   * - a processor that resolves → `ack()`.
   *
   * @param batch - The delivered batch
   * @returns Resolves once every message has been acked or retried
   */
  async dispatch(batch: IQueueMessageBatch): Promise<void> {
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
        this.#reportUnroutable(batch.queue, message, envelope);
        message.retry();
        continue;
      }

      const group = routable.get(envelope.name);
      if (group === undefined) {
        routable.set(envelope.name, { at: registration, work: [{ message, envelope }] });
      } else {
        group.work.push({ message, envelope });
      }
    }

    await Promise.all(
      [...routable].map(([name, group]) =>
        runBounded(
          group.work,
          group.at.concurrency,
          (delivery) => this.#runOne(batch.queue, name, group.at, delivery),
        )
      ),
    );
  }

  /** Runs one message through its processor and settles its disposition. */
  async #runOne(
    queue: string,
    name: string,
    registration: Registration,
    delivery: Delivery,
  ): Promise<void> {
    const { message, envelope } = delivery;

    if (envelope.maxAttempts !== undefined && message.attempts > envelope.maxAttempts) {
      this.#logger?.()?.warn('cloudflare-queue: job exhausted its attempts', {
        queue,
        job: name,
        id: envelope.id,
        attempts: message.attempts,
        maxAttempts: envelope.maxAttempts,
      });
      message.ack();
      return;
    }

    const job: IJob = {
      id: envelope.id,
      name,
      data: envelope.data,
      attempts: message.attempts,
    };

    try {
      await registration.processor(job);
      message.ack();
    } catch (error: unknown) {
      this.#logger?.()?.error('cloudflare-queue: processor failed, message retried', {
        queue,
        job: name,
        id: envelope.id,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
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
  ): void {
    this.#logger?.()?.error('cloudflare-queue: message not routable, retried', {
      queue,
      messageId: message.id,
      ...(envelope === undefined
        ? { reason: 'body is not a job envelope' }
        : { reason: 'no processor registered', job: envelope.name }),
      registered: [...this.#processors.keys()],
    });
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
