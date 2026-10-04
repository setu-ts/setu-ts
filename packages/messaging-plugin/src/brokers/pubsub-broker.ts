/**
 * GCP Pub/Sub broker implementation over {@linkcode IPubSubTransport}.
 *
 * Publishes to topics, subscribes through consumer-group subscriptions, and
 * supports request-reply via a shared reply topic with per-instance
 * subscriptions. Topics must pre-exist; the consumer-group subscription
 * ({@linkcode SubscribeOptions.queue}, default `<defaultQueue>.<topic>`) is
 * created when absent, and an existing one bound to another topic is refused
 * with {@linkcode PubSubSubscriptionBoundElsewhereError}.
 *
 * The SDK is lazy-loaded through {@linkcode loadPubSubModule} and adapted to
 * the domain port via {@linkcode adaptPubSubModule}, or injected directly as
 * {@linkcode IPubSubTransport}.
 *
 * @module
 */

import type {
  ISubscription,
  MessageHandler,
  MessageMetadata,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { describeError } from './describe-error.ts';
import type { ReplyInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { assertNotCloudflareWorkers } from './cloud-gate.ts';
import { PubSubSubscriptionBoundElsewhereError, ReplyInboxUnavailableError } from '../errors.ts';

/** Default reply topic for request-reply. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/** Default consumer-group subscription-name PREFIX (M101b: `<prefix>.<topic>`). */
const DEFAULT_QUEUE = 'messaging-consumers';

/** The service's subscription-ID length cap (Pub/Sub resource-naming rules). */
const MAX_SUBSCRIPTION_NAME_LENGTH = 255;

/** gRPC `ALREADY_EXISTS`. */
const GRPC_ALREADY_EXISTS = 6;

/**
 * Derives the default subscription for a topic: `<defaultQueue>.<topic>`
 * (M101b, V8-2).
 *
 * Pub/Sub subscription names are project-global, so one shared default meant
 * a second topic attached to the first topic's subscription. `.` joins (the
 * package's own `rr.req.` convention; Kafka's `:` is illegal in a Pub/Sub ID).
 * Pub/Sub reserves no character, so the parts are NOT recoverable by splitting.
 *
 * @param defaultQueue - The configured prefix
 * @param topic - The subscribed topic
 * @returns The per-topic subscription name
 * @internal
 */
export function deriveDefaultSubscription(defaultQueue: string, topic: string): string {
  return `${defaultQueue}.${topic}`;
}

/**
 * Reports whether the fully-qualified topic the service says a subscription is
 * bound to is the topic the caller asked for. The caller may name a topic
 * either short (`orders`) or fully qualified (`projects/p/topics/orders`).
 */
function isSameTopic(boundTopic: string, requestedTopic: string): boolean {
  return requestedTopic.startsWith('projects/')
    ? boundTopic === requestedTopic
    : boundTopic.endsWith(`/topics/${requestedTopic}`);
}

/**
 * Declares the constructors used from the real GCP Pub/Sub SDK so the adapter
 * can build a domain port. This is NOT an SDK-shaped structural facade — it
 * names only what the adapter actually uses.
 */
export interface PubSubSdkModule {
  PubSub: new (options: { projectId: string; credentials?: unknown }) => {
    topic(topicName: string): {
      publishMessage(
        message: { data: Uint8Array; attributes?: Record<string, string> },
      ): Promise<string>;
      createSubscription(subscriptionName: string): Promise<unknown[]>;
    };
    subscription(subscriptionName: string): {
      on(
        event: 'message',
        handler: (
          msg: {
            ack: () => void;
            nack: () => void;
            data: Uint8Array;
            id: string;
            /**
             * The server-assigned publish time, as the SDK delivers it.
             *
             * Typed `Date` rather than `string` (M90d review, read off the
             * locked `@google-cloud/pubsub@6.0.0` `subscriber.d.ts`): the real
             * `Message.publishTime` is a `PreciseDate`, a `Date` subclass, so
             * `Date` is the correct structural supertype and the full SDK
             * `Message` type stays unimported. The previous `string` made the
             * fixture model a value production never sends.
             */
            publishTime?: Date;
            attributes?: Record<string, string>;
          },
        ) => void,
      ): void;
      on(event: 'error', handler: (err: unknown) => void): void;
      close(): Promise<void>;
      delete(): Promise<void>;
      /**
       * Reads the subscription's metadata (M101b). The SDK resolves a tuple
       * whose first element is the `google.pubsub.v1.ISubscription`; only its
       * fully-qualified `topic` is read, to refuse attaching to a subscription
       * that is bound to another topic.
       */
      getMetadata(): Promise<[{ topic?: string | null }, ...unknown[]]>;
    };
    close(): Promise<void>;
  };
}

/**
 * Domain port for GCP Pub/Sub operations. The broker depends on this, not the
 * SDK directly.
 */
export interface IPubSubTransport {
  /** Publish bytes to a topic. */
  publish(
    topic: string,
    bytes: Uint8Array,
    attributes?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /**
   * Open a subscription on a topic. Creates the subscription when absent.
   * @param onMessage - Called per delivered message
   */
  open(
    topic: string,
    subscription: string,
    onMessage: (
      msg: {
        payload: string;
        ack: () => void;
        nack: () => void;
        attributes?: Readonly<Record<string, string>>;
        /** The platform-assigned message id, when the transport carried one (X28-4). */
        messageId?: string;
        /** The platform-assigned publish time, when the transport carried one (X28-4). */
        timestamp?: Date;
      },
    ) => void,
  ): Promise<IPubSubSubscription>;
  /** Explicitly create a subscription (for RPC inbox). */
  createSubscription(topic: string, subscription: string): Promise<void>;
  /** Delete a subscription (for RPC inbox teardown). */
  deleteSubscription(subscription: string): Promise<void>;
  /** Close the client and all subscriptions. */
  close(): Promise<void>;
  /**
   * Reports whether the Pub/Sub backend is reachable (optional, M70c).
   *
   * The real adapter calls the SDK's `topic.exists()`; a transport without a
   * liveness check omits it and the broker reports `unknown` reachability.
   * The SDK owns streaming-pull reconnection, so the broker issues no
   * reconnect loop of its own.
   */
  isHealthy?(): Promise<boolean>;
}

/** Handle for an open Pub/Sub subscription. */
export interface IPubSubSubscription {
  /** Close the subscription. */
  close(): Promise<void>;
}

/**
 * Options for GCP Pub/Sub broker.
 */
export interface PubSubOptions {
  /** GCP project ID. Required unless {@link client} is injected. */
  projectId?: string;
  /** Service-account credentials (object or key path). SDK ADC is used when omitted. */
  credentials?: unknown;
  /** Injected transport (bypasses lazy SDK load). */
  client?: IPubSubTransport;
  /**
   * Default consumer-group subscription-name PREFIX (default
   * `'messaging-consumers'`). A subscription with no
   * {@linkcode SubscribeOptions.queue} uses `<defaultQueue>.<topic>`, one
   * subscription per topic, because Pub/Sub subscription names are
   * project-global (M101b).
   */
  defaultQueue?: string;
  /** Shared reply topic for request-reply (must pre-exist). */
  replyTopic?: string;
  /** Optional logger. */
  logger?: { error: (msg: string) => void };
}

/**
 * Lazily load the GCP Pub/Sub SDK.
 *
 * @returns The SDK module
 * @throws {Error} If the package cannot be resolved
 */
export async function loadPubSubModule(): Promise<PubSubSdkModule> {
  const mod = await import('npm:@google-cloud/pubsub@^6');
  return mod as unknown as PubSubSdkModule;
}

/**
 * Adapts the real GCP Pub/Sub SDK module to the domain port.
 *
 * @param mod - The loaded SDK module
 * @param options - SDK constructor options
 * @returns A domain-shaped transport
 */
export function adaptPubSubModule(
  mod: PubSubSdkModule,
  options: {
    projectId: string;
    credentials?: unknown;
    logger?: { error: (msg: string) => void } | undefined;
  },
): IPubSubTransport {
  const pubsub = new mod.PubSub({ projectId: options.projectId, credentials: options.credentials });

  return {
    publish: async (
      topic: string,
      bytes: Uint8Array,
      attributes?: Readonly<Record<string, string>>,
    ): Promise<void> => {
      const message = attributes ? { data: bytes, attributes: { ...attributes } } : { data: bytes };
      await pubsub.topic(topic).publishMessage(message);
    },
    open: async (
      topic: string,
      subscription: string,
      onMessage: (
        msg: {
          payload: string;
          ack: () => void;
          nack: () => void;
          attributes?: Readonly<Record<string, string>>;
          messageId?: string;
          timestamp?: Date;
        },
      ) => void,
    ): Promise<IPubSubSubscription> => {
      const sub = pubsub.subscription(subscription);

      // Create subscription on the topic if absent.
      try {
        await pubsub.topic(topic).createSubscription(subscription);
      } catch (err) {
        // Narrow catch to ALREADY_EXISTS (gRPC code 6) only; rethrow everything else
        // including NOT_FOUND (gRPC code 5). Match on the documented error-code
        // discriminator rather than String(err) which is representation-dependent.
        const grpcCode = (err as { code?: number }).code;
        if (grpcCode !== GRPC_ALREADY_EXISTS) {
          throw err;
        }
        // M101b (V8-2): subscription names are project-global, so an existing
        // one may be bound to ANOTHER topic. Attaching to it would hand this
        // topic's handler the other topic's messages with no log. A missing
        // `topic` cannot prove the binding either, so it is refused too.
        const [metadata] = await sub.getMetadata();
        const boundTopic = metadata.topic ?? '';
        if (!isSameTopic(boundTopic, topic)) {
          throw new PubSubSubscriptionBoundElsewhereError(
            subscription,
            boundTopic === '' ? '(unknown)' : boundTopic,
            topic,
          );
        }
      }

      sub.on('error', (err) => {
        if (options.logger) {
          options.logger.error(`Pub/Sub subscription error: ${describeError(err)}`);
        }
      });

      sub.on('message', (raw) => {
        const text = new TextDecoder().decode(raw.data);
        // X28-4: the platform assigns both fields, so the adapter reads them
        // rather than dropping them. Omitted — never assigned `undefined` —
        // when the transport carries none, so `'messageId' in metadata`
        // separates "no id" from "did not look".
        onMessage({
          payload: text,
          ack: () => raw.ack(),
          nack: () => raw.nack(),
          attributes: raw.attributes ?? {},
          ...(raw.id !== undefined && raw.id !== '' ? { messageId: raw.id } : {}),
          ...(raw.publishTime !== undefined ? { timestamp: new Date(raw.publishTime) } : {}),
        });
      });

      return {
        close: async () => {
          await sub.close();
        },
      };
    },
    createSubscription: async (topic: string, subscription: string): Promise<void> => {
      await pubsub.topic(topic).createSubscription(subscription);
    },
    deleteSubscription: async (subscription: string): Promise<void> => {
      const sub = pubsub.subscription(subscription);
      await sub.delete();
    },
    close: async () => {
      await pubsub.close();
    },
  };
}

/**
 * GCP Pub/Sub message broker.
 *
 * @since 0.1.0
 */
export class GcpPubSubBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #projectId: string;
  #credentials: unknown;
  #injectedClient: IPubSubTransport | undefined;
  #defaultQueue: string;
  #replyTopic: string;
  #logger: { error: (msg: string) => void } | undefined;
  #transport: IPubSubTransport | null = null;
  #ready = false;
  #subscriptions: Map<string, IPubSubSubscription>;
  #rr: RequestReplyCore;

  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: PubSubOptions,
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    // Empty is a sentinel for "not supplied", checked in connect(). The plugin's
    // option union already makes a credential-less `'pubsub'` arm a compile
    // error, but this class is exported for standalone construction, where the
    // type system is not in the way — and `new PubSub({ projectId: '' })` fails
    // later with an SDK message that names neither the option nor this broker.
    this.#projectId = options?.projectId ?? '';
    this.#credentials = options?.credentials;
    this.#injectedClient = options?.client;
    this.#defaultQueue = options?.defaultQueue ?? DEFAULT_QUEUE;
    this.#replyTopic = options?.replyTopic ?? DEFAULT_REPLY_TOPIC;
    this.#logger = options?.logger;
    this.#subscriptions = new Map();
    this.#rr = new RequestReplyCore({
      publish: (topic, message, headers) => this.publishWithHeaders(topic, message, headers ?? {}),
      subscribe: (topic, handler, opts) => this.subscribe(topic, handler, opts),
      uuid: () => this.#runtime.uuid(),
      setTimeout: (fn, ms) => this.#runtime.setTimeout(fn, ms),
      clearTimeout: (handle) => this.#runtime.clearTimeout(handle),
      openInbox: (onReply) => this.#openReplyInbox(onReply),
    });
  }

  /**
   * Opens the reply inbox on the shared reply topic with a per-instance
   * subscription.
   *
   * On failure after admin creation, compensates by deleting the subscription
   * so a later retry can succeed (B6).
   */
  async #openReplyInbox(onReply: (message: unknown) => void): Promise<ReplyInbox> {
    if (!this.#transport) {
      throw new Error('GcpPubSubBroker is not connected');
    }

    const inboxSub = `rr-inbox-${this.#runtime.uuid()}`;

    try {
      await this.#transport.createSubscription(this.#replyTopic, inboxSub);
    } catch {
      throw new ReplyInboxUnavailableError(this.#replyTopic);
    }

    let closed = false;
    try {
      const sub = await this.#transport.open(this.#replyTopic, inboxSub, async (msg) => {
        if (closed) return;
        try {
          const deserialized = this.#serializer.deserialize(msg.payload);
          onReply(deserialized);
          await Promise.resolve();
          msg.ack();
        } catch (err) {
          // Deserialization failure — nack so transport retries.
          if (this.#logger) {
            this.#logger.error(`Pub/Sub reply deserialization error: ${describeError(err)}`);
          }
          msg.nack();
        }
      });

      return {
        address: this.#replyTopic,
        close: async () => {
          if (closed) return;
          closed = true;
          await sub.close();
          await this.#transport!.deleteSubscription(inboxSub);
        },
      };
    } catch (err) {
      // Compensate: open failed after admin create, delete the subscription
      try {
        await this.#transport.deleteSubscription(inboxSub);
      } catch {
        // Best-effort cleanup; original error is more important.
      }
      throw err;
    }
  }

  async connect(): Promise<void> {
    if (this.#ready) return;

    assertNotCloudflareWorkers(
      this.#runtime,
      'GCP Pub/Sub',
      'npm:@google-cloud/pubsub@^6',
    );

    if (this.#injectedClient !== undefined) {
      this.#transport = this.#injectedClient;
    } else {
      if (this.#projectId === '') {
        throw new Error(
          'GcpPubSubBroker requires a projectId when no client is injected. ' +
            'Pass `projectId` (or an `IPubSubTransport` as `client`).',
        );
      }
      const mod = await loadPubSubModule();
      this.#transport = adaptPubSubModule(mod, {
        projectId: this.#projectId,
        credentials: this.#credentials,
        logger: this.#logger,
      });
    }

    this.#ready = true;
  }

  async disconnect(): Promise<void> {
    await this.#rr.close();

    for (const sub of this.#subscriptions.values()) {
      await sub.close();
    }
    this.#subscriptions.clear();

    if (this.#transport) {
      await this.#transport.close();
      this.#transport = null;
    }
    this.#ready = false;
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Tri-state backend reachability (M70c).
   *
   * The GCP SDK owns streaming-pull reconnection, so the broker issues no
   * reconnect loop of its own; the probe delegates to the transport's
   * `isHealthy?()` (the real adapter calls the SDK's `topic.exists()`).
   * `true`/`false` from the transport, `undefined` when the transport omits
   * the member (a minimal fake) — the indicator then reports
   * `reachable: 'unknown'`.
   *
   * @returns `true`/`false`/`undefined` as described
   * @since 0.1.0
   */
  async reachability(): Promise<boolean | undefined> {
    const transport = this.#transport;
    if (transport === null || typeof transport.isHealthy !== 'function') {
      return undefined;
    }
    return await transport.isHealthy();
  }

  /**
   * Boolean port member (M70c): `false` only when positively unreachable.
   *
   * @returns `true` when reachable or unprobeable, `false` when the
   *   transport reports unreachable
   * @since 0.1.0
   */
  async isHealthy(): Promise<boolean> {
    const reachable = await this.reachability();
    return reachable !== false;
  }

  publish<T>(topic: string, message: T): Promise<void> {
    return this.publishWithHeaders(topic, message, {});
  }

  /** Publishes a message with framework-owned transport headers. @internal */
  async publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (!this.#transport) {
      throw new Error('GcpPubSubBroker is not connected');
    }
    const serialized = this.#serializer.serialize(message);
    const bytes = new TextEncoder().encode(serialized);
    await this.#transport.publish(topic, bytes, headers);
  }

  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#transport) {
      throw new Error('GcpPubSubBroker is not connected');
    }

    const queue = options?.queue ?? deriveDefaultSubscription(this.#defaultQueue, topic);
    if (queue.length > MAX_SUBSCRIPTION_NAME_LENGTH) {
      throw new Error(
        `Pub/Sub subscription name for topic ${JSON.stringify(topic)} is ${queue.length} ` +
          `characters; the service allows at most ${MAX_SUBSCRIPTION_NAME_LENGTH}. Pass a ` +
          'shorter SubscribeOptions.queue.',
      );
    }
    const subscriptionId = this.#runtime.uuid();

    const sub = await this.#transport.open(topic, queue, (msg) => {
      (async () => {
        // B2: Separate handler invocation from settlement so a settlement rejection
        // is not confused with a handler failure and does not trigger double-settle.
        let handlerError: Error | null = null;
        try {
          const deserialized = this.#serializer.deserialize<T>(msg.payload);
          // X28-4: copy the platform identity onto the metadata ONLY when the
          // transport carried it, so an absent member means "none delivered"
          // (exactOptionalPropertyTypes also forbids assigning undefined).
          const metadata: MessageMetadata = {
            topic,
            headers: msg.attributes ?? {},
            ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
            ...(msg.timestamp !== undefined ? { timestamp: msg.timestamp } : {}),
          };
          await handler(deserialized, metadata);
        } catch (err) {
          handlerError = err as Error;
        }

        if (handlerError !== null) {
          if (this.#logger) {
            this.#logger.error(`Pub/Sub handler error: ${describeError(handlerError)}`);
          }
          msg.nack();
        } else {
          msg.ack();
        }
      })();
    });

    this.#subscriptions.set(subscriptionId, sub);

    return {
      unsubscribe: async () => {
        const existing = this.#subscriptions.get(subscriptionId);
        if (existing) {
          await existing.close();
          this.#subscriptions.delete(subscriptionId);
        }
      },
    };
  }

  /** Subscribes through the header-aware internal path. @internal */
  subscribeWithHeaders<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.subscribe(topic, handler, options);
  }

  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.requestWithHeaders(topic, message, {}, options);
  }

  /** Sends request-reply traffic with framework-owned headers. @internal */
  requestWithHeaders<TReq, TRes>(
    topic: string,
    message: TReq,
    headers: Readonly<Record<string, string>>,
    options?: RequestOptions,
  ): Promise<TRes> {
    return this.#rr.request<TRes>(topic, message, options, headers);
  }

  respond<TReq, TRes>(
    topic: string,
    handler: RequestHandler<TReq, TRes>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    return this.#rr.respond(
      topic,
      handler as (message: unknown, metadata: MessageMetadata) => unknown | Promise<unknown>,
      options,
    );
  }
}
