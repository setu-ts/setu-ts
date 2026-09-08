/**
 * Internal telemetry decorator for the queue ingress.
 *
 * The queue is deferred work whose whole diagnostic value is "which request
 * caused this". Before this decorator the answer was unavailable: the trace
 * survived a broker hop and ended at a queue hop, with nothing distinguishing
 * "this work had no cause" from "the cause was lost" (X34-1 / X29-3).
 *
 * @module
 */

import {
  type AddJobOptions,
  contextToTraceparent,
  type IJob,
  type IQueue,
  type ITelemetryService,
  type JobProcessor,
  parseTraceparentToContext,
  type ProcessOptions,
  type RecurringOptions,
  TELEMETRY_CONTEXT_OPAQUE,
  TRACEPARENT_HEADER,
} from '@setu-ts/common';

/**
 * Wraps an {@linkcode IQueue} with producer and consumer tracing.
 *
 * Mirrors `messaging-plugin`'s `TracedBroker` deliberately: the same codec, the
 * same header name, and the same producer/consumer span shape, so the two
 * ingresses cannot drift on what a propagated trace means. The LAYER differs
 * and that difference is load-bearing — `TracedBroker` decorates the broker
 * ADAPTER, while the queue's adapter seam (`QueueAdapter`) takes an already-
 * built `StoredJob` and never invokes a processor, so a decorator there could
 * inject nothing and could not open a consumer span at all. `IQueue` is the one
 * layer at which both halves of the trace are reachable.
 *
 * **Both halves must be reached through this object.** The plugin routes every
 * processor registration — the declarative `processors` arm as well as an
 * application's imperative `process()` — through it, because a wrapper reachable
 * only via the registered capability would leave the declarative arm untraced.
 *
 * **A declared M86 ingress behaviour runs OUTSIDE the consumer span.** The
 * behaviour chain is applied by a `QueueService` subclass, and a subclass is
 * necessarily inner-at-registration and therefore outer-at-dispatch; messaging
 * composes the other way round (`PipelinedBroker(TracedBroker(broker))`) and so
 * runs behaviours inside the span. The processor's own work — which is what
 * X34-1 measured — is correctly parented in both orders, and with no behaviours
 * declared the question does not arise. Closing the asymmetry means converting
 * that subclass into a wrapper, which belongs to whoever measures the behaviour
 * hop.
 *
 * @internal
 */
export class TracedQueue implements IQueue {
  readonly #queue: IQueue;
  readonly #telemetry: ITelemetryService;

  /**
   * @param queue - The queue to decorate
   * @param telemetry - The resolved telemetry capability
   */
  constructor(queue: IQueue, telemetry: ITelemetryService) {
    this.#queue = queue;
    this.#telemetry = telemetry;
  }

  /**
   * Enqueues inside a producer span and injects the span's `traceparent` into
   * the job's headers.
   *
   * The caller's own headers are preserved and the `traceparent` is merged on
   * top, so an application using the channel for its own purposes keeps it.
   *
   * The framework's `traceparent` WINS over a caller-supplied one, which is the
   * opposite of `logger-plugin`'s rule that a caller's own `trace_id` wins — and
   * the asymmetry is deliberate. There, the field DESCRIBES the current span and
   * a caller writing it knows something the framework does not. Here it is the
   * propagation channel itself, and the enqueue span is by construction the
   * job's immediate parent: honoring a caller's value would detach the job from
   * the span that actually created it. An upstream context is not lost by this —
   * it is already this span's own parent.
   *
   * @typeParam T - The job payload type
   * @param name - Job name
   * @param data - Job payload
   * @param options - Delay, attempt cap and caller-supplied headers
   * @returns The queue-assigned job ID
   */
  add<T>(name: string, data: T, options?: AddJobOptions): Promise<string> {
    return this.#telemetry.withSpan(
      `enqueue ${name}`,
      (span) => {
        const traceparent = contextToTraceparent({
          _opaque: TELEMETRY_CONTEXT_OPAQUE,
          ...span.spanContext(),
        });
        // A noop or unsampled span reports empty identifiers, and the codec
        // then yields null. Injecting a malformed `traceparent` would be worse
        // than injecting none: the consumer would parent from a trace that does
        // not exist rather than starting an honest root.
        if (traceparent === null) {
          return this.#queue.add(name, data, options);
        }
        return this.#queue.add(name, data, {
          ...options,
          headers: { ...options?.headers, [TRACEPARENT_HEADER]: traceparent },
        });
      },
      { kind: 'producer', attributes: attributesFor(name, 'enqueue') },
    );
  }

  /**
   * Registers the processor wrapped in a consumer span parented from the
   * delivered job's headers.
   *
   * A job carrying no `traceparent` — enqueued before this channel existed, by
   * a non-framework producer, or with telemetry absent at enqueue time — starts
   * a root span rather than failing: untraced work still has to run.
   *
   * @typeParam T - The job payload type
   * @param name - Job name
   * @param processor - The application's processor
   * @param options - Concurrency and failure callback, passed through
   */
  process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void {
    this.#queue.process<T>(
      name,
      (job: IJob<T>) =>
        this.#telemetry.withSpan(
          `process ${name}`,
          async () => await processor(job),
          {
            kind: 'consumer',
            attributes: {
              ...attributesFor(name, 'process'),
              'messaging.message.id': job.id,
            },
            parentContext: parseTraceparentToContext(
              job.headers?.[TRACEPARENT_HEADER] ?? null,
            ),
          },
        ),
      options,
    );
  }

  /**
   * Schedules a recurring job, untraced.
   *
   * Deliberately NOT wrapped: a recurring job fires on a schedule, so the call
   * that registers it is not the cause of any particular run, and parenting
   * every future run to whatever request happened to configure the schedule
   * would assert a causal link that does not exist. This is the same reason
   * X34 records the scheduler's fresh root as correct.
   *
   * @typeParam T - The job payload type
   * @param name - Job name
   * @param data - Job payload
   * @param options - The cron expression
   * @returns Resolves when scheduled
   */
  addRecurring<T>(name: string, data: T, options: RecurringOptions): Promise<void> {
    return this.#queue.addRecurring(name, data, options);
  }
}

/**
 * Builds the OTel messaging attributes for a queue span.
 *
 * `messaging.system` is `'queue'` rather than the adapter's name because this
 * decorator sits above the adapter seam and never learns which one is beneath
 * it — and the honest value is the one that is true for every adapter.
 *
 * @param name - Job name, reported as the destination
 * @param operation - Which half of the hop this span covers
 * @returns The attribute map
 */
function attributesFor(
  name: string,
  operation: 'enqueue' | 'process',
): Readonly<Record<string, string>> {
  return {
    'messaging.system': 'queue',
    'messaging.destination.name': name,
    'messaging.operation': operation,
  };
}
