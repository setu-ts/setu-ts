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

import {
  createCachedProbe,
  type ISubscription,
  type MessageHandler,
  type MessageMetadata,
  type RequestHandler,
  type RequestOptions,
  type SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import type { ServiceBusRetryOptions } from '../interfaces/index.ts';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { normalizeTransportHeaders, type TransportHeaderValue } from './header-normalize.ts';
import { describeError } from './describe-error.ts';
import type { ReplyInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { assertNotCloudflareWorkers } from './cloud-gate.ts';
import { ReplyInboxUnavailableError } from '../errors.ts';

/** Default reply topic for request-reply. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/** Default subscription name. */
const DEFAULT_QUEUE = 'messaging-consumers';

/** Reachability outcome cache lifetime for the broker probe (M90b), in ms. */
const PROBE_TTL_MS = 5000;

/** Per-probe timeout (M90b), in milliseconds. A slower probe counts as unreachable. */
const PROBE_TIMEOUT_MS = 2000;

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
  /**
   * The SDK's numeric `RetryMode` enum (re-exported by `@azure/service-bus`).
   * The public `ServiceBusRetryOptions.mode` string is translated through
   * this before reaching the SDK — `@azure/core-amqp` compares the value
   * with `===` against its enum, so an untranslated string silently
   * behaves as the SDK default (`Fixed`).
   */
  RetryMode: { readonly Exponential: number; readonly Fixed: number };
  ServiceBusClient: new (
    connectionString: string,
    options?: { retryOptions?: Omit<ServiceBusRetryOptions, 'mode'> & { mode?: number } },
  ) => {
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
    /**
     * Reads the namespace's runtime description (M90b). One cheap
     * administration round trip is the only non-mutating call that proves
     * the namespace itself is reachable; optional so a minimal fake module
     * without it degrades to `unknown` reachability rather than a false
     * `down`.
     */
    getNamespaceProperties?(): Promise<unknown>;
  };
}

/**
 * Domain port for Azure Service Bus operations.
 */
export interface IServiceBusTransport {
  /** Send a body to a topic. */
  send(
    topic: string,
    body: string,
    applicationProperties?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /**
   * Open a receiver on a topic subscription.
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
        applicationProperties?: Readonly<Record<string, string>>;
        /** The platform-assigned message id, when the transport carried one (X28-4). */
        messageId?: string;
        /** The platform-assigned enqueue time, when the transport carried one (X28-4). */
        timestamp?: Date;
      },
    ) => void | Promise<void>,
  ): Promise<IServiceBusSubscription>;
  /** Create a subscription (for RPC inbox). */
  createSubscription(topic: string, subscription: string): Promise<void>;
  /** Delete a subscription (for RPC inbox teardown). */
  deleteSubscription(topic: string, subscription: string): Promise<void>;
  /** Close the client and all senders/receivers. */
  close(): Promise<void>;
  /**
   * Reports whether the Service Bus namespace is reachable (optional, M70c).
   *
   * The real adapter peeks the namespace via its existing client; a transport
   * without a liveness check omits it and the broker reports `unknown`
   * reachability. The SDK owns streaming-pull reconnection, so the broker
   * issues no reconnect loop of its own.
   *
   * Resolving `undefined` means **could not determine** — the probe itself
   * failed rather than the namespace answering (V5-2). Widened from
   * `Promise<boolean>` in 0.5.1; an implementation that still resolves a
   * plain `boolean` satisfies it unchanged.
   */
  isHealthy?(): Promise<boolean | undefined>;
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
  /**
   * SDK retry budget for the data client (M90b / X28-6). Forwarded to
   * `ServiceBusClient` only — the administration client is never given it.
   *
   * @since 0.5.0
   */
  retryOptions?: ServiceBusRetryOptions;
  /** Optional logger. */
  logger?: { error: (msg: string) => void };
}

/**
 * Statuses that positively establish the namespace is not there.
 *
 * A 404 or a 410 is the management plane telling us the namespace does not
 * exist (or no longer does), which IS a fact about the data plane: there is
 * nothing to publish to. Every other status is a fact about the MANAGEMENT
 * request — see {@linkcode classifyProbeFailure}.
 */
const NAMESPACE_ABSENT_STATUSES: ReadonlySet<number> = new Set([404, 410]);

/**
 * Statuses that prove the namespace answered without proving anything else.
 *
 * A 401/403 is an auth verdict, which means the request reached the namespace
 * and got a considered reply — a send/listen-only credential is not an outage.
 */
