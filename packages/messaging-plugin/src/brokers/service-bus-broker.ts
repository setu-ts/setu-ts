/**
 * Azure Service Bus broker implementation over {@linkcode IServiceBusTransport}.
 *
 * Publishes to topics, subscribes through named subscriptions, and supports
 * request-reply via a shared reply topic with per-instance subscriptions.
 * Topics and named competing subscriptions must pre-exist. Per-instance
 * fan-out and RPC reply subscriptions are created through the administration
 * client, which requires the `Manage` right.
 *
 * The SDK is lazy-loaded through {@linkcode loadServiceBusModule} and adapted
 * to the domain port via {@linkcode adaptServiceBusModule}, or injected
 * directly as {@linkcode IServiceBusTransport}.
 *
 * @module
 */

import {
  createCachedProbe,
  BackendOutcomeUnknownError,
  resolveProbeTiming,
  withDeadline,
  type ISubscription,
  type MessageHandler,
  type MessageMetadata,
  type PublishOptions,
  type RequestHandler,
  type RequestOptions,
  type SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { ServiceBusRetryOptions } from '../interfaces/index.ts';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { normalizeTransportHeaders, type TransportHeaderValue } from './header-normalize.ts';
import { buildTransportHeaders, validatePublishOptions } from './publish-options.ts';
import { describeError } from './describe-error.ts';
import type { ReplyInbox } from './inbox.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { assertNotCloudflareWorkers } from './cloud-gate.ts';
import { PublishTimeoutError, ReplyInboxUnavailableError } from '../errors.ts';
import { resolvePublishTimeoutMs } from './publish-timeout.ts';
import {
  isServiceBusOutage,
  serviceBusPublishCause,
  resolveServiceBusConcurrency,
} from './service-bus-faults.ts';
import type { ConsumerRetryOptions } from '../interfaces/index.ts';
import { resolveServiceBusRetry, type ResolvedConsumerRetry } from './consumer-retry.ts';
import { fanOutName, markFanOut, SubscriptionNameExistsError, wantsFanOut } from './fan-out.ts';

/** Default reply topic for request-reply. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/** Default subscription name. */
const DEFAULT_QUEUE = 'messaging-consumers';

const SERVICE_BUS_MIN_AUTO_DELETE_ON_IDLE_MS = 300000;

/** Reachability outcome cache lifetime for the broker probe (M90b), in ms. */
const PROBE_TTL_MS = 5000;

/** Per-probe timeout (M90b), in milliseconds. A slower probe counts as unreachable. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Structural type matching the real SDK's ProcessErrorArgs callback argument
 * (@azure/service-bus).
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
 * (@azure/service-bus). The property is autoCompleteMessages, not autoComplete.
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
  /**
   * Moves a terminal delivery into its subscription's dead-letter queue.
   * @param message - Received SDK message
   * @param options - Fixed reason, without exception or payload text
   * @returns Settlement completion
   * @throws On settlement failure
   * @since 0.14.0
   */
  deadLetterMessage?(message: unknown, options: { deadLetterReason: string }): Promise<void>;
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
      sendMessages(
        messages: {
          body: unknown;
          applicationProperties?: unknown;
          messageId?: string;
        },
        options?: { abortSignal?: AbortSignal },
      ): Promise<void>;
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
    /**
     * Creates a per-instance RPC or fan-out subscription.
     * @param topicName - Owning topic
     * @param subscriptionName - Unique subscription name
     * @param options - Optional ISO 8601 idle lifetime
     * @returns Creation completion
     * @throws On management failure
     * @since 0.14.0
     */
    createSubscription(
      topicName: string,
      subscriptionName: string,
      options?: { autoDeleteOnIdle?: string },
    ): Promise<unknown>;
    /**
     * Reads a subscription's delivery budget when management rights permit it.
     * @param topic - Topic name
     * @param subscription - Subscription name
     * @returns The configured delivery budget
     * @throws On management failure
     * @since 0.14.0
     */
    getSubscription?(topic: string, subscription: string): Promise<{ maxDeliveryCount?: number }>;
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
  /**
   * Send a body to a topic.
   *
   * @param messageId - Native Service Bus message id (M106 §3.3): a repeated id
   *   is de-duplicated only on an entity configured with duplicate detection
   */
  send(
    topic: string,
    body: string,
    applicationProperties?: Readonly<Record<string, string>>,
    messageId?: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
  /**
   * Open a receiver on a topic subscription.
   * @param onMessage - Called per delivered message
   */
  open(
    topic: string,
    subscription: string,
    onMessage: (msg: {
      payload: string;
      ack: () => void;
      nack: () => void;
      applicationProperties?: Readonly<Record<string, string>>;
      /** The platform-assigned message id, when the transport carried one (X28-4). */
      messageId?: string;
      /** The platform-assigned enqueue time, when the transport carried one (X28-4). */
      timestamp?: Date;
      /** Prior deliveries, zero on the first AMQP delivery. @since 0.14.0 */
      deliveryCount?: number;
      /**
       * Dead-letters this delivery using a fixed reason.
       * @param reason - Framework terminal reason
       * @returns Settlement completion
       * @throws On settlement failure
       * @since 0.14.0
       */
      deadLetter?(reason: string): Promise<void>;
    }) => void | Promise<void>,
    options?: {
      maxConcurrentCalls?: number;
      onReceiveError?: (error: unknown, errorSource: string) => void;
    },
  ): Promise<IServiceBusSubscription>;
  /**
   * Creates a per-instance RPC or fan-out subscription; requires Manage rights.
   * @param topic - Owning topic
   * @param subscription - Unique subscription name
   * @param options - Optional idle deletion lifetime
   * @returns Creation completion
   * @throws On management failure, or RangeError for an invalid idle lifetime
   * @since 0.14.0
   */
  createSubscription(
    topic: string,
    subscription: string,
    options?: { readonly autoDeleteOnIdleMs?: number },
  ): Promise<void>;
  /**
   * Reads an existing subscription's delivery budget.
   * @param topic - Topic name
   * @param subscription - Subscription name
   * @returns Optional platform delivery budget
   * @throws On management failure
   * @since 0.14.0
   */
  getSubscription?(topic: string, subscription: string): Promise<{ maxDeliveryCount?: number }>;
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
  /** Whole publish bound in ms; 15000 by default, 0 disables it. @since 0.14.0 */
  publishTimeoutMs?: number;
  /** Application receive concurrency, integer 1–1000, default 1. RPC inbox stays at 1. @since 0.14.0 */
  maxConcurrentCalls?: number;
  /** Held consumer retries; false restores immediate abandon. @since 0.14.0 */
  consumerRetry?: false | ConsumerRetryOptions;
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
  /**
   * How long a positive data-plane outcome stays authoritative, in ms.
   * Default `5000`. A negative data-plane outcome is retained until a
   * successful publish, a delivery or a positive management probe contradicts it; elapsed
   * time alone does not report a known outage as healthy.
   *
   * Must be a positive integer; a non-finite, fractional, zero or negative
   * value is REFUSED at construction rather than accepted (M95b review).
   * `NaN` — what `Number(env.X)` yields for an unset variable — would
   * otherwise freeze the window so recorded evidence never ages out, and
   * `0` would disable it entirely, reinstating the pre-M95b behaviour. The
   * option has no disable arm by design.
   *
   * @throws {Error} If the value is not a positive integer
   */
  dataPlaneEvidenceMs?: number;
  /** Optional logger. */
  logger?: { error: (msg: string) => void; warn?: (msg: string) => void };
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
 * A log-safe label for an admin or SDK failure: its code or status, never its
 * message text (remote text stays out of logs).
 */
function errorName(error: unknown): string {
  try {
    const value = error as { code?: unknown; statusCode?: unknown } | null;
    if (typeof value?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.code))
      return value.code;
    if (typeof value?.statusCode === 'number' && Number.isInteger(value.statusCode))
      return `status ${value.statusCode}`;
  } catch {
    /* fall through */
  }
  return 'unknown error';
}

/** Whether an admin failure is an authorization refusal (401/403 or an Unauthorized code). */
function unauthorized(error: unknown): boolean {
  try {
    const value = error as { code?: unknown; statusCode?: unknown } | null;
    return (
      value?.statusCode === 401 ||
      value?.statusCode === 403 ||
      (typeof value?.code === 'string' && value.code.startsWith('Unauthorized'))
    );
  } catch {
    return false;
  }
}

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
 * genuinely gone is NOT caught here, and `isReady()` does not catch it
 * either: that member is LIFECYCLE state — set when `connect()` succeeds,
 * cleared only by `disconnect()` — with no liveness input, so a namespace
 * dead for minutes still answers `isReady() === true` in 0 ms (the claimed
 * gate does not exist; corrected M95b). What catches a dead data plane is
 * the broker's data-plane evidence window: a recent publish failure resolves
 * `reachability()` `false`, which the indicator maps to `down`.
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
 * Validates {@linkcode ServiceBusOptions.dataPlaneEvidenceMs} at construction
 * (M95b review), refusing a value outside its domain rather than reading as
 * configured while the window silently misbehaves.
 *
 * The two out-of-domain cases each reinstate a defect this broker exists to
 * close, and both arrive from ordinary configuration. **`NaN`** — what
 * `Number(env.X)` yields for an unset or misspelled variable — makes every
 * `elapsed >= window` comparison `false`, so positive evidence NEVER ages
 * out and one publish at boot pins `reachability()` at its outcome
 * indefinitely. **`0` or negative** discard positive evidence instantly,
 * making an idle recovery depend only on the management probe. The option
 * deliberately has no disable arm.
 *
 * @param value - The configured window, or `undefined` for the default
 * @returns The validated window in ms
 * @throws {Error} If the value is not a finite integer of at least 1 ms
 */
function resolveEvidenceMs(value: number | undefined): number {
  if (value === undefined) {
    return PROBE_TTL_MS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `ServiceBusBroker: dataPlaneEvidenceMs must be a positive integer of ` +
        `milliseconds, received ${String(value)}. Omit the option for the ` +
        `default ${PROBE_TTL_MS}ms; there is no value that disables the ` +
        `data-plane evidence window.`,
    );
  }
  return value;
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
  try {
    return (await import('@azure/service-bus')) as unknown as ServiceBusSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@azure/service-bus', {
      requiredBy: '@setu-ts/messaging-plugin',
      cause: error,
    });
  }
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
  const client =
    options.retryOptions !== undefined
      ? new mod.ServiceBusClient(options.connectionString, {
          retryOptions: toSdkRetryOptions(mod, options.retryOptions),
        })
      : new mod.ServiceBusClient(options.connectionString);
  const admin = new mod.ServiceBusAdministrationClient(options.adminConnectionString);

  const senders = new Map<string, ReturnType<(typeof client)['createSender']>>();
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
      messageId?: string,
      sendOptions?: { abortSignal?: AbortSignal },
    ): Promise<void> => {
      let sender = senders.get(topic);
      if (!sender) {
        sender = client.createSender(topic);
        senders.set(topic, sender);
      }
      const message = {
        body,
        ...(applicationProperties !== undefined ? { applicationProperties } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
      };
      await sender.sendMessages(message, sendOptions);
    },
    open: async (
      topic: string,
      subscription: string,
      onMessage: (msg: {
        payload: string;
        ack: () => void;
        nack: () => void;
        applicationProperties?: Readonly<Record<string, string>>;
        messageId?: string;
        timestamp?: Date;
      }) => void | Promise<void>,
      receiveOptions?: {
        maxConcurrentCalls?: number;
        onReceiveError?: (error: unknown, errorSource: string) => void;
      },
    ): Promise<IServiceBusSubscription> => {
      // Explicit renewal budget protects held consumer retries.
      const receiver = client.createReceiver(topic, subscription, {
        maxAutoLockRenewalDurationInMs: 300000,
      });

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
              deliveryCount?: number;
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
              ...(msg.deliveryCount === undefined ? {} : { deliveryCount: msg.deliveryCount }),
              ...(receiver.deadLetterMessage === undefined
                ? {}
                : {
                    deadLetter: (reason: string) =>
                      receiver.deadLetterMessage!(rawMessage, { deadLetterReason: reason }),
                  }),
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
            Promise.resolve().then(() => {
              receiveOptions?.onReceiveError?.(args.error, args.errorSource);
              options.logger?.error(`Service Bus receiver error: ${describeError(args.error)}`);
            }),
        },
        {
          autoCompleteMessages: false,
          ...(receiveOptions?.maxConcurrentCalls === undefined
            ? {}
            : { maxConcurrentCalls: receiveOptions.maxConcurrentCalls }),
        },
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
    createSubscription: async (
      topic: string,
      subscription: string,
      settings?: { readonly autoDeleteOnIdleMs?: number },
    ): Promise<void> => {
      const idle = settings?.autoDeleteOnIdleMs;
      if (idle !== undefined && (!Number.isSafeInteger(idle) || idle < 1))
        throw new RangeError('Service Bus autoDeleteOnIdleMs must be a positive integer');
      try {
        await admin.createSubscription(
          topic,
          subscription,
          settings?.autoDeleteOnIdleMs === undefined
            ? undefined
            : { autoDeleteOnIdle: `PT${settings.autoDeleteOnIdleMs / 1000}S` },
        );
      } catch (error) {
        const failure = error as { name?: unknown; statusCode?: unknown; code?: unknown } | null;
        if (
          failure?.name === 'RestError' &&
          failure.statusCode === 409 &&
          failure.code === 'MessageEntityAlreadyExistsError'
        )
          throw new SubscriptionNameExistsError(error);
        throw error;
      }
    },
    ...(admin.getSubscription === undefined
      ? {}
      : {
          getSubscription: (topic: string, subscription: string) =>
            admin.getSubscription!(topic, subscription),
        }),
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
  #logger: { error: (msg: string) => void; warn?: (msg: string) => void } | undefined;
  readonly #retry: ResolvedConsumerRetry;
  readonly #warnings = new Set<string>();
  #generation = 0;
  #transport: IServiceBusTransport | null = null;
  #ready = false;
  #subscriptions: Map<string, IServiceBusSubscription>;
  #rr: RequestReplyCore;
  #retryOptions: ServiceBusRetryOptions | undefined;
  readonly #publishTimeoutMs: number;
  readonly #maxConcurrentCalls: number;
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
  /** The uncached management-probe operation, used to invalidate stale probe results after an outage. */
  #probeSource: (() => Promise<boolean | undefined>) | null = null;
  /**
   * How long a positive data-plane outcome stays authoritative (M99a).
   * A negative outcome stays authoritative until a successful publish, a delivery or a
   * positive management probe contradicts it.
   */
  #evidenceMs: number;
  /**
   * The most recent data-plane outcome (M95b): `at` is a monotonic
   * `runtime.hrtime()` reading. Publishes (including deadlines), receive outages
   * and delivered messages supply evidence. `null` means no authoritative evidence, so
   * `reachability()` falls through to the management probe; a negative record
   * stays authoritative until contradicted. Private state, read only by this
   * broker's own `reachability()`.
   */
  #evidence: { at: number; reachable: boolean } | null = null;

  constructor(runtime: IRuntimeServices, serializer: ISerializer, options?: ServiceBusOptions) {
    this.#retry = resolveServiceBusRetry(options?.consumerRetry);
    this.#publishTimeoutMs = resolvePublishTimeoutMs(options?.publishTimeoutMs);
    this.#maxConcurrentCalls = resolveServiceBusConcurrency(options?.maxConcurrentCalls);
    this.#runtime = runtime;
    this.#serializer = serializer;
    this.#connectionString = options?.connectionString ?? '';
    this.#adminConnectionString = options?.adminConnectionString ?? options?.connectionString ?? '';
    this.#injectedClient = options?.client;
    this.#defaultQueue = options?.defaultQueue ?? DEFAULT_QUEUE;
    this.#replyTopic = options?.replyTopic ?? DEFAULT_REPLY_TOPIC;
    this.#logger = options?.logger;
    this.#retryOptions = options?.retryOptions;
    this.#evidenceMs = resolveEvidenceMs(options?.dataPlaneEvidenceMs);
    this.#subscriptions = new Map();
    this.#rr = new RequestReplyCore({
      warn: (message) => this.#write(message),
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

    const generation = this.#generation;
    const inboxSub = `rr-inbox-${this.#runtime.uuid()}`;

    try {
      await this.#transport.createSubscription(this.#replyTopic, inboxSub, {
        autoDeleteOnIdleMs: SERVICE_BUS_MIN_AUTO_DELETE_ON_IDLE_MS,
      });
    } catch {
      throw new ReplyInboxUnavailableError(this.#replyTopic);
    }

    let closed = false;
    try {
      const sub = await this.#transport.open(
        this.#replyTopic,
        inboxSub,
        async (msg) => {
          if (closed || generation !== this.#generation) return;
          this.#recordDataPlaneOutcome(true);
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
        },
        {
          onReceiveError: (error, source) => {
            if (!closed && generation === this.#generation) this.#onReceiveError(error, source);
          },
        },
      );

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

    assertNotCloudflareWorkers(this.#runtime, 'Azure Service Bus', '@azure/service-bus');

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
      // Bound call: a transport's `isHealthy` may read instance state.
      this.#probeSource = () => isHealthy.call(transport);
      this.#probe = this.#createManagementProbe();
    }

    this.#ready = true;
  }

  async disconnect(): Promise<void> {
    this.#generation++;
    await this.#rr.close();

    // Every subscription is closed even when one close fails; the first
    // failure is rethrown once the transport is closed too.
    const closes = await Promise.allSettled(
      [...this.#subscriptions.values()].map((sub) => sub.close()),
    );
    this.#subscriptions.clear();

    if (this.#transport) {
      await this.#transport.close();
      this.#transport = null;
      // Drop the cached probe WITH the transport (M90b): a surviving probe
      // would serve the stale cached outcome within its TTL and then fire
      // real I/O against the closed client. Post-close `reachability()`
      // answers `undefined` — not known down (M70c), never stale `true`.
      this.#probe = null;
      this.#probeSource = null;
      // The evidence window shares the probe's fate (M95b): a surviving
      // outcome would serve stale `true` for a client that no longer exists.
      this.#evidence = null;
    }
    this.#ready = false;
    const failed = closes.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Tri-state backend reachability (M70c, bounded in M90b; evidence-first
   * in M95b; a negative outcome answers at once in M101a).
   *
   * The evidence is consulted FIRST: a data-plane outcome —
   * a successful publish or delivery, a publish outage or deadline, or a receive
   * outage, recorded at zero extra round trips — answers directly, because the thing reported on should be the
   * plane the application actually uses. Positive evidence expires after
   * {@linkcode ServiceBusOptions.dataPlaneEvidenceMs}; negative evidence is
   * retained until contradicted.
   *
   * A retained negative outcome returns `false` WITHOUT waiting for the
   * management probe (V8-1): the probe is started in the background, and only
   * when it settles `true` does it clear the outcome — so the NEXT read, not
   * this one, answers through the probe again. Awaiting it here was a race the
   * caller lost: the `messaging` indicator bounds this call with the same 2 s
   * the probe is bounded with, so a probe that could not reach the namespace
   * timed the indicator out first and the indicator reported `up`.
   *
   * With no authoritative evidence the management probe answers exactly as it
   * did before M95b: the probe delegates to the transport's `isHealthy?()` —
   * the real adapter reads the namespace through the administration client —
   * through the broker's own cached probe (5 s TTL, 2 s bound), so repeated
   * health polls cost at most one round trip per TTL and a hung transport
   * cannot hold a caller past the bound. `true`/`false` from the evidence or
   * the probe, `undefined` when neither has an answer (a minimal fake, an idle
   * broker) — the indicator then reports `reachable: 'unknown'`.
   *
   * @returns `true`/`false`/`undefined` as described
   * @since 0.1.0
   */
  async reachability(): Promise<boolean | undefined> {
    const evidence = this.#dataPlaneEvidence();
    if (evidence === true) {
      return evidence;
    }
    const probe = this.#probe;
    if (probe === null) {
      return evidence;
    }
    if (evidence === false) {
      this.#clearNegativeOutcomeInBackground(probe);
      return false;
    }
    return await probe();
  }

  /**
   * Starts the management probe without awaiting it, clearing the retained
   * negative outcome only if the probe answers `true`.
   *
   * The probe is the cached, coalesced one, so repeated reads during an
   * outage share one in-flight probe rather than stacking them, and it never
   * rejects. The clear is skipped when the probe is no longer current: a
   * `disconnect()` drops it, and every newly recorded failure rebuilds it —
   * so a late `true` can never erase a failure recorded after it started.
   */
  #clearNegativeOutcomeInBackground(probe: () => Promise<boolean | undefined>): void {
    void probe().then((reachable) => {
      if (reachable === true && this.#probe === probe) {
        this.#evidence = null;
      }
    });
  }

  /** Creates one bounded, cached management-plane probe from the current transport. */
  #createManagementProbe(): (() => Promise<boolean | undefined>) | null {
    const source = this.#probeSource;
    if (source === null) {
      return null;
    }
    return createCachedProbe<boolean | undefined>({
      probe: source,
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

  /**
   * Reads authoritative data-plane evidence. A negative result is retained
   * until a successful publish, a delivery or a positive management probe contradicts
   * it; elapsed time does not heal an outage. A positive result expires after
   * {@linkcode ServiceBusOptions.dataPlaneEvidenceMs}, then falls through to
   * the management probe.
   */
  #dataPlaneEvidence(): boolean | undefined {
    const recorded = this.#evidence;
    if (recorded === null) {
      return undefined;
    }
    if (!recorded.reachable) {
      return false;
    }
    // Strictly-within-the-window is authoritative — the same half-open
    // interval the management probe's TTL uses, so the two signals age on
    // one convention rather than disagreeing at the exact boundary.
    if (this.#runtime.hrtime() - recorded.at >= this.#evidenceMs) {
      this.#evidence = null;
      return undefined;
    }
    return true;
  }

  /**
   * Records a send outcome, a receive outage or a delivered message. Publish
   * failures before entering the transport carry no data-plane evidence.
   */
  #recordDataPlaneOutcome(reachable: boolean): void {
    this.#evidence = { at: this.#runtime.hrtime(), reachable };
    if (!reachable) {
      // A positive cached management answer from before the data-plane outage
      // cannot contradict the outage. Rebuild the cache so the next check
      // asks the management plane anew.
      this.#probe = this.#createManagementProbe();
    }
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

  publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void> {
    return this.publishWithHeaders(topic, message, {}, options);
  }

  /** Publishes a message with framework-owned transport headers. @internal */
  async publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
    options?: PublishOptions,
  ): Promise<void> {
    if (!this.#transport) {
      throw new Error('ServiceBusBroker is not connected');
    }
    const transport = this.#transport;
    const generation = this.#generation;
    const validated = await validatePublishOptions(options);
    if (generation !== this.#generation || transport !== this.#transport)
      throw new Error('ServiceBusBroker is not connected');
    const wireHeaders = buildTransportHeaders(validated, headers);
    const serialized = this.#serializer.serialize(message);
    try {
      await withDeadline(
        (signal) =>
          transport.send(topic, serialized, wireHeaders, validated.deduplicationId, {
            abortSignal: signal,
          }),
        {
          timeoutMs: this.#publishTimeoutMs,
          onTimeout: () =>
            new PublishTimeoutError(
              `Service Bus publish to ${JSON.stringify(topic)} exceeded ${this.#publishTimeoutMs}ms`,
              { topic, timeoutMs: this.#publishTimeoutMs },
            ),
          timing: resolveProbeTiming(this.#runtime),
        },
      );
    } catch (error) {
      // M95b: narrowed by ORIGIN — the guard and the serializer above threw
      // before the transport was reached and say nothing about the network;
      // only a send rejection is offered to the evidence predicate.
      if (error instanceof PublishTimeoutError || isServiceBusOutage(error)) {
        if (generation === this.#generation) this.#recordDataPlaneOutcome(false);
        if (!(error instanceof PublishTimeoutError))
          throw new BackendOutcomeUnknownError('messaging-plugin: service-bus publish', {
            cause: serviceBusPublishCause(error),
          });
      }
      throw error;
    }
    if (generation === this.#generation) this.#recordDataPlaneOutcome(true);
  }

  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    const independent = wantsFanOut(options);
    const transport = this.#transport;
    if (transport === null) throw new Error('ServiceBusBroker is not connected');
    const generation = this.#generation;
    const subscriptionId = this.#runtime.uuid();
    let queue = independent
      ? fanOutName(this.#defaultQueue, this.#runtime.uuid(), true)
      : (options?.queue ?? this.#defaultQueue);
    let ended = false;
    let created = false;
    let current: IServiceBusSubscription | undefined;
    const holds = new Set<() => Promise<void>>();
    let cancelInspection: (() => void) | undefined;
    const warnings = independent ? new Set<string>() : this.#warnings;
    const deleteCreated = async (): Promise<void> => {
      if (!created) return;
      created = false;
      // Best effort: the subscription also deletes itself after 5 idle minutes,
      // so a failed delete never stops the close.
      await transport.deleteSubscription(topic, queue).catch((error: unknown) => {
        this.#write(
          `Service Bus fan-out subscription ${JSON.stringify(queue)} was not deleted (${errorName(error)}); it is removed after 5 idle minutes`,
        );
      });
    };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing !== undefined) return closing;
      ended = true;
      cancelInspection?.();
      if (independent) warnings.clear();
      closing = (async () => {
        await Promise.all([...holds].map((cancel) => cancel()));
        try {
          await current?.close();
        } finally {
          await deleteCreated();
        }
      })().finally(() => {
        this.#subscriptions.delete(subscriptionId);
      });
      return closing;
    };
    this.#subscriptions.set(subscriptionId, { close });
    let budget = this.#retry.maxAttempts;
    const warnOnce = (kind: string, message: string): void => {
      const key = kind + ':' + topic + '/' + queue;
      if (warnings.has(key)) return;
      warnings.add(key);
      this.#write(message);
    };
    try {
      if (independent) {
        try {
          await transport.createSubscription(topic, queue, {
            autoDeleteOnIdleMs: SERVICE_BUS_MIN_AUTO_DELETE_ON_IDLE_MS,
          });
        } catch (error) {
          if (!(error instanceof SubscriptionNameExistsError)) throw error;
          if (ended || generation !== this.#generation)
            throw new Error('ServiceBusBroker disconnected while subscribing', { cause: error });
          queue = fanOutName(this.#defaultQueue, this.#runtime.uuid(), true);
          await transport.createSubscription(topic, queue, {
            autoDeleteOnIdleMs: SERVICE_BUS_MIN_AUTO_DELETE_ON_IDLE_MS,
          });
        }
        created = true;
      }
      if (ended || generation !== this.#generation) {
        await deleteCreated();
        throw new Error('ServiceBusBroker disconnected while subscribing');
      }
      if (this.#retry.retry && transport.getSubscription !== undefined) {
        try {
          const { maxDeliveryCount } = await withDeadline(
            () => transport.getSubscription!(topic, queue),
            {
              timeoutMs: 5000,
              onTimeout: () => new Error('Service Bus subscription inspection timed out'),
              timing: {
                setTimer: (fn, ms) => {
                  cancelInspection = fn;
                  return this.#runtime.setTimeout(fn, ms);
                },
                clearTimer: (handle) => {
                  this.#runtime.clearTimeout(handle);
                  cancelInspection = undefined;
                },
              },
            },
          );
          if (
            maxDeliveryCount !== undefined &&
            Number.isSafeInteger(maxDeliveryCount) &&
            maxDeliveryCount >= 1 &&
            maxDeliveryCount < budget
          ) {
            budget = maxDeliveryCount;
            warnOnce(
              'clamp',
              'Service Bus consumerRetry.maxAttempts clamped to subscription maxDeliveryCount',
            );
          }
        } catch {
          warnOnce(
            'budget',
            'Service Bus could not inspect subscription maxDeliveryCount; configured retry budget retained',
          );
        }
      }
      if (ended || generation !== this.#generation)
        throw new Error('ServiceBusBroker disconnected while subscribing');
      const sub = await transport.open(
        topic,
        queue,
        async (msg) => {
          if (ended) return;
          this.#recordDataPlaneOutcome(true);
          const receivedAt = this.#runtime.hrtime();
          let failed = false;
          let failure: unknown;
          try {
            await handler(this.#serializer.deserialize<T>(msg.payload), {
              topic,
              headers: msg.applicationProperties ?? {},
              ...(msg.messageId === undefined ? {} : { messageId: msg.messageId }),
              ...(msg.timestamp === undefined ? {} : { timestamp: msg.timestamp }),
            });
          } catch (error) {
            failed = true;
            failure = error;
          }
          if (ended) return;
          if (!failed) return msg.ack();
          this.#write('Service Bus handler failed', 'error');
          if (!this.#retry.retry) return msg.nack();
          const count = msg.deliveryCount;
          if (
            count === undefined ||
            !Number.isSafeInteger(count) ||
            count < 0 ||
            msg.deadLetter === undefined
          ) {
            warnOnce(
              'legacy',
              'Service Bus deliveryCount or deadLetter unavailable; abandoning without consumer retry policy',
            );
            return msg.nack();
          }
          let retryable = true;
          if (this.#retry.isRetryable !== undefined) {
            try {
              retryable = this.#retry.isRetryable(failure);
            } catch {
              this.#write('Service Bus retry classifier failed', 'error');
            }
          }
          const attempt = count + 1;
          if (!retryable || attempt >= budget)
            return msg.deadLetter(retryable ? 'setu-attempts-exhausted' : 'setu-not-retryable');
          const delay =
            this.#retry.delaysMs[Math.min(attempt - 1, this.#retry.delaysMs.length - 1)]!;
          if (300000 - (this.#runtime.hrtime() - receivedAt) - 60000 < delay) {
            warnOnce(
              'lock',
              'Service Bus retry delay exceeds remaining lock renewal budget; abandoning immediately',
            );
            return msg.nack();
          }
          const wait = new Promise<boolean>((resolve) => {
            const cancel = async (): Promise<void> => {
              this.#runtime.clearTimeout(timer);
              holds.delete(cancel);
              resolve(false);
              try {
                await msg.nack();
              } catch {
                /* Teardown abandons best effort before closing. */
              }
            };
            const timer: TimerHandle = this.#runtime.setTimeout(() => {
              holds.delete(cancel);
              resolve(true);
            }, delay);
            holds.add(cancel);
          });
          if (await wait) return msg.nack();
        },
        {
          maxConcurrentCalls: this.#maxConcurrentCalls,
          onReceiveError: (error, source) => {
            if (!ended && generation === this.#generation) this.#onReceiveError(error, source);
          },
        },
      );
      if (ended || generation !== this.#generation) {
        await sub.close();
        throw new Error('ServiceBusBroker disconnected while subscribing');
      }
      current = sub;
    } catch (error) {
      if (independent && !created && !(error instanceof SubscriptionNameExistsError))
        this.#write(
          unauthorized(error)
            ? 'Service Bus fanOut subscription creation was refused; the identity needs Manage rights'
            : `Service Bus fanOut subscription creation failed (${errorName(error)})`,
        );
      await close().catch(() => {});
      throw error;
    }
    return markFanOut({ unsubscribe: close }, independent);
  }

  #onReceiveError(error: unknown, source: string): void {
    if (source === 'receive' && isServiceBusOutage(error)) this.#recordDataPlaneOutcome(false);
  }

  #write(message: string, level: 'warn' | 'error' = 'warn'): void {
    try {
      const logger = this.#logger;
      (level === 'error' ? logger?.error : (logger?.warn ?? logger?.error))?.call(logger, message);
    } catch {
      /* Diagnostic sinks cannot affect message disposition. */
    }
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
