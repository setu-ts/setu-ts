import { MAX_ORDERING_KEYS, PubSubOrdering } from './pubsub-ordering.ts';
/**
 * GCP Pub/Sub broker implementation over {@linkcode IPubSubTransport}.
 *
 * Publishes to topics, subscribes through consumer-group subscriptions, and
 * supports request-reply via a shared reply topic with per-instance
 * subscriptions. Topics must pre-exist; the consumer-group subscription
 * ({@linkcode SubscribeOptions.queue}, default `<defaultQueue>.<topic ID>`) is
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
  PublishOptions,
  RequestHandler,
  RequestOptions,
  SubscribeOptions,
} from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import {
  createCachedProbe,
  OptionalDependencyUnavailableError,
  resolveProbeTiming,
  withDeadline,
} from '@setu-ts/common';
import { resolvePublishTimeoutMs } from './publish-timeout.ts';
import type { ISerializer } from '../serializers/serializer.ts';
import type { MessageBrokerAdapter } from './message-broker.ts';
import { describeError } from './describe-error.ts';
import type { ReplyInbox } from './inbox.ts';
import { buildTransportHeaders, validatePublishOptions } from './publish-options.ts';
import { RequestReplyCore } from './request-reply-core.ts';
import { assertNotCloudflareWorkers } from './cloud-gate.ts';
import {
  PubSubSubscriptionBoundElsewhereError,
  ReplyInboxUnavailableError,
  PublishTimeoutError,
  PubSubTopicMissingError,
} from '../errors.ts';
import { PubSubDeadLetterTopicMissingError } from '../errors.ts';
import { resolvePubSubRetry, type ResolvedConsumerRetry } from './consumer-retry.ts';
import type { ConsumerRetryOptions } from '../interfaces/index.ts';
import { fanOutName, markFanOut, wantsFanOut } from './fan-out.ts';
import type { TimerHandle } from '@setu-ts/common';

/** Optional Pub/Sub subscription creation policy. @since 0.14.0 */
export type PubSubCreateOptions = {
  /** Platform minimum and maximum retry backoff in milliseconds. @since 0.14.0 */
  readonly retryPolicy?: { readonly minimumBackoffMs: number; readonly maximumBackoffMs: number };
  /** Platform dead-letter topic and delivery budget. @since 0.14.0 */
  readonly deadLetterPolicy?: {
    readonly deadLetterTopic: string;
    readonly maxDeliveryAttempts: number;
  };
  /** Retention for an ephemeral consumer, in seconds. @since 0.14.0 */
  readonly messageRetentionSeconds?: number;
  /** Idle expiry for an ephemeral consumer, in seconds. @since 0.14.0 */
  readonly expirationTtlSeconds?: number;
};

/** Optional stream-close notification and create-only configuration. @since 0.14.0 */
export type PubSubOpenOptions = {
  /**
   * Reports an unexpected streaming-pull close.
   * @param error - Closure cause, used only for a fixed error-code diagnostic
   * @returns Nothing
   * @throws Never
   * @since 0.14.0
   */
  readonly onClosed?: (error: unknown) => void;
  /** Applied only when the subscription is created. @since 0.14.0 */
  readonly create?: PubSubCreateOptions;
};

type PubSubLogger = {
  error: (message: string) => void;
  /**
   * Reports configuration and stream warnings; absent falls back to error.
   * @param message - Value-free warning, with resource names or numeric codes only
   * @returns Nothing
   * @throws Never; diagnostic sink failures are swallowed
   * @since 0.14.0
   */
  warn?: (message: string) => void;
  /**
   * Reports an unavailable least-privilege inspection; absence drops the line.
   * @param message - Resource and required role, without remote error text
   * @returns Nothing
   * @throws Never; diagnostic sink failures are swallowed
   * @since 0.14.0
   */
  info?: (message: string) => void;
};
const PUBSUB_ATTACH_FAILED = Symbol('pubsub-attach-failed');
const PUBSUB_ORDERED = Symbol('pubsub-ordered');
const PUBSUB_PROJECT = Symbol('pubsub-project');

type PubSubMessage = Parameters<Parameters<IPubSubTransport['open']>[2]>[0];

type ActivePubSubSubscription = {
  close(): Promise<void>;
  closed: boolean;
};