const NAMESPACE_ANSWERED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Classifies a failed administration probe (M90b, corrected for V5-2).
 *
 * The probe reads the namespace's MANAGEMENT plane to report on its DATA
 * plane, and the two fail independently, so the caught error has to be sorted
 * into three outcomes rather than two. The question each arm answers is not
 * "was this response an error" — every input here is one — but **does this
 * response establish a fact about the DATA plane?**
 *
 * - **`true` — reachable.** {@linkcode NAMESPACE_ANSWERED_STATUSES}: the
 *   namespace answered with an auth verdict, which proves the transport path
 *   is live. A send/listen-only credential is not an outage.
 * - **`false` — down.** {@linkcode NAMESPACE_ABSENT_STATUSES}: the namespace
 *   is not there. This is the only class of answer that positively
 *   establishes the data plane is unavailable.
 * - **`undefined` — cannot determine.** Everything else. Two shapes reach
 *   here and they share one reason. A management-plane status that is neither
 *   of the above — 429 throttling, a 5xx, a 408 — reports on the MANAGEMENT
 *   request, not on the namespace: Azure documents 429 as temporary
 *   throttling or a conflicting management operation, and a data plane
 *   publishing fine throughout is the normal case. And no `statusCode` at all
 *   is a network-layer failure: ECONNRESET, DNS failure, a firewalled or
 *   separately-private-endpointed management plane, and the emulator, which
 *   ships no TLS listener for administration.
 *
 * Reporting `down` for either shape drains a replica whose data plane is
 * publishing 200s — that is V5-2, and the 429 arm is the same defect reached
 * through a status code instead of a socket error. A namespace that is
 * genuinely gone still reports `down`: the data client stops being ready, and
 * the indicator checks `isReady()` before it ever consults this probe.
 *
 * @param error - The caught probe error
 * @returns `true` reachable, `false` positively absent, `undefined` unknown
 */
function classifyProbeFailure(error: unknown): boolean | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== 'number') {
    return undefined;
  }
  if (NAMESPACE_ANSWERED_STATUSES.has(statusCode)) {
    return true;
  }
  if (NAMESPACE_ABSENT_STATUSES.has(statusCode)) {
    return false;
  }
  return undefined;
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
 * Translates the public `ServiceBusRetryOptions` shape into the SDK's
 * constructor shape: `mode` becomes the numeric `RetryMode` value. Without
 * the translation, `'exponential'` reaches `@azure/core-amqp`'s
 * `calculateDelay`, fails its `=== RetryMode.Exponential` comparison, and
 * silently behaves as fixed delay.
 *
 * @param mod - The loaded SDK module (supplies the enum values)
 * @param retryOptions - The public retry budget
 * @returns The SDK-shaped retry budget
 */
