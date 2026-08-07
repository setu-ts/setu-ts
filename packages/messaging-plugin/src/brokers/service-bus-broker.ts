/**
 * Azure Service Bus broker implementation over {@linkcode IServiceBusTransport}.
 *
 * Publishes to topics, subscribes through named subscriptions, and supports
 * request-reply via a shared reply topic with per-instance subscriptions.
 * Both topics and ordinary subscriptions must pre-exist — the Service Bus SDK
 * cannot create them. The per-instance RPC reply subscription is created
 * through the administration client, which requires the `Manage` right.
 *
 * The SDK is lazy-loaded through {@linkcode loadServiceBusModule} and adapted
 * to the domain port via {@linkcode adaptServiceBusModule}, or injected
 * directly as {@linkcode IServiceBusTransport}.
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
} from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import type { ReplyInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { assertNotCloudflareWorkers } from './cloud-gate.ts';
import { ReplyInboxUnavailableError } from '../errors.ts';

/** Default reply topic for request-reply. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/** Default subscription name. */
const DEFAULT_QUEUE = 'messaging-consumers';

/**
 * Structural type matching the real SDK's ProcessErrorArgs callback argument
 * (npm:@azure/service-bus@^7).
 */
export interface IServiceBusProcessErrorArgs {
  /** The underlying error. */
  error: Error;
  /** The operation where the error originated. */
  errorSource: 'abandon' | 'complete' | 'processMessageCallback' | 'receive' | 'renewLock';
  /** The entity path for the current receiver. */
  entityPath: string;
  /** The fully qualified namespace for the Service Bus. */
  fullyQualifiedNamespace: string;
  /** The identifier of the client that raised this event. */
  identifier: string;
}

/**
 * Structural receive-options matching the real SDK's SubscribeOptions
 * (npm:@azure/service-bus@^7). The property is autoCompleteMessages, not autoComplete.
 */
export interface IServiceBusSubscribeOptions {
  autoCompleteMessages?: boolean;
  maxConcurrentCalls?: number;
}

/**
 * Structural receiver type carrying the real SDK settlement methods.
 * Settlement belongs to the receiver — NOT the received message.
 */
