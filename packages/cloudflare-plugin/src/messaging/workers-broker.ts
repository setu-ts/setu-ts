/**
 * `WorkersBroker` — the committed {@linkcode IMessageBroker} over Cloudflare
 * Queues, plus an optional Durable Object reply inbox for request-reply.
 *
 * The two halves of the contract fall differently on this platform, and the
 * shape of this class is what that asymmetry forces:
 *
 * - **`publish`** is a producer-binding call, available from any invocation.
 * - **`subscribe`** cannot be a live socket. A Cloudflare queue consumer is a
 *   module-level `queue` export, so a subscription is registered here and
 *   delivered by the handler {@linkcode createMessagingHandler} builds — the
 *   same split `WorkersQueue` already has between `process` and `dispatch`.
 * - **`request`/`respond`** need a reply path a queue cannot provide, because a
 *   queue reaches exactly one consumer Worker and never the caller. The reply
 *   travels through a Durable Object instead, which is why that half is opt-in:
 *   it needs a namespace binding and a DO class the application exports.
 *
 * @module
 * @since 0.2.0
 */

import type {
  IMessageBroker,
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
  TimerHandle,
} from '@setu-ts/common';

import type { LoggerSource } from '../background/wait-until.ts';
import type {
  IDurableObjectNamespace,
  IQueueMessage,
  IQueueMessageBatch,
  IQueueProducer,
} from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import { runBounded } from '../queues/bounded-map.ts';
import type { PublishEnvelope, QueueEnvelope, RequestEnvelope } from './message-envelope.ts';
import {
  encodePublishEnvelope,
  encodeReplyEnvelope,
  encodeRequestEnvelope,
  isQueueEnvelope,
  isReplyEnvelope,
  isRequestEnvelope,
} from './message-envelope.ts';
import { deliverReply } from './reply-delivery.ts';
import type { ReplyInbox } from './reply-inbox.ts';
import { openReplyInbox } from './reply-inbox.ts';
import { DEFAULT_REQUEST_TIMEOUT_MS, RequestCorrelation } from './request-correlation.ts';
import { SubscriptionTable } from './subscription-table.ts';

/** How many of one topic's handlers run at a time within a delivered batch. */
const DISPATCH_CONCURRENCY = 10;

/** A responder, as `respond` stores it before its payload types are erased. */
type StoredResponder = RequestHandler<unknown, unknown>;

/**
 * The runtime capabilities this broker needs. {@linkcode IRuntimeServices}
 * satisfies it.
 *
 * Narrower than the whole of `IRuntimeServices` for the reason
 * {@linkcode JobIdSource} is: interface segregation (AI_GUIDELINES §1.1), so a
 * test double implements the four members that are read rather than the dozens
 * that are not. It is still a port rather than direct `crypto`/`setTimeout`
 * calls, because §4.2 routes every runtime capability through
 * `IRuntimeServices` — which is why the plugin constructs this class.
 *
 * @since 0.2.0
 */
export interface BrokerRuntime {
  /**
   * A fresh unique id, for message ids, correlation ids, and inbox addresses.
   *
   * @returns The id
   */
  uuid(): string;
  /**
   * Wall-clock milliseconds, for `MessageMetadata.timestamp`.
   *
   * @returns The epoch time
   */
  now(): number;
  /**
   * Schedules a reply timeout.
   *
   * @param fn - Invoked when the budget elapses
   * @param ms - The budget
   * @returns The handle to cancel with
   */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /**
   * Cancels a reply timeout.
   *
   * @param handle - The handle to cancel
   */
  clearTimeout(handle: TimerHandle): void;
}

/**
 * The Durable Object namespace serving reply inboxes, plus its binding name.
 *
 * Present only when the plugin's `messaging.rpc` arm is configured; its absence
 * is what makes `request` and `respond` refuse.
 *
 * @since 0.2.0
 */