function toSdkRetryOptions(
  mod: ServiceBusSdkModule,
  retryOptions: ServiceBusRetryOptions,
): Omit<ServiceBusRetryOptions, 'mode'> & { mode?: number } {
  return {
    ...retryOptions,
    mode: retryOptions.mode === 'exponential' ? mod.RetryMode.Exponential : mod.RetryMode.Fixed,
  };
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
    retryOptions?: ServiceBusRetryOptions | undefined;
  },
): IServiceBusTransport {
  // The retry budget rides the DATA client only: the administration
  // client's pipeline options are a different contract and never receive it.
  const client = options.retryOptions !== undefined
    ? new mod.ServiceBusClient(
      options.connectionString,
      { retryOptions: toSdkRetryOptions(mod, options.retryOptions) },
    )
    : new mod.ServiceBusClient(options.connectionString);
  const admin = new mod.ServiceBusAdministrationClient(options.adminConnectionString);

  const senders = new Map<string, ReturnType<typeof client['createSender']>>();
  // Track multiple receiver handles per key to support duplicate opens
  const receivers = new Map<string, OpenReceiver[]>();
  // Captured once so the probe below needs no assertion and keeps calling
  // through the owner.
  const readNamespace = admin.getNamespaceProperties;

  return {
    send: async (
      topic: string,
      body: string,
      applicationProperties?: Readonly<Record<string, string>>,
    ): Promise<void> => {
      let sender = senders.get(topic);
      if (!sender) {
        sender = client.createSender(topic);
        senders.set(topic, sender);
      }
      const message = applicationProperties ? { body, applicationProperties } : { body };
      await sender.sendMessages(message);
    },
    open: async (
      topic: string,
      subscription: string,
      onMessage: (
        msg: {
          payload: string;
          ack: () => void;
          nack: () => void;
          applicationProperties?: Readonly<Record<string, string>>;
          messageId?: string;
          timestamp?: Date;
        },
      ) => void | Promise<void>,
    ): Promise<IServiceBusSubscription> => {
      // createReceiver(topicName, subscriptionName) — two positional strings.
      const receiver = client.createReceiver(topic, subscription) as IServiceBusReceiver;

      const subHandle = receiver.subscribe(
        {
          processMessage: async (rawMessage) => {
            const msg = rawMessage as {
              body?: unknown;
              // The SDK types this `number | boolean | string | Date | null`.
              applicationProperties?: Readonly<Record<string, TransportHeaderValue>>;
              // The SDK's own field names (X28-4). The real
              // `ServiceBusReceivedMessage` carries both as core properties.
              messageId?: string;
              enqueuedTimeUtc?: Date;
            };
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
              applicationProperties: normalizeTransportHeaders(msg.applicationProperties),
              // X28-4: read the platform identity rather than dropping it;
              // omitted — never `undefined` — when the transport carries none.
              ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
              ...(msg.enqueuedTimeUtc !== undefined ? { timestamp: msg.enqueuedTimeUtc } : {}),
            });
          },
          processError: (args: IServiceBusProcessErrorArgs) =>
            Promise.resolve(
              options.logger?.error(`Service Bus receiver error: ${describeError(args.error)}`),
            ),
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

    // M90b: the documented production reachability probe, implemented.
    // One cheap administration round trip proves the namespace is
    // reachable; a positively identified 401/403 also counts (the
    // namespace ANSWERED with an auth verdict — a send/listen-only
    // credential is not a network outage), and any other failure is
    // unreachability. Omitted when the module's administration client has
    // no namespace read, so a minimal fake degrades to `unknown` rather
    // than lying `down`. The broker caches and bounds this probe.
    ...(typeof readNamespace === 'function'
      ? {
        isHealthy: async (): Promise<boolean | undefined> => {
          try {
            await readNamespace.call(admin);
            return true;
          } catch (error) {
            return classifyProbeFailure(error);
          }
        },
      }
      : {}),
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
  #retryOptions: ServiceBusRetryOptions | undefined;
  /**
   * Cached, bounded reachability probe (M90b), built once at `connect()`
   * over the resolved transport's `isHealthy`. The broker — not the health
   * endpoint — owns the 5-second cache and the 2-second bound, so polling
   * `/health` cannot turn into broker load, and a hung transport cannot
   * hold a health response past the bound.
   *
   * Tri-state since V5-2: the bound resolves `undefined`, not `false`. A
   * management endpoint too slow to answer within 2 s has told us nothing
   * about the data plane, and reporting `down` there drained replicas that
   * were publishing fine.
   */
  #probe: (() => Promise<boolean | undefined>) | null = null;

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
    this.#retryOptions = options?.retryOptions;
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
            this.#logger.error(`Service Bus reply deserialization error: ${describeError(err)}`);
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
        retryOptions: this.#retryOptions,
      });
    }

    const transport = this.#transport;
    if (transport !== null && typeof transport.isHealthy === 'function') {
      const isHealthy = transport.isHealthy;
      this.#probe = createCachedProbe<boolean | undefined>({
        // Bound call: a transport's `isHealthy` may read instance state.
        probe: () => isHealthy.call(transport),
        // A probe that times out or rejects has not reached the namespace, so
        // it cannot report on it. `false` — the helper's default, and correct
        // for a probe that reads the backend directly — is wrong here (V5-2).
        fallback: undefined,
        ttlMs: PROBE_TTL_MS,
        timeoutMs: PROBE_TIMEOUT_MS,
        hrtime: this.#runtime.hrtime.bind(this.#runtime),
        setTimer: (fn, ms) => this.#runtime.setTimeout(fn, ms),
        clearTimer: (handle) => this.#runtime.clearTimeout(handle),
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
      // Drop the cached probe WITH the transport (M90b): a surviving probe
      // would serve the stale cached outcome within its TTL and then fire
      // real I/O against the closed client. Post-close `reachability()`
      // answers `undefined` — not known down (M70c), never stale `true`.
      this.#probe = null;
    }
    this.#ready = false;
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Tri-state backend reachability (M70c, bounded in M90b).
   *
   * The Azure SDK owns streaming-pull reconnection, so the broker issues no
   * reconnect loop of its own; the probe delegates to the transport's
   * `isHealthy?()` — the real adapter reads the namespace through the
   * administration client — through the broker's own cached probe (5 s
   * TTL, 2 s bound), so repeated health polls cost at most one round trip
   * per TTL and a hung transport cannot hold a caller past the bound.
   * `true`/`false` from the probe, `undefined` when the transport omits the
   * member (a minimal fake) — the indicator then reports
   * `reachable: 'unknown'`.
   *
   * @returns `true`/`false`/`undefined` as described
   * @since 0.1.0
   */
  async reachability(): Promise<boolean | undefined> {
    if (this.#probe === null) {
      return undefined;
    }
    return await this.#probe();
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
      throw new Error('ServiceBusBroker is not connected');
    }
    const serialized = this.#serializer.serialize(message);
    await this.#transport.send(topic, serialized, headers);
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
        // X28-4: copy the platform identity onto the metadata ONLY when the
        // transport carried it, so an absent member means "none delivered".
        const metadata: MessageMetadata = {
          topic,
          headers: msg.applicationProperties ?? {},
          ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
          ...(msg.timestamp !== undefined ? { timestamp: msg.timestamp } : {}),
        };
        await handler(deserialized, metadata);
      } catch (err) {
        handlerError = err as Error;
      }

      if (handlerError !== null) {
        if (this.#logger) {
          this.#logger.error(`Service Bus handler error: ${describeError(handlerError)}`);
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