function errorCode(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'number' && Number.isInteger(code) ? String(code) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Default reply topic for request-reply. */
const DEFAULT_REPLY_TOPIC = 'messaging.replies';

/** Default consumer-group subscription-name PREFIX (M101b: `<prefix>.<topic>`). */
const DEFAULT_QUEUE = 'messaging-consumers';

/** The service's subscription-ID length cap (Pub/Sub resource-naming rules). */
const MAX_SUBSCRIPTION_NAME_LENGTH = 255;

/** gRPC `ALREADY_EXISTS`. */
const GRPC_ALREADY_EXISTS = 6;
const PUBSUB_ADMIN_READ_TIMEOUT_MS = 1500;

/**
 * Derives the default subscription for a topic: `<defaultQueue>.<topic ID>`
 * (M101b, V8-2).
 *
 * Pub/Sub subscription names are project-global, so one shared default meant
 * a second topic attached to the first topic's subscription. `.` joins (the
 * package's own `rr.req.` convention; Kafka's `:` is illegal in a Pub/Sub ID).
 * Pub/Sub reserves no character, so the parts are NOT recoverable by splitting.
 *
 * The topic's ID is used, never the name as given: a caller may name the
 * topic fully qualified (`projects/p/topics/orders`), and `/` is illegal in a
 * subscription ID — the service answers `INVALID_ARGUMENT` (measured on the
 * emulator), where the pre-M101b fixed default was accepted.
 *
 * @param defaultQueue - The configured prefix
 * @param topic - The subscribed topic, short or fully qualified
 * @returns The per-topic subscription name
 */
function deriveDefaultSubscription(defaultQueue: string, topic: string): string {
  const marker = topic.lastIndexOf('/topics/');
  const topicId =
    topic.startsWith('projects/') && marker !== -1
      ? topic.slice(marker + '/topics/'.length)
      : topic;
  return `${defaultQueue}.${topicId}`;
}

/**
 * Reports whether the fully-qualified topic the service says a subscription is
 * bound to is the topic the caller asked for. The caller may name a topic
 * either short (`orders`, meaning THIS project's) or fully qualified
 * (`projects/p/topics/orders`). Compared exactly: Pub/Sub allows cross-project
 * subscriptions, so a `/topics/orders` suffix alone would accept a subscription
 * bound to another project's same-named topic.
 */
function isSameTopic(boundTopic: string, requestedTopic: string, projectId: string): boolean {
  const expected = requestedTopic.startsWith('projects/')
    ? requestedTopic
    : `projects/${projectId}/topics/${requestedTopic}`;
  return boundTopic === expected;
}

/**
 * Declares the constructors used from the real GCP Pub/Sub SDK so the adapter
 * can build a domain port. This is NOT an SDK-shaped structural facade — it
 * names only what the adapter actually uses.
 */
export interface PubSubSdkModule {
  PubSub: new (options: { projectId: string; credentials?: unknown }) => {
    /** Bounded metadata round trip, with retries disabled. */
    getTopics(options: {
      pageSize: number;
      autoPaginate: false;
      gaxOpts: { timeout: number; retry: null };
    }): Promise<unknown>;
    topic(
      topicName: string,
      options?: { messageOrdering?: boolean },
    ): {
      /** Fully qualified SDK resource name. @since 0.14.0 */
      readonly name?: string;
      /**
       * Reads topic existence without listing subscriptions.
       * @returns Existence tuple
       * @throws On authorization or transport failure
       * @since 0.14.0
       */
      exists?(): Promise<[boolean, ...unknown[]]>;
      /**
       * Reads topic metadata under a finite admin-call bound.
       * @param options - Timeout and disabled retry policy
       * @returns SDK metadata tuple
       * @throws On missing topic, authorization or transport failure
       * @since 0.14.0
       */
      getMetadata?(options: { timeout: number; retry: null }): Promise<unknown[]>;
      /**
       * Lists at most one topic subscription.
       * @param options - Pagination bound
       * @returns Subscription tuple
       * @throws On authorization or transport failure
       * @since 0.14.0
       */
      getSubscriptions?(options: {
        pageSize: number;
        autoPaginate: false;
      }): Promise<[unknown[], ...unknown[]]>;
      publishMessage(message: {
        data: Uint8Array;
        attributes?: Record<string, string>;
        orderingKey?: string;
      }): Promise<string>;
      createSubscription(
        subscriptionName: string,
        options?: {
          enableMessageOrdering?: boolean;
          retryPolicy?: {
            minimumBackoff: { seconds: number; nanos: number };
            maximumBackoff: { seconds: number; nanos: number };
          };
          deadLetterPolicy?: { deadLetterTopic: string; maxDeliveryAttempts: number };
          messageRetentionDuration?: { seconds: number };
          expirationPolicy?: { ttl: { seconds: number } };
        },
      ): Promise<unknown[]>;
      /**
       * Resumes a paused ordering key (M106 §3.5). The SDK pauses a key after a
       * failed ORDERED publish and refuses further publishes for it until this
       * is called. Optional so a hand-built module double that does not
       * model ordering still satisfies this type; the real SDK has it.
       */
      resumePublishing?(orderingKey: string): void;
    };
    subscription(subscriptionName: string): {
      on(
        event: 'message',
        handler: (msg: {
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
          /** Native ordering key. @since 0.14.0 */
          orderingKey?: string;
        }) => void,
      ): void;
      on(event: 'error', handler: (err: unknown) => void): void;
      /**
       * Observes an unexpectedly ended streaming pull.
       * @param event - The close event
       * @param handler - Closure notification
       * @returns Nothing
       * @throws Never
       * @since 0.14.0
       */
      on(event: 'close', handler: (err: unknown) => void): void;
      /**
       * Removes only this adapter's listeners when supported by an injected module.
       * @param event - Listener event
       * @param handler - Registered callback
       * @returns Nothing
       * @throws Never
       * @since 0.14.0
       */
      off?(event: string, handler: (...args: never[]) => void): unknown;
      close(): Promise<void>;
      delete(): Promise<void>;
      /**
       * Reads the subscription's metadata (M101b). The SDK resolves a tuple
       * whose first element is the `google.pubsub.v1.ISubscription`; only its
       * fully-qualified `topic` is read, to refuse attaching to a subscription
       * that is bound to another topic.
       */
      getMetadata(): Promise<
        [
          {
            topic?: string | null;
            retryPolicy?: {
              minimumBackoff?: { seconds?: number | string | null; nanos?: number | null } | null;
              maximumBackoff?: { seconds?: number | string | null; nanos?: number | null } | null;
            } | null;
            deadLetterPolicy?: {
              deadLetterTopic?: string | null;
              maxDeliveryAttempts?: number | null;
            } | null;
          },
          ...unknown[],
        ]
      >;
    };
    close(): Promise<void>;
  };
}

/**
 * Domain port for GCP Pub/Sub operations. The broker depends on this, not the
 * SDK directly.
 */
export interface IPubSubTransport {
  /**
   * Publish bytes to a topic.
   *
   * @param orderingKey - Native Pub/Sub ordering key (M106 §3.3); omitted means
   *   unordered
   */
  publish(
    topic: string,
    bytes: Uint8Array,
    attributes?: Readonly<Record<string, string>>,
    orderingKey?: string,
  ): Promise<void>;
  /**
   * Open a subscription on a topic. Creates the subscription when absent.
   * @param onMessage - Called per delivered message
   */
  open(
    topic: string,
    subscription: string,
    onMessage: (msg: {
      payload: string;
      /** Original wire bytes for a lossless terminal forward. @since 0.14.0 */
      bytes?: Uint8Array;
      ack: () => void;
      nack: () => void;
      attributes?: Readonly<Record<string, string>>;
      /** The platform-assigned message id, when the transport carried one (X28-4). */
      messageId?: string;
      /** The platform-assigned publish time, when the transport carried one (X28-4). */
      timestamp?: Date;
      /** Native ordering key. @since 0.14.0 */
      orderingKey?: string;
    }) => void,
    options?: PubSubOpenOptions,
  ): Promise<IPubSubSubscription>;
  /** Explicitly create a subscription (for RPC inbox). */
  createSubscription(
    topic: string,
    subscription: string,
    options?: PubSubCreateOptions,
  ): Promise<void>;
  /**
   * Inspects a policy target after subscription creation fails.
   * @param topic - Dead-letter topic
   * @returns Whether the topic exists
   * @throws On authorization or transport failure
   * @since 0.14.0
   */
  topicExists?(topic: string): Promise<boolean>;
  /**
   * Inspects retention of newly created dead-letter traffic.
   * @param topic - Dead-letter topic
   * @returns Whether at least one subscription exists
   * @throws On authorization or transport failure
   * @since 0.14.0
   */
  topicHasSubscriptions?(topic: string): Promise<boolean>;
  /** Delete a subscription (for RPC inbox teardown). */
  deleteSubscription(subscription: string): Promise<void>;
  /** Close the client and all subscriptions. */
  close(): Promise<void>;
  /**
   * Reports whether the Pub/Sub backend is reachable (optional, M70c).
   *
   * The real adapter calls getTopics (pageSize 1, no pagination, 1500 ms,
   * no retries): resolved → true, gRPC 14 → false, gRPC 4 → undefined,
   * other numeric codes (including permission/auth failures) → true,
   * no numeric code → false. A transport without a probe reports unknown.
   * Unexpected streaming-pull closure is separately recovered by the broker.
   */
  isHealthy?(): Promise<boolean | undefined>;
}

/** Handle for an open Pub/Sub subscription. */
export interface IPubSubSubscription {
  /** True for creation, false for attachment; unset is treated as attachment. @since 0.14.0 */
  readonly created?: boolean;
  /** Existing policies on attachment; not rewritten by the broker. @since 0.14.0 */
  readonly existing?: Pick<PubSubCreateOptions, 'retryPolicy' | 'deadLetterPolicy'>;
  /** Close the subscription. */
  close(): Promise<void>;
}

/**
 * Options for GCP Pub/Sub broker.
 */
export interface PubSubOptions {
  /** Consumer retry defaults to platform backoff; false restores immediate nack. @since 0.14.0 */
  consumerRetry?: false | ConsumerRetryOptions;
  /** Pre-existing topic receiving exhausted or non-retryable messages. @since 0.14.0 */
  deadLetterTopic?: string;
  /** Publish bound in ms, default 15000; 0 disables it except terminal dead-letter forwards (always 15000). A timeout may still deliver. @since 0.10.0 */
  publishTimeoutMs?: number;
  /** GCP project ID. Required unless {@link client} is injected. */
  projectId?: string;
  /** Service-account credentials (object or key path). SDK ADC is used when omitted. */
  credentials?: unknown;
  /** Injected transport (bypasses lazy SDK load). */
  client?: IPubSubTransport;
  /**
   * Default consumer-group subscription-name PREFIX (default
   * `'messaging-consumers'`). A subscription with no
   * {@linkcode SubscribeOptions.queue} uses `<defaultQueue>.<topic ID>`, one
   * subscription per topic, because Pub/Sub subscription names are
   * project-global (M101b).
   */
  defaultQueue?: string;
  /** Shared reply topic for request-reply (must pre-exist). */
  replyTopic?: string;
  /**
   * Create the transport's own subscriptions with message ordering enabled
   * (default `false`), required before a native `orderingKey` is delivered in
   * order. Fixed at subscription creation and it costs throughput, so it is
   * opt-in (M106 §3.5). Refused together with {@link client}: an injected
   * transport creates its own subscriptions, so pass the flag to
   * `adaptPubSubModule` instead.
   */
  enableMessageOrdering?: boolean;
  /** Optional logger. */
  logger?: PubSubLogger;
}

/**
 * Lazily load the GCP Pub/Sub SDK.
 *
 * @returns The SDK module
 * @throws {Error} If the package cannot be resolved
 */
export async function loadPubSubModule(): Promise<PubSubSdkModule> {
  try {
    return (await import('@google-cloud/pubsub')) as unknown as PubSubSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@google-cloud/pubsub', {
      requiredBy: '@setu-ts/messaging-plugin',
      cause: error,
    });
  }
}

