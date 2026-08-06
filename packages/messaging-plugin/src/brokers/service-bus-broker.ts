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
 * Declares the constructors used from the real Azure Service Bus SDK.
 */
export interface ServiceBusSdkModule {
  ServiceBusClient: new (connectionString: string) => {
    createSender(queueOrTopicName: string): {
      sendMessages(messages: { body: unknown }): Promise<void>;
      close(): Promise<void>;
    };
    createReceiver(queueName: string, options?: unknown): {
      subscribe(options: {
        processMessage: (
          msg: { body: unknown; complete: () => Promise<void>; abandon: () => Promise<void> },
        ) => Promise<void>;
        processError: (err: unknown) => void | Promise<void>;
      }): { close: () => Promise<void> };
      close(): Promise<void>;
    };
    createReceiver(
      topicName: string,
      subscriptionName: string,
      options?: unknown,
    ): {
      subscribe(options: {
        processMessage: (
          msg: { body: unknown; complete: () => Promise<void>; abandon: () => Promise<void> },
        ) => Promise<void>;
        processError: (err: unknown) => void | Promise<void>;
      }): { close: () => Promise<void> };
      close(): Promise<void>;
    };
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
    onMessage: (msg: { payload: string; ack: () => void; nack: () => void }) => void,
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
  options: { connectionString: string; adminConnectionString: string },
): IServiceBusTransport {
  const client = new mod.ServiceBusClient(options.connectionString);
  const admin = new mod.ServiceBusAdministrationClient(options.adminConnectionString);

  const senders = new Map<string, ReturnType<typeof client['createSender']>>();
  const receivers = new Map<string, { close: () => Promise<void> }>();

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
      onMessage: (msg: { payload: string; ack: () => void; nack: () => void }) => void,
    ): Promise<IServiceBusSubscription> => {
      // createReceiver(topicName, subscriptionName) — two positional strings.
      const receiver = client.createReceiver(topic, subscription) as {
        subscribe(options: {
          processMessage: (
            msg: { body: unknown; complete: () => Promise<void>; abandon: () => Promise<void> },
          ) => Promise<void>;
          processError: (err: unknown) => void | Promise<void>;
        }): { close: () => Promise<void> };
        close(): Promise<void>;
      };

      const subHandle = receiver.subscribe({
        processMessage: async (msg) => {
          const body = typeof msg.body === 'string' ? msg.body : String(msg.body ?? '');
          await new Promise<void>((resolve) => {
            onMessage({
              payload: body,
              ack: async () => {
                await msg.complete();
                resolve();
              },
              nack: async () => {
                await msg.abandon();
                resolve();
              },
            });
            // If the handler never calls ack or nack, resolve after a microtask
            // so the promise doesn't hang indefinitely.
            Promise.resolve().then(resolve);
          });
        },
        processError: () => {
          // Errors handled by broker's logger
        },
      });

      const key = `${topic}/${subscription}`;
      receivers.set(key, subHandle);

      // Await required — the SDK requires async `open` for its type contract.
      await Promise.resolve();

      return {
        close: async () => {
          const handle = receivers.get(key);
          if (handle) {
            await handle.close();
            receivers.delete(key);
          }
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
      for (const receiver of receivers.values()) {
        await receiver.close();
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

    const sub = await this.#transport.open(this.#replyTopic, inboxSub, (msg) => {
      onReply(msg.payload);
    });

    return {
      address: this.#replyTopic,
      close: async () => {
        await sub.close();
        await this.#transport!.deleteSubscription(this.#replyTopic, inboxSub);
      },
    };
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
      const mod = await loadServiceBusModule();
      this.#transport = adaptServiceBusModule(mod, {
        connectionString: this.#connectionString,
        adminConnectionString: this.#adminConnectionString,
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

    const sub = await this.#transport.open(topic, queue, (msg) => {
      (async () => {
        try {
          const deserialized = this.#serializer.deserialize<T>(msg.payload);
          const metadata: MessageMetadata = {
            topic,
          };
          await handler(deserialized, metadata);
          msg.ack();
        } catch (err) {
          msg.nack();
          if (this.#logger) {
            this.#logger.error(`Service Bus handler error: ${err}`);
          }
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