export interface ReplyInboxBinding {
  /** The Durable Object namespace binding. */
  readonly namespace: IDurableObjectNamespace;
  /** The binding name, for error messages. */
  readonly binding: string;
  /** Reply budget when `RequestOptions.timeoutMs` is omitted. */
  readonly defaultTimeoutMs?: number;
}

/**
 * Options for {@linkcode WorkersBroker}.
 *
 * @since 0.2.0
 */
export interface WorkersBrokerOptions {
  /**
   * Resolves the logger at the moment a dispatch path needs it.
   *
   * A **thunk**, not an `ILogger`, for the reason `WorkersQueueOptions.logger`
   * documents: the plugin context resolves `logger` lazily through a Proxy that
   * answers `undefined` until a logger is registered, so capturing the value
   * during `register()` would silence a logger registered afterwards.
   */
  readonly logger?: LoggerSource;
  /**
   * Enables `request`/`respond`. Omitted, both throw
   * {@linkcode CloudflareUnsupportedError} naming the arm to add.
   */
  readonly replyInbox?: ReplyInboxBinding;
}

/**
 * A message broker backed by Cloudflare Queues.
 *
 * Consuming requires the application to export the handler
 * {@linkcode createMessagingHandler} builds, and the queue to be declared as a
 * consumer in `wrangler.toml`:
 *
 * @example
 * ```typescript
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin({ env }),
 *     CloudflarePlugin({ env, messaging: { binding: 'MESSAGES' } }),
 *   ],
 * });
 * await app.start();
 *
 * const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
 * await broker.subscribe<{ id: string }>('user.created', async (user) => {
 *   await mailer.send(user.id);
 * });
 *
 * export default { fetch: app.fetch, queue: createMessagingHandler(app) };
 * ```
 * @since 0.2.0
 */
export class WorkersBroker implements IMessageBroker {
  readonly #producer: IQueueProducer;
  readonly #runtime: BrokerRuntime;
  readonly #logger: LoggerSource | undefined;
  readonly #replyInbox: ReplyInboxBinding | undefined;

  readonly #subscribers = new SubscriptionTable<MessageHandler<unknown>>();
  readonly #responders = new SubscriptionTable<StoredResponder>();
  readonly #correlation: RequestCorrelation;

  /** The in-flight or settled inbox open, so overlapping requests share one. */
  #inboxInit: Promise<ReplyInbox> | null = null;
  /** Bumped by `disconnect()`, so an open finishing afterwards is retired. */
  #generation = 0;