/** Most `Topic` handles {@linkcode adaptPubSubModule} keeps while idle (M106 audit L3). */
const MAX_CACHED_TOPICS = 1024;

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
    logger?: PubSubLogger | undefined;
    enableMessageOrdering?: boolean | undefined;
  },
): IPubSubTransport {
  const pubsub = new mod.PubSub({ projectId: options.projectId, credentials: options.credentials });
  const duration = (ms: number): { seconds: number; nanos: number } => ({
    seconds: Math.floor(ms / 1000),
    nanos: (ms % 1000) * 1_000_000,
  });
  const createOptions = (create: PubSubCreateOptions = {}) => {
    resolvePubSubRetry({
      consumerRetry: {
        ...(create.retryPolicy === undefined
          ? {}
          : {
              delaysMs: [create.retryPolicy.minimumBackoffMs, create.retryPolicy.maximumBackoffMs],
            }),
        ...(create.deadLetterPolicy === undefined
          ? {}
          : { maxAttempts: create.deadLetterPolicy.maxDeliveryAttempts }),
      },
      ...(create.deadLetterPolicy === undefined
        ? {}
        : { deadLetterTopic: create.deadLetterPolicy.deadLetterTopic }),
    });
    for (const [name, value] of [
      ['messageRetentionSeconds', create.messageRetentionSeconds],
      ['expirationTtlSeconds', create.expirationTtlSeconds],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new RangeError(`Pub/Sub ${name} must be a positive integer`);
    }
    return {
      ...(options.enableMessageOrdering ? { enableMessageOrdering: true } : {}),
      ...(create.retryPolicy === undefined
        ? {}
        : {
            retryPolicy: {
              minimumBackoff: duration(create.retryPolicy.minimumBackoffMs),
              maximumBackoff: duration(create.retryPolicy.maximumBackoffMs),
            },
          }),
      ...(create.deadLetterPolicy === undefined
        ? {}
        : {
            deadLetterPolicy: {
              ...create.deadLetterPolicy,
              deadLetterTopic:
                pubsub.topic(create.deadLetterPolicy.deadLetterTopic).name ??
                (create.deadLetterPolicy.deadLetterTopic.startsWith('projects/')
                  ? create.deadLetterPolicy.deadLetterTopic
                  : `projects/${options.projectId}/topics/${create.deadLetterPolicy.deadLetterTopic}`),
            },
          }),
      ...(create.messageRetentionSeconds === undefined
        ? {}
        : { messageRetentionDuration: { seconds: create.messageRetentionSeconds } }),
      ...(create.expirationTtlSeconds === undefined
        ? {}
        : { expirationPolicy: { ttl: { seconds: create.expirationTtlSeconds } } }),
    };
  };
  const milliseconds = (
    value: { seconds?: number | string | null; nanos?: number | null } | null | undefined,
  ): number => {
    const seconds = Number(value?.seconds ?? 0);
    const nanos = value?.nanos ?? 0;
    return Number.isInteger(seconds) && Number.isInteger(nanos)
      ? seconds * 1000 + nanos / 1_000_000
      : NaN;
  };

  // M106 §3.5: the SDK keeps its ordered queue per `Topic` OBJECT, so one cached
  // Topic per name is required — building a fresh Topic per publish lets
  // concurrent publishes for one key race.
  //
  // The cache is bounded (M106 audit L3), least-recently-used first, and evicts
  // only a handle with NOTHING in flight: every earlier publish on it has
  // settled, so the next one on a fresh handle cannot overtake it. When every
  // handle is busy the cache runs over the bound until one settles, so it is
  // bounded by the topics in use at once rather than the topics ever named.
  //
  // `idle` holds exactly the cached names with nothing in flight, in recency
  // order (a Map iterates in insertion order), so eviction takes the oldest
  // idle name in O(1) and never walks the busy ones — the busy set is bounded
  // only by the application's concurrency (PR #427 review).
  const topics = new Map<string, { handle: ReturnType<typeof pubsub.topic>; inFlight: number }>();
  const idle = new Set<string>();
  const evictIdle = (): void => {
    for (const name of idle) {
      if (topics.size <= MAX_CACHED_TOPICS) return;
      idle.delete(name);
      topics.delete(name);
    }
  };

  const transport: IPubSubTransport & {
    readonly [PUBSUB_ORDERED]: boolean;
    readonly [PUBSUB_PROJECT]: string;
  } = {
    [PUBSUB_ORDERED]: options.enableMessageOrdering ?? false,
    [PUBSUB_PROJECT]: options.projectId,
    isHealthy: async (): Promise<boolean | undefined> => {
      try {
        await pubsub.getTopics({
          pageSize: 1,
          autoPaginate: false,
          gaxOpts: { timeout: PUBSUB_ADMIN_READ_TIMEOUT_MS, retry: null },
        });
        return true;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 14) return false;
        if (code === 4) return undefined;
        return typeof code === 'number';
      }
    },
    publish: async (
      topic: string,
      bytes: Uint8Array,
      attributes?: Readonly<Record<string, string>>,
      orderingKey?: string,
    ): Promise<void> => {
      let entry = topics.get(topic);
      if (entry === undefined) {
        entry = { handle: pubsub.topic(topic, { messageOrdering: true }), inFlight: 0 };
        topics.set(topic, entry);
      }
      idle.delete(topic); // busy now; re-enters `idle` as most recent once settled
      const { handle } = entry;
      const message = {
        data: bytes,
        ...(attributes ? { attributes: { ...attributes } } : {}),
        ...(orderingKey !== undefined ? { orderingKey } : {}),
      };
      entry.inFlight++;
      try {
        await handle.publishMessage(message);
      } catch (error) {
        // The SDK pauses an ordering key after a failed ORDERED publish and
        // refuses further publishes for it until `resumePublishing`; without
        // this one transient failure blocks that key for the process lifetime.
        if (orderingKey !== undefined) {
          handle.resumePublishing?.(orderingKey);
        }
        throw error;
      } finally {
        entry.inFlight--;
        if (entry.inFlight === 0) idle.add(topic);
        evictIdle();
      }
    },
    open: async (
      topic: string,
      subscription: string,
      onMessage: Parameters<IPubSubTransport['open']>[2],
      openOptions?: PubSubOpenOptions,
    ): Promise<IPubSubSubscription> => {
      const sub = pubsub.subscription(subscription);

      let created = true;
      let existing: IPubSubSubscription['existing'];
      try {
        const settings = createOptions(openOptions?.create);
        await pubsub
          .topic(topic)
          .createSubscription(
            subscription,
            Object.keys(settings).length === 0 ? undefined : settings,
          );
      } catch (error) {
        if (errorCode(error) !== String(GRPC_ALREADY_EXISTS)) throw error;
        created = false;
        try {
          const [metadata] = await sub.getMetadata();
          const boundTopic = metadata.topic ?? '';
          if (!isSameTopic(boundTopic, topic, options.projectId))
            throw new PubSubSubscriptionBoundElsewhereError(
              subscription,
              boundTopic === '' ? '(unknown)' : boundTopic,
              topic,
            );
          existing = {
            ...(metadata.retryPolicy == null
              ? {}
              : {
                  retryPolicy: {
                    minimumBackoffMs: milliseconds(metadata.retryPolicy.minimumBackoff),
                    maximumBackoffMs: milliseconds(metadata.retryPolicy.maximumBackoff),
                  },
                }),
            ...(metadata.deadLetterPolicy == null
              ? {}
              : {
                  deadLetterPolicy: {
                    deadLetterTopic: metadata.deadLetterPolicy.deadLetterTopic ?? '',
                    maxDeliveryAttempts: metadata.deadLetterPolicy.maxDeliveryAttempts ?? 0,
                  },
                }),
          };
        } catch (attachError) {
          (
            openOptions as
              (PubSubOpenOptions & { readonly [PUBSUB_ATTACH_FAILED]?: () => void }) | undefined
          )?.[PUBSUB_ATTACH_FAILED]?.();
          throw attachError;
        }
      }
      let ownClose = false;
      const onError = (error: unknown): void =>
        options.logger?.error(`Pub/Sub subscription error (code ${errorCode(error)})`);
      const onClosed = (error: unknown): void => {
        if (!ownClose) openOptions?.onClosed?.(error);
      };
      sub.on('error', onError);
      sub.on('close', onClosed);

      const onRaw = (raw: {
        data: Uint8Array;
        ack(): void;
        nack(): void;
        id: string;
        publishTime?: Date;
        attributes?: Record<string, string>;
        orderingKey?: string;
      }): void => {
        const text = new TextDecoder().decode(raw.data);
        // X28-4: the platform assigns both fields, so the adapter reads them
        // rather than dropping them. Omitted — never assigned `undefined` —
        // when the transport carries none, so `'messageId' in metadata`
        // separates "no id" from "did not look".
        onMessage({
          payload: text,
          bytes: raw.data,
          ack: () => raw.ack(),
          nack: () => raw.nack(),
          attributes: raw.attributes ?? {},
          ...(raw.orderingKey === undefined ? {} : { orderingKey: raw.orderingKey }),
          ...(raw.id !== undefined && raw.id !== '' ? { messageId: raw.id } : {}),
          ...(raw.publishTime !== undefined ? { timestamp: new Date(raw.publishTime) } : {}),
        });
      };
      sub.on('message', onRaw);

      return {
        created,
        ...(existing === undefined ? {} : { existing }),
        close: async () => {
          ownClose = true;
          try {
            await sub.close();
          } finally {
            sub.off?.('message', onRaw);
            sub.off?.('error', onError);
            sub.off?.('close', onClosed);
          }
        },
      };
    },
    topicExists: async (topic) => {
      const handle = pubsub.topic(topic);
      if (handle.getMetadata === undefined)
        throw new TypeError('Pub/Sub topic.getMetadata is unavailable');
      try {
        await handle.getMetadata({ timeout: PUBSUB_ADMIN_READ_TIMEOUT_MS, retry: null });
        return true;
      } catch (error) {
        if (errorCode(error) === '5') return false;
        throw error;
      }
    },
    topicHasSubscriptions: async (topic) => {
      const handle = pubsub.topic(topic);
      if (handle.getSubscriptions === undefined)
        throw new TypeError('Pub/Sub topic.getSubscriptions is unavailable');
      const [subscriptions] = await handle.getSubscriptions({ pageSize: 1, autoPaginate: false });
      return subscriptions.length > 0;
    },
    createSubscription: async (
      topic: string,
      subscription: string,
      create?: PubSubCreateOptions,
    ): Promise<void> => {
      const settings = createOptions(create);
      await pubsub
        .topic(topic)
        .createSubscription(
          subscription,
          Object.keys(settings).length === 0 ? undefined : settings,
        );
    },
    deleteSubscription: async (subscription: string): Promise<void> => {
      const sub = pubsub.subscription(subscription);
      try {
        await sub.delete();
      } catch (error) {
        if (errorCode(error) !== '5') throw error;
      }
    },
    close: async () => {
      await pubsub.close();
    },
  };
  return transport;
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
  #enableMessageOrdering: boolean;
  #logger: PubSubLogger | undefined;
  readonly #retry: ResolvedConsumerRetry;
  readonly #deadLetterTopic: string | undefined;
  readonly #warnings = new Set<string>();
  #generation = 0;
  #transport: IPubSubTransport | null = null;
  #ready = false;
  #subscriptions: Map<string, ActivePubSubSubscription>;
  #rr: RequestReplyCore;
  #publishTimeoutMs: number;
  #probe: (() => Promise<boolean | undefined>) | null = null;

  constructor(runtime: IRuntimeServices, serializer: ISerializer, options?: PubSubOptions) {
    this.#retry = resolvePubSubRetry(options);
    this.#deadLetterTopic = options?.deadLetterTopic;
    this.#publishTimeoutMs = resolvePublishTimeoutMs(options?.publishTimeoutMs);
    this.#runtime = runtime;
    this.#serializer = serializer;
    // Empty is a sentinel for "not supplied", checked in connect(). The plugin's
    // option union already makes a credential-less `'pubsub'` arm a compile
    // error, but this class is exported for standalone construction, where the
    // type system is not in the way — and `new PubSub({ projectId: '' })` fails
    // later with an SDK message that names neither the option nor this broker.
    this.#projectId =
      options?.projectId ??
      (
        options?.client as (IPubSubTransport & { readonly [PUBSUB_PROJECT]?: string }) | undefined
      )?.[PUBSUB_PROJECT] ??
      '';
    this.#credentials = options?.credentials;
    this.#injectedClient = options?.client;
    if (this.#injectedClient !== undefined && options?.enableMessageOrdering !== undefined) {
      // Ordering is fixed when a subscription is created, and an injected
      // transport creates its own — accepting the flag would do nothing.
      throw new RangeError(
        'GcpPubSubBroker: `enableMessageOrdering` has no effect with an injected `client`. ' +
          'Pass it to `adaptPubSubModule` when building the transport instead.',
      );
    }
    this.#defaultQueue = options?.defaultQueue ?? DEFAULT_QUEUE;
    this.#replyTopic = options?.replyTopic ?? DEFAULT_REPLY_TOPIC;
    this.#enableMessageOrdering =
      options?.enableMessageOrdering ??
      (
        options?.client as (IPubSubTransport & { readonly [PUBSUB_ORDERED]?: boolean }) | undefined
      )?.[PUBSUB_ORDERED] ??
      false;
    this.#logger = options?.logger;
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

    assertNotCloudflareWorkers(this.#runtime, 'GCP Pub/Sub', '@google-cloud/pubsub');

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
        enableMessageOrdering: this.#enableMessageOrdering,
      });
    }

    const transport = this.#transport;
    if (typeof transport.isHealthy === 'function') {
      this.#probe = createCachedProbe<boolean | undefined>({
        probe: () => transport.isHealthy!(),
        fallback: undefined,
        ttlMs: 5000,
        timeoutMs: 2000,
        ...resolveProbeTiming(this.#runtime),
      });
    }
    this.#ready = true;
    if (this.#retry.retry && this.#deadLetterTopic === undefined)
      this.#warnOnce(
        'unlimited',
        'Pub/Sub failing messages are redelivered without limit until deadLetterTopic is set',
      );
    if (!this.#retry.retry && this.#deadLetterTopic !== undefined)
      this.#warnOnce(
        'dead-letter-unused',
        'Pub/Sub deadLetterTopic is ignored because consumerRetry is false',
      );
    if (this.#enableMessageOrdering && this.#deadLetterTopic !== undefined)
      this.#warnOnce(
        'ordered-dead-letter',
        'Pub/Sub later messages of a failing ordering key also spend delivery attempts and may be dead-lettered; they are held back until any held-back message of that key is redelivered; a later message can run while the failed one still awaits redelivery; order is best effort, including before dead-lettering',
      );
  }

  async disconnect(): Promise<void> {
    this.#generation++;
    this.#probe = null;
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
    }
    this.#ready = false;
    const failed = closes.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Tri-state backend reachability (M70c).
   *
   * An unexpectedly closed stream reports unreachable until re-opened.
   * The transport's isHealthy round trip is cached
   * for 5 s and bounded at 2 s. The real adapter uses getTopics: gRPC 14 →
   * false, 4 → undefined, other numeric codes → true, no code → false.
   * An expired bound or an absent transport probe means unknown reachability.
   *
   * @returns `true`/`false`/`undefined` as described
   * @since 0.1.0
   */
  reachability(): Promise<boolean | undefined> {
    if ([...this.#subscriptions.values()].some((subscription) => subscription.closed))
      return Promise.resolve(false);
    return this.#probe?.() ?? Promise.resolve(undefined);
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

  /**
   * Publishes a payload under the configured acknowledgement bound.
   * @param topic - Destination topic
   * @param message - Payload to serialize
   * @param options - Caller headers, ordering key and de-duplication id
   * @returns Resolves when Pub/Sub acknowledges the publish
   * @throws {PublishTimeoutError} When publishTimeoutMs expires; delivery remains possible
   * @since 0.1.0
   */
  publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void> {
    return this.publishWithHeaders(topic, message, {}, options);
  }

  /**
   * Publishes with framework-owned headers under the configured acknowledgement bound.
   * @param topic - Destination topic
   * @param message - Payload to serialize
   * @param headers - Framework-owned transport headers
   * @param options - Caller headers, ordering key and de-duplication id
   * @returns Resolves when the transport acknowledges the publish
   * @throws {PublishTimeoutError} When publishTimeoutMs expires; delivery remains possible
   * @internal
   */
  async publishWithHeaders<T>(
    topic: string,
    message: T,
    headers: Readonly<Record<string, string>>,
    options?: PublishOptions,
  ): Promise<void> {
    if (!this.#transport) {
      throw new Error('GcpPubSubBroker is not connected');
    }
    const validated = await validatePublishOptions(options);
    const wireHeaders = buildTransportHeaders(validated, headers);
    const serialized = this.#serializer.serialize(message);
    const bytes = new TextEncoder().encode(serialized);
    const transport = this.#transport;
    await withDeadline(() => transport.publish(topic, bytes, wireHeaders, validated.orderingKey), {
      timeoutMs: this.#publishTimeoutMs,
      onTimeout: () =>
        new PublishTimeoutError(
          `Pub/Sub did not acknowledge the message published to ${JSON.stringify(topic)} within ${this.#publishTimeoutMs} ms (publishTimeoutMs); it may still be delivered`,
          { topic, timeoutMs: this.#publishTimeoutMs },
        ),
      timing: resolveProbeTiming(this.#runtime),
    });
  }

  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<ISubscription> {
    const independent = wantsFanOut(options);
    const transport = this.#transport;
    if (transport === null) throw new Error('GcpPubSubBroker is not connected');
    const generation = this.#generation;
    const queue = independent
      ? fanOutName(this.#defaultQueue, this.#runtime.uuid())
      : (options?.queue ?? deriveDefaultSubscription(this.#defaultQueue, topic));
    if (queue.length > MAX_SUBSCRIPTION_NAME_LENGTH)
      throw new Error(
        `Pub/Sub subscription name for topic ${JSON.stringify(topic)} is ${queue.length} characters; the service allows at most ${MAX_SUBSCRIPTION_NAME_LENGTH}. Pass a shorter SubscribeOptions.queue.`,
      );
    const subscriptionId = this.#runtime.uuid();
    const create: PubSubCreateOptions = {
      ...(this.#retry.retry
        ? {
            retryPolicy: {
              minimumBackoffMs: this.#retry.delaysMs[0]!,
              maximumBackoffMs: this.#retry.delaysMs[this.#retry.delaysMs.length - 1]!,
            },
          }
        : {}),
      ...(independent
        ? { messageRetentionSeconds: 600, expirationTtlSeconds: 86400 }
        : this.#retry.retry && this.#deadLetterTopic !== undefined
          ? {
              deadLetterPolicy: {
                deadLetterTopic: this.#deadLetterTopic,
                maxDeliveryAttempts: this.#retry.maxAttempts,
              },
            }
          : {}),
    };
    const ordering = this.#enableMessageOrdering
      ? new PubSubOrdering(
          () => this.#runtime.hrtime(),
          () =>
            this.#warnOnce(
              'ordering-evicted:' + queue,
              `Pub/Sub subscription ${JSON.stringify(queue)} holds ${MAX_ORDERING_KEYS} ordering keys; the least recently used was forgotten while its failed message may still be redelivered, so later messages of that key can run out of order`,
            ),
        )
      : undefined;
    let streamGeneration = 0;
    let ended = false;
    let current: IPubSubSubscription | undefined;
    let opened = false;
    let closing: Promise<void> | undefined;
    let timer: TimerHandle | undefined;
    let failures = 0;
    let reopening = false;
    const checks = new Map<TimerHandle, () => void>();
    const timing = {
      hrtime: () => this.#runtime.hrtime(),
      setTimer: (fn: () => void, ms: number): TimerHandle => {
        const handle = this.#runtime.setTimeout(fn, ms);
        checks.set(handle, fn);
        return handle;
      },
      clearTimer: (handle: TimerHandle): void => {
        this.#runtime.clearTimeout(handle);
        checks.delete(handle);
      },
    };
    const state: ActivePubSubSubscription = {
      closed: false,
      close: () => {
        if (closing !== undefined) return closing;
        ended = true;
        for (const cancel of checks.values()) cancel();
        ordering?.clear();
        streamGeneration++;
        if (timer !== undefined) this.#runtime.clearTimeout(timer);
        closing = (async () => {
          try {
            await current?.close();
          } finally {
            // Best effort: a fan-out subscription also expires on its own after
            // one idle day, so a failed delete never stops the close.
            if (independent && opened)
              await transport.deleteSubscription(queue).catch((error: unknown) => {
                this.#write(
                  `Pub/Sub fan-out subscription ${JSON.stringify(queue)} was not deleted (code ${errorCode(error)}); it expires after one idle day`,
                );
              });
          }
        })().finally(() => {
          this.#subscriptions.delete(subscriptionId);
        });
        return closing;
      },
    };
    const dispatch = async (msg: PubSubMessage, deliveryGeneration: number): Promise<boolean> => {
      if (ended || deliveryGeneration !== streamGeneration) return true;
      let failed = false;
      let failure: unknown;
      try {
        await handler(this.#serializer.deserialize<T>(msg.payload), {
          topic,
          headers: msg.attributes ?? {},
          ...(msg.messageId === undefined ? {} : { messageId: msg.messageId }),
          ...(msg.timestamp === undefined ? {} : { timestamp: msg.timestamp }),
        });
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (ended || deliveryGeneration !== streamGeneration) return true;
      if (!failed) {
        msg.ack();
        return true;
      }
      this.#write('Pub/Sub handler failed', 'error');
      let retryable = true;
      if (this.#retry.retry && this.#retry.isRetryable !== undefined) {
        try {
          retryable = this.#retry.isRetryable(failure);
        } catch {
          this.#write('Pub/Sub retry classifier failed', 'error');
        }
      }
      if (!independent && !retryable && this.#deadLetterTopic !== undefined) {
        const deadLetterTopic = this.#deadLetterTopic;
        try {
          // Terminal forwards always have a finite 15 s bound, including when
          // ordinary publishing is unbounded, so a stalled send releases the key.
          await withDeadline(
            () =>
              transport.publish(
                deadLetterTopic,
                msg.bytes ?? new TextEncoder().encode(msg.payload),
                { ...msg.attributes, 'setu-dead-letter-reason': 'not-retryable' },
              ),
            {
              timeoutMs: 15000,
              onTimeout: () =>
                new PublishTimeoutError(
                  `Pub/Sub dead-letter forward to ${JSON.stringify(deadLetterTopic)} timed out`,
                  { topic: deadLetterTopic, timeoutMs: 15000 },
                ),
              timing,
            },
          );
        } catch {
          if (!ended && deliveryGeneration === streamGeneration) msg.nack();
          return false;
        }
        if (!ended && deliveryGeneration === streamGeneration) msg.ack();
        return true;
      } else msg.nack();
      return false;
    };
    const schedule = (): void => {
      if (ended || reopening || timer !== undefined) return;
      const delay = [1000, 2000, 5000, 10000, 30000][Math.min(failures++, 4)]!;
      timer = this.#runtime.setTimeout(() => {
        timer = undefined;
        void reopen();
      }, delay);
    };
    const onClosed = (): void => {
      if (ended) return;
      const alreadyClosed = state.closed;
      state.closed = true;
      streamGeneration++;
      ordering?.clear();
      if (!alreadyClosed) this.#write('Pub/Sub subscription stream closed; re-opening');
      // Initial setup owns its handle until it commits or disposes it. Starting
      // recovery before that finishes could orphan a replacement on refusal.
      if (opened) schedule();
    };
    const disposeClosed = async (subscription: IPubSubSubscription): Promise<never> => {
      try {
        await subscription.close();
      } finally {
        // Recovery reuses this name. Only failed initial setup owns deletion
        // here; an established subscription is deleted by its final close.
        if (independent && !opened && subscription.created === true)
          await transport
            .deleteSubscription(queue)
            .catch((error: unknown) =>
              this.#write(
                `Pub/Sub fan-out subscription ${JSON.stringify(queue)} was not deleted (code ${errorCode(error)}); it expires after one idle day`,
              ),
            );
      }
      throw new Error('Pub/Sub stream closed while opening');
    };
    const open = async (): Promise<{
      subscription: IPubSubSubscription;
      closed: () => boolean;
    }> => {
      const openingGeneration = streamGeneration;
      let closedDuringOpen = false;
      const subscription = await this.#openConsumer(
        transport,
        topic,
        queue,
        (msg) => {
          const deliveryGeneration = openingGeneration;
          const run = () => dispatch(msg, deliveryGeneration);
          const completion = ordering === undefined ? run().then(() => {}) : ordering.run(msg, run);
          void completion.catch(() => this.#write('Pub/Sub message settlement failed', 'error'));
        },
        {
          create,
          onClosed: () => {
            if (ended || openingGeneration !== streamGeneration) return;
            closedDuringOpen = true;
            onClosed();
          },
        },
        timing,
      );
      if (closedDuringOpen) return disposeClosed(subscription);
      return { subscription, closed: () => closedDuringOpen };
    };
    const reopen = async (): Promise<void> => {
      if (ended || reopening) return;
      reopening = true;
      try {
        const previous = current;
        current = undefined;
        await previous?.close();
        if (ended || generation !== this.#generation) return;
        const result = await open();
        const replacement = result.subscription;
        if (ended || generation !== this.#generation) {
          await replacement.close();
          if (independent) await transport.deleteSubscription(queue);
          return;
        }
        if (result.closed()) await disposeClosed(replacement);
        current = replacement;
        opened = true;
        state.closed = false;
        failures = 0;
        this.#write('Pub/Sub subscription stream recovered');
      } catch {
        // The closure was reported once. Repeated failures only advance the schedule.
      } finally {
        reopening = false;
        // A close during open/disposal leaves the consumer closed. Start the
        // next backoff only after this attempt has finished disposing its handle.
        if (state.closed) schedule();
      }
    };
    this.#subscriptions.set(subscriptionId, state);
    try {
      const result = await open();
      const initial = result.subscription;
      if (ended || generation !== this.#generation) {
        await initial.close();
        if (independent) await transport.deleteSubscription(queue);
        throw new Error('GcpPubSubBroker disconnected while subscribing');
      }
      if (result.closed()) await disposeClosed(initial);
      current = initial;
      opened = true;
    } catch (error) {
      ended = true;
      streamGeneration++;
      ordering?.clear();
      for (const cancel of checks.values()) cancel();
      if (timer !== undefined) this.#runtime.clearTimeout(timer);
      this.#subscriptions.delete(subscriptionId);
      throw error;
    }
    return markFanOut({ unsubscribe: state.close }, independent);
  }

  #write(message: string, level: 'warn' | 'info' | 'error' = 'warn'): void {
    try {
      const logger = this.#logger;
      (level === 'info'
        ? logger?.info
        : level === 'error'
          ? logger?.error
          : (logger?.warn ?? logger?.error)
      )?.call(logger, message);
    } catch {
      /* Diagnostic sinks cannot change subscription lifecycle. */
    }
  }

  #warnOnce(key: string, message: string, info = false): void {
    if (this.#warnings.has(key)) return;
    this.#warnings.add(key);
    this.#write(message, info ? 'info' : 'warn');
  }

  async #openConsumer(
    transport: IPubSubTransport,
    topic: string,
    queue: string,
    onMessage: Parameters<IPubSubTransport['open']>[2],
    options: PubSubOpenOptions,
    timing: ReturnType<typeof resolveProbeTiming>,
  ): Promise<IPubSubSubscription> {
    const target = options.create?.deadLetterPolicy?.deadLetterTopic;
    let subscription: IPubSubSubscription;
    let attachedFailure = false;
    const context = {
      ...options,
      [PUBSUB_ATTACH_FAILED]: () => {
        attachedFailure = true;
      },
    };
    try {
      subscription = await transport.open(topic, queue, onMessage, context);
    } catch (error) {
      let exists: boolean | undefined;
      if (
        target !== undefined &&
        !attachedFailure &&
        errorCode(error) !== '6' &&
        transport.topicExists !== undefined
      ) {
        try {
          exists = await withDeadline(() => transport.topicExists!(target), {
            timeoutMs: PUBSUB_ADMIN_READ_TIMEOUT_MS,
            onTimeout: () => new Error('Pub/Sub dead-letter topic check timed out'),
            timing,
          });
        } catch {
          /* Preserve the create failure, never the inspection error. */
        }
        if (exists === false) throw new PubSubDeadLetterTopicMissingError(target, error);
      }
      if (!attachedFailure && errorCode(error) === '5')
        throw new PubSubTopicMissingError(
          topic,
          queue,
          error,
          exists === true ? undefined : target,
        );
      throw error;
    }
    if (this.#retry.retry && subscription.created !== true) {
      const expected = options.create;
      const existing = subscription.existing;
      const canonical = (name: string): string =>
        name.startsWith('projects/') ? name : `projects/${this.#projectId}/topics/${name}`;
      if (
        existing === undefined ||
        existing.retryPolicy?.minimumBackoffMs !== expected?.retryPolicy?.minimumBackoffMs ||
        existing.retryPolicy?.maximumBackoffMs !== expected?.retryPolicy?.maximumBackoffMs ||
        existing.deadLetterPolicy?.maxDeliveryAttempts !==
          expected?.deadLetterPolicy?.maxDeliveryAttempts ||
        (existing.deadLetterPolicy?.deadLetterTopic === undefined
          ? undefined
          : canonical(existing.deadLetterPolicy.deadLetterTopic)) !==
          (target === undefined ? undefined : canonical(target))
      ) {
        this.#warnOnce(
          'policy:' + queue,
          `Pub/Sub subscription ${JSON.stringify(queue)} retry policy could not be applied or differs from configuration; existing policies are unchanged`,
        );
      }
    }
    if (
      subscription.created === true &&
      target !== undefined &&
      !this.#warnings.has('target:' + target)
    ) {
      if (transport.topicHasSubscriptions === undefined) {
        this.#warnOnce(
          'target:' + target,
          `Pub/Sub cannot check subscriptions on dead-letter topic ${JSON.stringify(target)}; dead letters are lost unless the topic has a subscription or message retention enabled`,
        );
      } else {
        try {
          const subscribed = await withDeadline(() => transport.topicHasSubscriptions!(target), {
            timeoutMs: PUBSUB_ADMIN_READ_TIMEOUT_MS,
            onTimeout: () => new Error('Pub/Sub dead-letter subscription check timed out'),
            timing,
          });
          if (!subscribed)
            this.#warnOnce(
              'target:' + target,
              `Pub/Sub dead-letter topic ${JSON.stringify(target)} has no subscription; dead letters are lost unless the topic has a subscription or message retention enabled`,
            );
        } catch (error) {
          const permission = errorCode(error) === '7';
          this.#warnOnce(
            'target:' + target,
            permission
              ? `Pub/Sub cannot check dead-letter topic ${JSON.stringify(target)} subscriptions (code 7); grant roles/pubsub.viewer on the topic to run the check; roles/pubsub.subscriber lacks pubsub.topics.get`
              : `Pub/Sub cannot check dead-letter topic ${JSON.stringify(target)} subscriptions (code ${errorCode(error)})`,
            permission,
          );
        }
      }
    }
    return subscription;
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
