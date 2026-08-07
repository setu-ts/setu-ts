/**
 * GCP Pub/Sub broker implementation over {@linkcode IPubSubTransport}.
 *
 * Publishes to topics, subscribes through consumer-group subscriptions, and
 * supports request-reply via a shared reply topic with per-instance
 * subscriptions. Topics must pre-exist; the consumer-group subscription
 * ({@linkcode SubscribeOptions.queue}) is created when absent.
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
import type { ReplyInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { assertNotCloudflareWorkers } from './cloud-gate.ts';
import { ReplyInboxUnavailableError } from '../errors.ts';

/** Default reply topic for request-reply. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/** Default consumer-group subscription name. */
const DEFAULT_QUEUE = 'messaging-consumers';

/**
 * Declares the constructors used from the real GCP Pub/Sub SDK so the adapter
 * can build a domain port. This is NOT an SDK-shaped structural facade — it
 * names only what the adapter actually uses.
 */
export interface PubSubSdkModule {
  PubSub: new (options: { projectId: string; credentials?: unknown }) => {
    topic(topicName: string): {
      publishMessage(message: { data: Uint8Array }): Promise<string>;
      createSubscription(subscriptionName: string): Promise<unknown[]>;
    };
    subscription(subscriptionName: string): {
      on(
        event: 'message',
        handler: (msg: { ack: () => void; nack: () => void; data: Uint8Array; id: string }) => void,
      ): void;
      on(event: 'error', handler: (err: unknown) => void): void;
      close(): Promise<void>;
      delete(): Promise<void>;
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
  publish(topic: string, bytes: Uint8Array): Promise<void>;
  /**
   * Open a subscription on a topic. Creates the subscription when absent.
   * @param onMessage - Called per delivered message
   */
  open(
    topic: string,
    subscription: string,
    onMessage: (msg: { payload: string; ack: () => void; nack: () => void }) => void,
  ): Promise<IPubSubSubscription>;
  /** Explicitly create a subscription (for RPC inbox). */
  createSubscription(topic: string, subscription: string): Promise<void>;
  /** Delete a subscription (for RPC inbox teardown). */
  deleteSubscription(subscription: string): Promise<void>;
  /** Close the client and all subscriptions. */
  close(): Promise<void>;
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
  /** Default consumer-group subscription name. */
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
    publish: async (topic: string, bytes: Uint8Array): Promise<void> => {
      await pubsub.topic(topic).publishMessage({ data: bytes });
    },
    open: async (
      topic: string,
      subscription: string,
      onMessage: (msg: { payload: string; ack: () => void; nack: () => void }) => void,
    ): Promise<IPubSubSubscription> => {
      // Create subscription on the topic if absent.
      try {
        await pubsub.topic(topic).createSubscription(subscription);
      } catch (err) {
        // Narrow catch to ALREADY_EXISTS (gRPC code 6) only; rethrow everything else
        // including NOT_FOUND (gRPC code 5). Match on the documented error-code
        // discriminator rather than String(err) which is representation-dependent.
        const grpcCode = (err as { code?: number }).code;
        if (grpcCode !== 6) {
          throw err;
        }
      }

      const sub = pubsub.subscription(subscription);

      sub.on('error', (err) => {
        if (options.logger) {
          options.logger.error(`Pub/Sub subscription error: ${err}`);
        }
      });

      sub.on('message', (raw) => {
        const text = new TextDecoder().decode(raw.data);
        onMessage({
          payload: text,
          ack: () => raw.ack(),
          nack: () => raw.nack(),
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
      publish: (topic, message) => this.publish(topic, message),
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
            this.#logger.error(`Pub/Sub reply deserialization error: ${err}`);
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

  async publish<T>(topic: string, message: T): Promise<void> {
    if (!this.#transport) {
      throw new Error('GcpPubSubBroker is not connected');
    }
    const serialized = this.#serializer.serialize(message);
    const bytes = new TextEncoder().encode(serialized);
    await this.#transport.publish(topic, bytes);
  }

  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#transport) {
      throw new Error('GcpPubSubBroker is not connected');
    }

    const subscriptionId = this.#runtime.uuid();
    const queue = options?.queue ?? this.#defaultQueue;

    const sub = await this.#transport.open(topic, queue, (msg) => {
      (async () => {
        // B2: Separate handler invocation from settlement so a settlement rejection
        // is not confused with a handler failure and does not trigger double-settle.
        let handlerError: Error | null = null;
        try {
          const deserialized = this.#serializer.deserialize<T>(msg.payload);
          const metadata: MessageMetadata = {
            topic,
          };
          await handler(deserialized, metadata);
        } catch (err) {
          handlerError = err as Error;
        }

        if (handlerError !== null) {
          if (this.#logger) {
            this.#logger.error(`Pub/Sub handler error: ${handlerError}`);
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

  request<TReq, TRes>(topic: string, message: TReq, options?: RequestOptions): Promise<TRes> {
    return this.#rr.request<TRes>(topic, message, options);
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
