import { BackplaneFanOutUnsupportedError } from '../errors.ts';
import { FrameAge, type BackplaneReporter } from './frame-age.ts';
/**
 * Backplane transport over the registered message broker.
 *
 * @module
 * @since 0.2.0
 */

import type {
  IMessageBroker,
  IRealtimeBackplane,
  IRealtimeHandlerErrorReporter,
  ISubscription,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '@setu-ts/common';
import { BackendOutcomeUnknownError, dispatchRealtimeFrame, toBackendFault } from '@setu-ts/common';
import { realtimeObserverOf } from '../diagnostics/realtime-observations.ts';
import { createTransportHandlerReporter } from './handler-errors.ts';

/**
 * Narrows an arriving broker payload to a {@linkcode RealtimeFrame}.
 *
 * A broker topic is shared infrastructure, so a malformed or foreign message
 * must be dropped rather than crash the delivery loop or reach a consumer as a
 * half-built frame.
 *
 * @param value - The deserialized broker payload
 * @returns True when `value` is a well-formed frame
 * @since 0.2.0
 */
export function isRealtimeFrame(value: unknown): value is RealtimeFrame {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const frame = value as Partial<RealtimeFrame>;
  return (
    (frame.kind === 'ws-room' || frame.kind === 'sse-channel') &&
    typeof frame.origin === 'string' &&
    typeof frame.name === 'string' &&
    typeof frame.data === 'string' &&
    (frame.binary === undefined || typeof frame.binary === 'boolean') &&
    (frame.exceptId === undefined || typeof frame.exceptId === 'string')
  );
}

/**
 * Carries frames over whatever broker is registered under
 * `CAPABILITIES.MESSAGING`.
 *
 * This reuses every broker the messaging plugin already ships — in-memory,
 * Redis Streams, RabbitMQ, NATS, Kafka, Pub/Sub and Service Bus — and requires
 * the broker to confirm independent fan-out delivery.
 * The broker's own `connect`/`disconnect` are left to its owning plugin; this
 * transport only publishes and subscribes.
 *
 * @since 0.2.0
 */
export class MessagingBackplane implements IRealtimeBackplane {
  readonly origin: string;
  readonly #broker: IMessageBroker;
  readonly #topic: string;
  readonly #handlers = new Set<RealtimeFrameHandler>();
  /** The most recent 100 errors thrown by subscribers during delivery, oldest first. */
  readonly #handlerErrors: Error[] = [];
  readonly #handlerReporter: IRealtimeHandlerErrorReporter;
  readonly #frameAge: FrameAge;
  #subscription: ISubscription | undefined;
  #opening: Promise<void> | undefined;
  #generation = 0;

  /**
   * M70c: delegates to the resolved broker's `isHealthy?()` — the only way the
   * backplane can report the broker's reachability without importing the
   * messaging plugin (§3.1). Assigned only when the broker provides the
   * member: a broker that omits it is *unknown*, and the indicator reads
   * absence of `isHealthy` (not `false`) as that.
   *
   * M90b (X21-1): the delegation calls through the OWNER —
   * `broker.isHealthy()`, not a detached `const probe = broker.isHealthy`
   * reference. A broker whose `isHealthy` reads instance state
   * (`ServiceBusBroker`'s private probe cache, among others) throws a bare
   * `TypeError` when invoked unbound, which a health endpoint then reports
   * as an error rather than a fact. It retains the resolved broker's own
   * probe cache rather than adding a duplicate backplane-level cache.
   *
   * @since 0.2.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param broker - The broker resolved from `CAPABILITIES.MESSAGING`
   * @param origin - This instance's identity
   * @param topic - The topic every instance shares
   * @param reporter - Optional subscriber and transport diagnostic sink; history is always retained
   * @param now - Optional wall clock for timestamps and frame age checks
   * @param maxFrameAgeMs - Maximum frame age, default 0 (disabled)
   * @returns The messaging transport
   * @throws {RangeError} When maxFrameAgeMs is outside the finite timer range
   * @since 0.14.0
   */
  constructor(
    broker: IMessageBroker,
    origin: string,
    topic: string,
    reporter?: BackplaneReporter,
    now?: () => number,
    maxFrameAgeMs = 0,
  ) {
    this.#broker = broker;
    this.origin = origin;
    this.#topic = topic;
    this.#handlerReporter = createTransportHandlerReporter(this.#handlerErrors, reporter);
    this.#frameAge = new FrameAge(maxFrameAgeMs, now, reporter?.warn?.bind(reporter));
    // Captured into a local before the guard: the delegation below must call
    // the member through its OWNER, and a `const` local keeps the narrowed
    // function type inside the closure.
    const probe = broker.isHealthy;
    if (typeof probe === 'function') {
      this.isHealthy = (): Promise<boolean> => probe.call(broker);
    }
  }

  /** The most recent 100 errors thrown by subscribers during delivery, oldest first. */
  get handlerErrors(): readonly Error[] {
    return this.#handlerErrors;
  }

  connect(): Promise<void> {
    if (this.#subscription !== undefined) return Promise.resolve();
    if (this.#opening !== undefined) return this.#opening;
    const generation = this.#generation;
    const opening = Promise.resolve()
      .then(() =>
        this.#broker.subscribe<unknown>(
          this.#topic,
          (message): void => {
            if (
              generation !== this.#generation ||
              !isRealtimeFrame(message) ||
              message.origin === this.origin
            )
              return;
            const frame = this.#frameAge.receive(message);
            if (frame === null) return;
            const delivered = dispatchRealtimeFrame(this.#handlers, frame, this.#handlerReporter);
            realtimeObserverOf(this)?.observe('backplane-receive', delivered);
          },
          { fanOut: true },
        ),
      )
      .then(async (subscription) => {
        if (generation !== this.#generation || subscription.fanOut !== true) {
          try {
            await subscription.unsubscribe();
          } catch (error) {
            if (generation === this.#generation)
              throw new BackplaneFanOutUnsupportedError({ cause: error });
            throw error;
          }
          if (generation === this.#generation) throw new BackplaneFanOutUnsupportedError();
          return;
        }
        this.#subscription = subscription;
      })
      .finally(() => {
        if (this.#opening === opening) this.#opening = undefined;
      });
    this.#opening = opening;
    return opening;
  }

  publish(frame: RealtimeFrame): Promise<void> {
    // M98l: counted as `backplane-publish` when observed. Completion means
    // the broker accepted the message, never that a peer received it.
    const observer = realtimeObserverOf(this);
    return observer === undefined
      ? this.#publish(frame)
      : observer.observePublish(() => this.#publish(frame));
  }

  /** The publication itself: handed to the broker on the shared topic. */
  async #publish(frame: RealtimeFrame): Promise<void> {
    try {
      await this.#broker.publish(this.#topic, this.#frameAge.stamp(frame));
    } catch (error) {
      // A publish timeout or an outcome-unknown backend fault (including a raw
      // connection error after the write) means the broker may still deliver
      // the frame. PublishTimeoutError is matched by name: it belongs to the
      // messaging plugin, which this package cannot import.
      this.#frameAge.publishFailed(
        (error instanceof Error && error.name === 'PublishTimeoutError') ||
          toBackendFault(error, 'realtime-backplane-plugin: messaging transport') instanceof
            BackendOutcomeUnknownError,
      );
      throw error;
    }
    this.#frameAge.publishSucceeded();
  }

  subscribe(handler: RealtimeFrameHandler): Promise<() => void> {
    this.#handlers.add(handler);
    return Promise.resolve(() => {
      this.#handlers.delete(handler);
    });
  }

  async close(): Promise<void> {
    this.#generation++;
    // A stale open must not be handed to a later connect().
    this.#opening = undefined;
    this.#handlers.clear();
    const subscription = this.#subscription;
    this.#subscription = undefined;
    if (subscription !== undefined) {
      await subscription.unsubscribe();
    }
  }
}