  /**
   * @param producer - The Queues producer binding
   * @param runtime - Id, clock, and timer source; pass `IRuntimeServices`
   * @param options - Logger thunk and the optional reply-inbox binding
   */
  constructor(
    producer: IQueueProducer,
    runtime: BrokerRuntime,
    options: WorkersBrokerOptions = {},
  ) {
    this.#producer = producer;
    this.#runtime = runtime;
    this.#logger = options.logger;
    this.#replyInbox = options.replyInbox;
    this.#correlation = new RequestCorrelation({
      setTimeout: (fn, ms) => runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => runtime.clearTimeout(handle),
    });
  }

  /**
   * No-op: a producer binding is ready as soon as the Worker has its `env`, and
   * there is no connection to open.
   *
   * @returns Resolves immediately
   */
  connect(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Closes the reply inbox, rejects every in-flight request, and drops every
   * subscription.
   *
   * @returns Resolves once the inbox is closed
   */
  async disconnect(): Promise<void> {
    this.#generation += 1;
    this.#correlation.rejectAll(
      new Error('The Cloudflare message broker disconnected before a reply was received.'),
    );
    this.#subscribers.clear();
    this.#responders.clear();

    // Await an in-flight open before tearing down. Reading a resolved handle
    // alone would miss a `disconnect()` landing while the upgrade is still in
    // flight, leaving a live socket nothing owns.
    const init = this.#inboxInit;
    this.#inboxInit = null;
    if (init === null) return;
    try {
      const inbox = await init;
      await inbox.close();
    } catch {
      // The open itself failed, so there is no socket to release.
      return;
    }
  }

  /**
   * Publishes a message to a topic.
   *
   * @typeParam T - The payload type
   * @param topic - Destination topic
   * @param message - The payload, serialized as JSON by the platform
   * @returns Resolves once the platform has accepted the message
   */
  async publish<T>(topic: string, message: T): Promise<void> {
    await this.#producer.send(encodePublishEnvelope(topic, this.#runtime.uuid(), message));
  }

  /**
   * Subscribes to a topic.
   *
   * Registration only: delivery happens when the Worker's `queue` export
   * dispatches a batch into {@linkcode WorkersBroker.dispatch}.
   *
   * @typeParam T - The payload type
   * @param topic - Source topic
   * @param handler - Invoked per delivered message
   * @param options - `queue` load-balances across members of one group
   * @returns The active subscription
   */
  subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return Promise.resolve(
      this.#register(this.#subscribers, topic, handler as MessageHandler<unknown>, options),
    );
  }

  /**
   * Sends a request and awaits its single correlated reply.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - Destination topic a responder is listening on
   * @param message - The request payload
   * @param options - Reply timeout behavior
   * @returns The reply payload
   * @throws {CloudflareUnsupportedError} When the `messaging.rpc` arm is absent
   * @throws {CloudflareRequestTimeoutError} When no reply arrives in time
   * @throws {CloudflareRemoteHandlerError} When the responder threw
   */
  async request<TReq, TRes>(
    topic: string,
    message: TReq,
    options?: RequestOptions,
  ): Promise<TRes> {
    const inboxBinding = this.#requireReplyInbox('request');
    const generation = this.#generation;
    const inbox = await this.#openInbox(inboxBinding);

    if (generation !== this.#generation) {
      throw new Error('The Cloudflare message broker disconnected before a reply was received.');
    }

    const correlationId = this.#runtime.uuid();
    const timeoutMs = options?.timeoutMs ?? inboxBinding.defaultTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS;

    // Registered BEFORE the publish, so a reply that arrives while `send` is
    // still settling finds its pending entry rather than being dropped as late.
    const reply = this.#correlation.register<TRes>(correlationId, topic, timeoutMs);

    try {
      await this.#producer.send(
        encodeRequestEnvelope(
          topic,
          this.#runtime.uuid(),
          correlationId,
          inbox.address,
          message,
        ),
      );
    } catch (error: unknown) {
      // The caller receives this failure directly, so the pending entry would
      // otherwise hold a timer for a request that never left.
      this.#correlation.abandon(correlationId);
      throw error;
    }

    return await reply;
  }

  /**
   * Registers a responder for a request topic.
   *
   * @typeParam TReq - The request payload type
   * @typeParam TRes - The reply payload type
   * @param topic - The request topic to respond on
   * @param handler - Invoked per request; its result is returned to the caller
   * @param options - `queue` load-balances across members of one group
   * @returns The active subscription
   * @throws {CloudflareUnsupportedError} When the `messaging.rpc` arm is absent
   */
  // deno-lint-ignore require-await -- the refusal below must REJECT, not throw
  async respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    // `async` so a missing `rpc` arm arrives as a rejection: this is declared
    // `=> Promise<ISubscription>`, and a caller writing
    // `broker.respond(...).catch(report)` would not catch a synchronous throw.
    // The same reasoning as `createQueueHandler`'s handler.
    this.#requireReplyInbox('respond');
    return this.#register(this.#responders, topic, handler as StoredResponder, options);
  }

  /**
   * Dispatches one delivered batch into the registered subscribers and
   * responders.
   *
   * Every message is acked or retried exactly once:
   *
   * - a body that is not a readable envelope → `retry()`, because a foreign
   *   producer or a version skew is a configuration problem and acking would
   *   discard the message permanently and silently;
   * - a publish whose topic has **no** subscriber → `ack()`, because publishing
   *   to a topic nobody listens on is ordinary pub/sub, and retrying would burn
   *   the queue's retry budget and dead-letter every fire-and-forget message;
   * - a publish whose handler throws → `retry()`, leaving the queue's own
   *   `max_retries` and dead-letter configuration to decide what happens next;
   * - a request whose topic has no responder, or whose responder throws →
   *   `ack()` after sending the caller a failed reply, because the caller is
   *   waiting and a redelivery would re-run a handler that already ran.
   *
   * @param batch - The delivered batch
   * @returns Resolves once every message has been acked or retried
   */
  async dispatch(batch: IQueueMessageBatch): Promise<void> {
    const routable: { readonly message: IQueueMessage; readonly envelope: QueueEnvelope }[] = [];

    for (const message of batch.messages) {
      if (!isQueueEnvelope(message.body)) {
        this.#logger?.()?.error('cloudflare-messaging: message not readable, retried', {
          queue: batch.queue,
          messageId: message.id,
          reason: 'body is not a Setu-TS message envelope',
        });
        message.retry();
        continue;
      }
      routable.push({ message, envelope: message.body });
    }

    await runBounded(
      routable,
      DISPATCH_CONCURRENCY,
      ({ message, envelope }) =>
        isRequestEnvelope(envelope)
          ? this.#dispatchRequest(batch.queue, message, envelope)
          : this.#dispatchPublish(batch.queue, message, envelope),
    );
  }

  /**
   * Routes one arriving reply into the request awaiting it.
   *
   * @param raw - The payload as the inbox socket delivered it
   */
  #onReply(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A reply inbox is addressed by a UUID no other producer knows, so this
      // is version skew rather than cross-talk. Dropping it lets the caller's
      // timeout report a diagnosable failure.
      return;
    }
    if (!isReplyEnvelope(parsed)) return;
    this.#correlation.settle(parsed);
  }

  /** Delivers one publish to every selected subscriber. */
  async #dispatchPublish(
    queue: string,
    message: IQueueMessage,
    envelope: PublishEnvelope,
  ): Promise<void> {
    const selected = this.#subscribers.select(envelope.topic);
    if (selected.length === 0) {
      this.#logger?.()?.debug('cloudflare-messaging: no subscriber for topic, acked', {
        queue,
        topic: envelope.topic,
        subscribed: this.#subscribers.topics(),
      });
      message.ack();
      return;
    }

    const metadata = this.#metadataFor(envelope);
    try {
      for (const subscription of selected) {
        await subscription.handler(envelope.payload, metadata);
      }
    } catch (error: unknown) {
      this.#logger?.()?.error('cloudflare-messaging: subscriber failed, message retried', {
        queue,
        topic: envelope.topic,
        messageId: envelope.id,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
      return;
    }

    // Outside the try, deliberately — the `WorkersQueue.dispatch` reasoning: a
    // throwing `ack()` caught above would report a subscriber failure that did
    // not happen and then also `retry()`, giving one message two dispositions.
    message.ack();
  }

  /** Runs one request through its responder and delivers the reply. */
  async #dispatchRequest(
    queue: string,
    message: IQueueMessage,
    envelope: RequestEnvelope,
  ): Promise<void> {
    const selected = this.#responders.select(envelope.topic);
    const responder = selected[0];

    if (responder === undefined) {
      // Answered rather than retried: the caller is blocked on this, so an
      // immediate, named failure beats making it wait out its whole budget for
      // a responder that is not registered here.
      this.#logger?.()?.error('cloudflare-messaging: no responder for request topic', {
        queue,
        topic: envelope.topic,
        responding: this.#responders.topics(),
      });
      await this.#sendReply(envelope, {
        ok: false,
        error: `No responder is registered for '${envelope.topic}' on the consuming Worker.`,
      });
      message.ack();
      return;
    }

    const metadata = this.#metadataFor(envelope);
    try {
      const result = await responder.handler(envelope.payload, metadata);
      await this.#sendReply(envelope, { ok: true, payload: result });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#logger?.()?.error('cloudflare-messaging: responder failed, caller informed', {
        queue,
        topic: envelope.topic,
        messageId: envelope.id,
        error: reason,
      });
      await this.#sendReply(envelope, { ok: false, error: reason });
    }

    // Acked on both paths, and outside the try for the reason above. A request
    // is not retried: the caller has already been told what happened, and a
    // redelivery would re-run a responder whose side effects already landed.
    message.ack();
  }

  /** Posts one reply to the inbox object the request named. */
  async #sendReply(
    envelope: RequestEnvelope,
    outcome: { readonly ok: true; readonly payload: unknown } | {
      readonly ok: false;
      readonly error: string;
    },
  ): Promise<void> {
    const inbox = this.#replyInbox;
    if (inbox === undefined) {
      // Unreachable through `respond`, which refuses without the arm — but a
      // request can arrive at a consumer configured without RPC, and silently
      // dropping it would leave the caller to time out with nothing logged.
      this.#logger?.()?.error('cloudflare-messaging: reply undeliverable, no rpc arm configured', {
        topic: envelope.topic,
        replyTo: envelope.replyTo,
      });
      return;
    }
    await deliverReply(
      inbox.namespace,
      envelope.replyTo,
      encodeReplyEnvelope(envelope.correlationId, outcome),
      this.#logger,
    );
  }

  /** Builds the transport metadata a handler receives. */
  #metadataFor(envelope: QueueEnvelope): MessageMetadata {
    return {
      topic: envelope.topic,
      messageId: envelope.id,
      timestamp: new Date(this.#runtime.now()),
    };
  }

  /** Adds one entry to a table and returns the subscription that removes it. */
  #register<THandler>(
    table: SubscriptionTable<THandler>,
    topic: string,
    handler: THandler,
    options: SubscribeOptions | undefined,
  ): ISubscription {
    const id = this.#runtime.uuid();
    table.add({
      id,
      topic,
      handler,
      ...(options?.queue === undefined ? {} : { queue: options.queue }),
    });
    return {
      unsubscribe: (): Promise<void> => {
        table.remove(topic, id);
        return Promise.resolve();
      },
    };
  }

  /** Reads the reply-inbox arm, refusing by name when it is absent. */
  #requireReplyInbox(method: 'request' | 'respond'): ReplyInboxBinding {
    if (this.#replyInbox !== undefined) return this.#replyInbox;
    throw new CloudflareUnsupportedError(
      `${method}() needs a reply inbox, which a Cloudflare queue cannot provide: a queue ` +
        'reaches its one consumer Worker and never the caller waiting for a reply. Add the ' +
        "`rpc` arm — CloudflarePlugin({ messaging: { binding: '…', rpc: { binding: 'REPLY_INBOX' } } }) " +
        '— bind a Durable Object namespace to a class delegating to ReplyInboxObjectCore, and ' +
        'set `max_batch_timeout = 0` on the queue consumer.',
    );
  }

  /**
   * Lazily opens the per-instance reply inbox exactly once.
   *
   * The binding is passed in rather than read off the field: `request` has
   * already narrowed it through `#requireReplyInbox`, so re-checking here would
   * be a branch no input can reach.
   *
   * @param binding - The reply-inbox namespace, already narrowed
   */
  #openInbox(binding: ReplyInboxBinding): Promise<ReplyInbox> {
    // A FAILED open must not be cached: memoizing it unconditionally meant a
    // first request against an unreachable object left every later request
    // failing with that same stale error forever.
    this.#inboxInit ??= openReplyInbox({
      namespace: binding.namespace,
      binding: binding.binding,
      uuid: () => this.#runtime.uuid(),
      onReply: (raw) => {
        this.#onReply(raw);
      },
      onClosed: () => {
        // The socket is the only path a reply can take, so a drop dooms every
        // in-flight request. Failing them now beats each waiting out its full
        // budget for a reply that can no longer be routed.
        this.#inboxInit = null;
        this.#correlation.rejectAll(
          new Error('The Cloudflare reply inbox closed before a reply was received.'),
        );
      },
    }).catch((error: unknown) => {
      this.#inboxInit = null;
      throw error;
    });

    return this.#inboxInit;
  }
}