export interface IServiceBusReceiver {
  subscribe(
    handlers: {
      processMessage: (message: unknown) => Promise<void>;
      processError: (args: IServiceBusProcessErrorArgs) => Promise<void>;
    },
    options?: IServiceBusSubscribeOptions,
  ): { close(): Promise<void> };
  completeMessage(message: unknown): Promise<void>;
  abandonMessage(message: unknown, propertiesToModify?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/**
 * Declares the constructors used from the real Azure Service Bus SDK.
 */
export interface ServiceBusSdkModule {
  ServiceBusClient: new (connectionString: string) => {
    createSender(queueOrTopicName: string): {
      sendMessages(messages: { body: unknown }): Promise<void>;
      close(): Promise<void>;
    };
    createReceiver(queueName: string, options?: unknown): IServiceBusReceiver;
    createReceiver(
      topicName: string,
      subscriptionName: string,
      options?: unknown,
    ): IServiceBusReceiver;
    close(): Promise<void>;
  };
  ServiceBusAdministrationClient: new (connectionString: string) => {
    createSubscription(topicName: string, subscriptionName: string): Promise<unknown>;
    deleteSubscription(topicName: string, subscriptionName: string): Promise<unknown>;
  };
}

/**
 * Domain port for Azure Service Bus operations.
 */
export interface IServiceBusTransport {
  /** Send a body to a topic. */
  send(topic: string, body: string): Promise<void>;
  /**
   * Open a receiver on a topic subscription.
   * @param onMessage - Called per delivered message
   */
  open(
    topic: string,
    subscription: string,
    onMessage: (
      msg: { payload: string; ack: () => void; nack: () => void },
    ) => void | Promise<void>,
  ): Promise<IServiceBusSubscription>;
  /** Create a subscription (for RPC inbox). */
  createSubscription(topic: string, subscription: string): Promise<void>;
  /** Delete a subscription (for RPC inbox teardown). */
  deleteSubscription(topic: string, subscription: string): Promise<void>;
  /** Close the client and all senders/receivers. */
  close(): Promise<void>;
}

/** Handle for an open Service Bus subscription receiver. */
export interface IServiceBusSubscription {
  /** Close the receiver. */
  close(): Promise<void>;
}

/**
 * Options for Azure Service Bus broker.
 */
export interface ServiceBusOptions {
  /** Connection string for the Service Bus namespace. Required unless {@link client} is injected. */
  connectionString?: string;
  /** Connection string for the administration client (reply-subscription creation). Defaults to {@link connectionString}. */
  adminConnectionString?: string;
  /** Injected transport (bypasses lazy SDK load). */
  client?: IServiceBusTransport;
  /** Default subscription name. */
  defaultQueue?: string;
  /** Shared reply topic for request-reply (must pre-exist). */
  replyTopic?: string;
  /** Optional logger. */
  logger?: { error: (msg: string) => void };
}

/**
 * One open receiver: the subscriber handle that stops delivery, plus the
 * receiver whose AMQP link has to be released. Both need closing — closing only
 * the subscriber leaves the link open until the whole client shuts down.
 */
interface OpenReceiver {
  subHandle: { close(): Promise<void> };
  receiver: IServiceBusReceiver;
}

/**
 * Stops delivery, then releases the receiver's link.
 *
 * The link is released even when stopping delivery rejects: skipping it there
 * would leak exactly the resource this function exists to reclaim.
 *
 * @param entry - The open receiver to close
 */
async function closeReceiver(entry: OpenReceiver): Promise<void> {
  try {
    await entry.subHandle.close();
  } finally {
    await entry.receiver.close();
  }
}

/**
 * Lazily load the Azure Service Bus SDK.
 *
 * @returns The SDK module
 * @throws {Error} If the package cannot be resolved
 */
export async function loadServiceBusModule(): Promise<ServiceBusSdkModule> {
  const mod = await import('npm:@azure/service-bus@^7');
  return mod as unknown as ServiceBusSdkModule;
}

/**
 * Adapts the real Azure Service Bus SDK module to the domain port.
 *
 * @param mod - The loaded SDK module
 * @param options - SDK constructor options
 * @returns A domain-shaped transport
 */
export function adaptServiceBusModule(
  mod: ServiceBusSdkModule,
  options: {
    connectionString: string;
    adminConnectionString: string;
    logger?: { error: (msg: string) => void } | undefined;
  },
): IServiceBusTransport {
  const client = new mod.ServiceBusClient(options.connectionString);
  const admin = new mod.ServiceBusAdministrationClient(options.adminConnectionString);

  const senders = new Map<string, ReturnType<typeof client['createSender']>>();
  // Track multiple receiver handles per key to support duplicate opens
  const receivers = new Map<string, OpenReceiver[]>();

  return {
    send: async (topic: string, body: string): Promise<void> => {
      let sender = senders.get(topic);
      if (!sender) {
        sender = client.createSender(topic);
        senders.set(topic, sender);
      }
      await sender.sendMessages({ body });
    },
    open: async (
      topic: string,
      subscription: string,
      onMessage: (
        msg: { payload: string; ack: () => void; nack: () => void },
      ) => void | Promise<void>,
    ): Promise<IServiceBusSubscription> => {
      // createReceiver(topicName, subscriptionName) — two positional strings.
      const receiver = client.createReceiver(topic, subscription) as IServiceBusReceiver;

      const subHandle = receiver.subscribe(
        {
          processMessage: async (rawMessage) => {
            const msg = rawMessage as { body?: unknown };
            const body = typeof msg.body === 'string' ? msg.body : String(msg.body ?? '');

            // Create settlement functions that return promises
            // Settlement must await the handler to ensure the callback doesn't resolve before settlement
            const ack = async (): Promise<void> => {
              await receiver.completeMessage(rawMessage);
            };
            const nack = async (): Promise<void> => {
              await receiver.abandonMessage(rawMessage);
            };

            // Await onMessage to ensure handler completes before settlement
            await onMessage({
              payload: body,
              ack,
              nack,
            });
          },
          processError: (args: IServiceBusProcessErrorArgs) =>
            Promise.resolve(options.logger?.error(`Service Bus receiver error: ${args.error}`)),
        },
        { autoCompleteMessages: false },
      );

      const key = `${topic}/${subscription}`;
      // Track this call's OWN pair. Both halves matter: `subHandle.close()`
      // stops delivery, while `receiver.close()` releases the AMQP link — the
      // receiver used to be dropped on the floor, so every unsubscribe leaked a
      // link until the whole client closed. Identity matters too: popping the
      // last handle closed a SIBLING open's receiver rather than this one's.
      const entry: OpenReceiver = { subHandle, receiver };
      const existing = receivers.get(key) ?? [];
      existing.push(entry);
      receivers.set(key, existing);

      // Await required — the SDK requires async `open` for its type contract.
      await Promise.resolve();

      let closed = false;
      return {
        close: async () => {
          if (closed) return;
          closed = true;
          const handles = receivers.get(key);
          if (handles) {
            const index = handles.indexOf(entry);
            if (index >= 0) handles.splice(index, 1);
            if (handles.length === 0) receivers.delete(key);
          }
          await closeReceiver(entry);
        },
      };
    },
    createSubscription: async (topic: string, subscription: string): Promise<void> => {
      await admin.createSubscription(topic, subscription);
    },
    deleteSubscription: async (topic: string, subscription: string): Promise<void> => {
      await admin.deleteSubscription(topic, subscription);
    },
    close: async () => {
      for (const sender of senders.values()) {
        await sender.close();
      }
      senders.clear();
      // Close every open receiver — subscriber handle AND the AMQP link.
      for (const handles of receivers.values()) {
        for (const entry of handles) {
          await closeReceiver(entry);
        }
      }
      receivers.clear();
      await client.close();
    },
  };
}

/**
 * Azure Service Bus message broker.
 *
 * @since 0.1.0
 */
export class ServiceBusBroker implements MessageBrokerAdapter {
  #runtime: IRuntimeServices;
  #serializer: ISerializer;
  #connectionString: string;
  #adminConnectionString: string;
  #injectedClient: IServiceBusTransport | undefined;
  #defaultQueue: string;
  #replyTopic: string;
  #logger: { error: (msg: string) => void } | undefined;
  #transport: IServiceBusTransport | null = null;
  #ready = false;
  #subscriptions: Map<string, IServiceBusSubscription>;
  #rr: RequestReplyCore;

  constructor(
    runtime: IRuntimeServices,
    serializer: ISerializer,
    options?: ServiceBusOptions,
  ) {
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#connectionString = options?.connectionString ?? '';
    this.#adminConnectionString = options?.adminConnectionString ?? options?.connectionString ?? '';
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
   * subscription created through the administration client.
   *
   * On failure after admin creation, compensates by deleting the subscription
   * so a later retry can succeed (B6).
   */
  async #openReplyInbox(onReply: (message: unknown) => void): Promise<ReplyInbox> {
    if (!this.#transport) {
      throw new Error('ServiceBusBroker is not connected');
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
          // Await settlement so the delivery callback does not resolve
          // before ack/nack completes.
          await msg.ack();
        } catch (err) {
          if (this.#logger) {
            this.#logger.error(`Service Bus reply deserialization error: ${err}`);
          }
          await msg.nack();
        }
      });

      return {
        address: this.#replyTopic,
        close: async () => {
          if (closed) return;
          closed = true;
          await sub.close();
          await this.#transport!.deleteSubscription(this.#replyTopic, inboxSub);
        },
      };
    } catch (err) {
      // Compensate: open failed after admin create, delete the subscription
      try {
        await this.#transport.deleteSubscription(this.#replyTopic, inboxSub);
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
      'Azure Service Bus',
      'npm:@azure/service-bus@^7',
    );

    if (this.#injectedClient !== undefined) {
      this.#transport = this.#injectedClient;
    } else {
      if (this.#connectionString === '') {
        throw new Error(
          'ServiceBusBroker requires a connectionString when no client is injected. ' +
            'Pass `connectionString` (or an `IServiceBusTransport` as `client`).',
        );
      }
      const mod = await loadServiceBusModule();
      this.#transport = adaptServiceBusModule(mod, {
        connectionString: this.#connectionString,
        adminConnectionString: this.#adminConnectionString,
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
      throw new Error('ServiceBusBroker is not connected');
    }
    const serialized = this.#serializer.serialize(message);
    await this.#transport.send(topic, serialized);
  }

  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    if (!this.#transport) {
      throw new Error('ServiceBusBroker is not connected');
    }

    const subscriptionId = this.#runtime.uuid();
    const queue = options?.queue ?? this.#defaultQueue;

    const sub = await this.#transport.open(topic, queue, async (msg) => {
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
          this.#logger.error(`Service Bus handler error: ${handlerError}`);
        }
        return msg.nack();
      }

      return msg.ack();
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
