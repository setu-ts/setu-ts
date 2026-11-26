/**
 * SQS queue adapter implementation.
 *
 * Implements the internal {@linkcode QueueAdapter} seam over AWS SQS, selected
 * via `QueuePlugin({ adapter: 'sqs', sqs: { queues: { ... } } })` and wrapped
 * by {@linkcode QueueService}. Uses per-name queue URLs (`queues` config maps
 * job name → queue URL), receipt-handle bookkeeping,
 * `ApproximateReceiveCount` as the attempt ladder, visibility-timeout backoff,
 * and dead-letter ordering.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import { decodeSqsEnvelope, encodeSqsEnvelope } from './sqs-envelope.ts';
import { SqsRedrive } from './sqs-redrive.ts';
import type { ISqsRedriveTarget } from './sqs-redrive.ts';
import type { QueueAdapter } from './queue-adapter.ts';
import type { StoredJob, StoredRecurring } from '../interfaces/index.ts';
import {
  QueueBackendUnavailableError,
  StaleClaimError,
  SqsDelayTooLongError,
  SqsDeadLetterTargetMissingError,
  SqsQueueNotConfiguredError,
} from '../errors.ts';

/** SQS maximum DelaySeconds (900 s). */
const SQS_MAX_DELAY_SECONDS = 900;

/** SQS maximum MaxNumberOfMessages per ReceiveMessage. */
const SQS_MAX_RECEIVE = 10;

/** Default visibility timeout in seconds. */
const DEFAULT_VISIBILITY_TIMEOUT = 30;

/**
 * Declares the constructors used from the real AWS SQS SDK v3.
 */
export interface SqsSdkModule {
  SQSClient: new (config: {
    region?: string | undefined;
    credentials?: unknown;
    endpoint?: string | undefined;
  }) => {
    send(command: unknown): Promise<unknown>;
    destroy(): Promise<void>;
  };
  SendMessageCommand: new (input: Record<string, unknown>) => unknown;
  ReceiveMessageCommand: new (input: Record<string, unknown>) => unknown;
  DeleteMessageCommand: new (input: Record<string, unknown>) => unknown;
  ChangeMessageVisibilityCommand: new (input: Record<string, unknown>) => unknown;
  /**
   * Reads source redrive policy.
   * @param input - SDK command input
   * @returns The SDK command
   * @throws Never
   * @since 0.14.0
   */
  GetQueueAttributesCommand: new (input: Record<string, unknown>) => unknown;
  /**
   * Resolves a policy ARN target.
   * @param input - SDK command input
   * @returns The SDK command
   * @throws Never
   * @since 0.14.0
   */
  GetQueueUrlCommand: new (input: Record<string, unknown>) => unknown;
}

/** A message received from SQS with its receipt handle. */
export interface SqsReceivedMessage {
  /** Stable source SQS id, used in dead-letter attributes and warnings. @since 0.14.0 */
  messageId?: string;
  /** The message body (JSON string). */
  body: string;
  /** Receipt handle for settle operations. */
  receiptHandle: string;
  /** Approximate receive count (system attribute). May be undefined if the attribute is not requested. */
  approximateReceiveCount: string | undefined;
}

/**
 * Domain port for SQS operations. The adapter depends on this, not the SDK.
 */
export interface ISqsTransport {
  /**
   * Sends a body with optional dead-letter metadata.
   * @param queueUrl - Destination URL
   * @param body - Body bytes as a string
   * @param delaySeconds - Delivery delay
   * @param attributes - SQS message attributes; producer attributes are not copied
   * @returns Resolves after sending
   * @throws {Error} On transport rejection
   * @since 0.14.0
   */
  send(
    queueUrl: string,
    body: string,
    delaySeconds?: number,
    attributes?: Readonly<Record<string, { DataType: 'String' | 'Number'; StringValue: string }>>,
  ): Promise<void>;
  /**
   * Reads named queue attributes.
   * @param queueUrl - Source URL
   * @param names - Attribute names
   * @returns Present attributes
   * @throws {Error} On transport rejection
   * @since 0.14.0
   */
  getQueueAttributes?(
    queueUrl: string,
    names: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
  /**
   * Resolves a dead-letter queue in its owner's account.
   * @param queueName - Queue name from the policy ARN
   * @param ownerAccountId - Account from the policy ARN
   * @returns Queue URL
   * @throws {Error} On transport rejection
   * @since 0.14.0
   */
  getQueueUrl?(queueName: string, ownerAccountId: string): Promise<string>;
  /** Receive messages from a queue. */
  receive(
    queueUrl: string,
    max: number,
    visibilitySeconds: number,
  ): Promise<readonly SqsReceivedMessage[]>;
  /** Delete a message (ack). */
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
  /** Change visibility timeout (requeue). */
  changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void>;
  /**
   * Reports whether the queue is reachable when an injected transport supplies
   * a probe. The SDK adapter has no reachability probe. Optional so a minimal fake still
   * type-checks; a transport that omits it is *unknown*, not `false`.
   *
   * @returns `true` when the queue is reachable
   * @since 0.1.0
   */
  isHealthy?(): Promise<boolean>;
  /** Close the client. */
  close(): Promise<void>;
}

/**
 * Options for SQS queue adapter.
 */
export interface SqsQueueOptions {
  /** Job name → queue URL mapping. */
  queues: Record<string, string>;
  /**
   * Consumed name → target URL, or false to discard exhausted work. A URL wins
   * over the queue policy; false bypasses policy reads and budget clamps.
   * @since 0.14.0
   */
  deadLetterQueues?: Record<string, string | false>;
  /** Visibility timeout in seconds for claims (default 30). */
  visibilityTimeoutSeconds?: number;
  /** AWS region (for lazy SDK load). */
  region?: string;
  /** AWS credentials (for lazy SDK load). */
  credentials?: unknown;
  /** Custom endpoint URL (for ElasticMQ / local testing). */
  endpoint?: string;
  /** Injected transport (bypasses lazy SDK load). */
  client?: ISqsTransport;
}

/**
 * Lazy-load the AWS SQS SDK v3.
 */
export async function loadSqsModule(): Promise<SqsSdkModule> {
  try {
    return (await import('@aws-sdk/client-sqs')) as unknown as SqsSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@aws-sdk/client-sqs', {
      requiredBy: '@setu-ts/queue-plugin',
      cause: error,
    });
  }
}

/**
 * Adapts the real AWS SQS SDK v3 module to the domain port.
 *
 * @param mod - The loaded SDK module
 * @param options - Client constructor options
 * @returns A domain-shaped transport
 */
export function adaptSqsModule(
  mod: SqsSdkModule,
  options: { region?: string | undefined; credentials?: unknown; endpoint?: string | undefined },
): ISqsTransport {
  const clientConfig: Record<string, unknown> = {};
  if (options.region !== undefined) clientConfig.region = options.region;
  if (options.credentials !== undefined) clientConfig.credentials = options.credentials;
  if (options.endpoint !== undefined) clientConfig.endpoint = options.endpoint;
  const client = new mod.SQSClient(clientConfig);

  return {
    send: async (queueUrl, body, delaySeconds, attributes): Promise<void> => {
      const input: Record<string, unknown> = {
        QueueUrl: queueUrl,
        MessageBody: body,
      };
      if (delaySeconds !== undefined) {
        input.DelaySeconds = delaySeconds;
      }
      if (attributes !== undefined) input.MessageAttributes = attributes;
      await client.send(new mod.SendMessageCommand(input));
    },
    receive: async (
      queueUrl: string,
      max: number,
      visibilitySeconds: number,
    ): Promise<readonly SqsReceivedMessage[]> => {
      const result = await client.send(
        new mod.ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: max,
          VisibilityTimeout: visibilitySeconds,
          MessageAttributeNames: [],
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );

      const messages = (result as { Messages?: unknown[] }).Messages ?? [];
      return messages.map((m: unknown) => {
        const msg = m as {
          Body?: string;
          MessageId?: string;
          ReceiptHandle?: string;
          MessageAttributes?: Record<string, unknown>;
          MD5OfMessageBody?: string;
          Attributes?: Record<string, string>;
        };
        return {
          ...(msg.MessageId === undefined ? {} : { messageId: msg.MessageId }),
          body: msg.Body ?? '',
          receiptHandle: msg.ReceiptHandle ?? '',
          approximateReceiveCount: msg.Attributes?.ApproximateReceiveCount,
        };
      });
    },
    delete: async (queueUrl: string, receiptHandle: string): Promise<void> => {
      await client.send(
        new mod.DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    },
    changeVisibility: async (
      queueUrl: string,
      receiptHandle: string,
      seconds: number,
    ): Promise<void> => {
      await client.send(
        new mod.ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    },
    getQueueAttributes: async (queueUrl, names) => {
      const result = await client.send(
        new mod.GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: names,
        }),
      );
      return (result as { Attributes?: Record<string, string> }).Attributes ?? {};
    },
    getQueueUrl: async (queueName, ownerAccountId) => {
      const result = await client.send(
        new mod.GetQueueUrlCommand({
          QueueName: queueName,
          QueueOwnerAWSAccountId: ownerAccountId,
        }),
      );
      const url = (result as { QueueUrl?: string }).QueueUrl;
      if (!url) throw new Error('SQS GetQueueUrl returned no QueueUrl');
      return url;
    },
    close: async () => {
      await client.destroy();
    },
  };
}

/** Per-delivery receipt state, fenced against replacement while I/O is pending. */
interface ReceiptEntry {
  readonly name: string;
  readonly receiptHandle: string;
  readonly claimExpiresAtMs: number;
  readonly receivedAtMs: number;
  readonly body: string;
  readonly claimToken: string;
  readonly attempts: number;
  readonly messageId: string;
  /** Shared by renewed snapshots of this delivery, never by a redelivery. */
  readonly activity: {
    /** Owns the entire settle, including preparation and forwarding. */
    settlementInProgress: boolean;
    /** Fences renewal only around the final receipt operation. */
    settling: boolean;
    renewal: Promise<boolean> | undefined;
  };
}

/**
 * SQS queue adapter.
 *
 * @since 0.1.0
 */
export class SqsQueue implements QueueAdapter {
  #runtime: IRuntimeServices;
  #queues: Record<string, string>;
  #deadLetterQueues: Record<string, string | false>;
  #visibilityTimeoutSeconds: number;
  #region: string | undefined;
  #credentials: unknown;
  #endpoint: string | undefined;
  #injectedClient: ISqsTransport | undefined;
  #transport: ISqsTransport | null = null;
  #ready = false;
  /**
   * Present only when an injected transport exposes `isHealthy?()`;
   * the SDK adapter has no probe. Its absence is *unknown* reachability,
   * not `false`.
   *
   * @since 0.1.0
   */
  isHealthy?: () => Promise<boolean>;
  #receipts: Map<string, ReceiptEntry>;
  #recurring: Map<string, StoredRecurring>;
  #logger: { error: (msg: string) => void; warn: (msg: string) => void } | undefined;
  #defaultMaxAttempts: number;
  #redrive = new SqsRedrive();
  #preparations = new Map<string, Promise<ISqsRedriveTarget>>();
  #connection = 0;
  readonly #retirements = new Set<Promise<void>>();
  #targets = new Map<string, ISqsRedriveTarget>();
  #clampWarned = new Set<string>();
  /**
   * Per-receipt renewal, driven and cleared by QueueService.
   * @since 0.14.0
   */
  readonly claimRenewal: {
    /** Renewal cadence in milliseconds, one third of visibility. @since 0.14.0 */
    readonly intervalMs: number;
    /**
     * Extends the current, unexpired receipt, including during dead-letter
     * preparation and forwarding. A valid fenced receipt succeeds without I/O
     * during its final delete or visibility change; an expired one returns false.
     * @param name - Job name
     * @param id - Job id
     * @param claimToken - Delivery fence
     * @returns True after extension or while a valid final receipt operation is fenced
     * @throws Never
     * @since 0.14.0
     */
    extend(name: string, id: string, claimToken: string): Promise<boolean>;
  };

  /**
   * @param runtime - Clock, timers and delivery token generator
   * @param options - Queue URLs and SQS connection options
   * @param logger - Optional sink; warnings fall back to error when warn is absent
   * @param defaults - Consumer attempt default for externally published work (default 3)
   * @returns The queue adapter
   * @throws {RangeError} For an invalid visibilityTimeoutSeconds or maxAttempts default
   * @since 0.14.0
   */

  constructor(
    runtime: IRuntimeServices,
    options: SqsQueueOptions,
    logger?: { error: (msg: string) => void; warn?: (msg: string) => void },
    defaults?: { maxAttempts?: number },
  ) {
    this.#runtime = runtime;
    this.#queues = options.queues;
    this.#deadLetterQueues = options.deadLetterQueues ?? {};
    this.#visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT;
    if (
      !Number.isInteger(this.#visibilityTimeoutSeconds) ||
      this.#visibilityTimeoutSeconds < 1 ||
      this.#visibilityTimeoutSeconds > 43_200
    ) {
      throw new RangeError('visibilityTimeoutSeconds must be an integer from 1 to 43200');
    }
    this.#defaultMaxAttempts = defaults?.maxAttempts ?? 3;
    if (!Number.isInteger(this.#defaultMaxAttempts) || this.#defaultMaxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    this.claimRenewal = {
      intervalMs: Math.floor((this.#visibilityTimeoutSeconds * 1000) / 3),
      extend: (name, id, token) => this.#extend(name, id, token),
    };
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#endpoint = options.endpoint;
    this.#injectedClient = options.client;
    this.#receipts = new Map();
    this.#recurring = new Map();
    this.#logger =
      logger === undefined
        ? undefined
        : {
            error: (message) => logger.error(message),
            warn: (message) => (logger.warn ?? logger.error).call(logger, message),
          };
  }

  /** Get the queue URL for a job name, or throw if unconfigured. */
  #getQueueUrl(name: string): string {
    const url = Object.hasOwn(this.#queues, name) ? this.#queues[name] : undefined;
    if (url === undefined) {
      throw new SqsQueueNotConfiguredError(name, Object.keys(this.#queues) as string[]);
    }
    return url;
  }

  async connect(): Promise<void> {
    if (this.#ready) return;

    if (this.#runtime.platform() === 'cloudflare-workers') {
      throw new QueueBackendUnavailableError('SQS', '@aws-sdk/client-sqs');
    }

    if (this.#injectedClient !== undefined) {
      this.#transport = this.#injectedClient;
    } else {
      const mod = await loadSqsModule();
      this.#transport = adaptSqsModule(mod, {
        region: this.#region,
        credentials: this.#credentials,
        endpoint: this.#endpoint,
      });
    }

    this.#connection++;
    this.#redrive = new SqsRedrive();
    this.#ready = true;
    this.#installProbe();
  }

  /**
   * M70c: installs `isHealthy` from the transport's optional member when
   * present; leaves it absent (unknown) otherwise.
   */
  #installProbe(): void {
    const transport = this.#transport;
    if (transport !== null && typeof transport.isHealthy === 'function') {
      const probe = transport.isHealthy;
      this.isHealthy = (): Promise<boolean> => probe();
    } else {
      delete this.isHealthy;
    }
  }

  async disconnect(): Promise<void> {
    this.#connection++;
    this.#ready = false;
    this.#redrive.close();
    await Promise.allSettled(this.#preparations.values());
    await Promise.allSettled(this.#retirements);
    this.#preparations.clear();
    this.#targets.clear();
    this.#clampWarned.clear();
    if (this.#transport) {
      await this.#transport.close();
      this.#transport = null;
    }
    this.#receipts.clear();
    this.#ready = false;
    delete this.isHealthy;
  }

  isReady(): boolean {
    return this.#ready;
  }

  async enqueue<T>(job: StoredJob<T>): Promise<void> {
    if (!this.#transport) throw new Error('SqsQueue is not connected');

    const queueUrl = this.#getQueueUrl(job.name);

    // Calculate delay seconds from availableAtMs
    let delaySeconds: number | undefined;
    if (job.availableAtMs > 0) {
      const now = this.#runtime.now();
      const delayMs = Math.max(0, job.availableAtMs - now);
      delaySeconds = Math.ceil(delayMs / 1000);

      if (delaySeconds > SQS_MAX_DELAY_SECONDS) {
        throw new SqsDelayTooLongError(delayMs);
      }
    }

    const body = encodeSqsEnvelope({
      id: job.id,
      name: job.name,
      data: job.data,
      maxAttempts: job.maxAttempts,
      ...(job.headers === undefined ? {} : { headers: job.headers }),
    });

    await this.#transport.send(queueUrl, body, delaySeconds);
  }

  /**
   * Coalesces preparation of one consumed name. Successful targets and definite
   * refusals are retained; transient attribute or URL failures can be retried.
   * @param name - Consumed job name
   * @returns Resolves after a target is proved
   * @throws {SqsDeadLetterTargetMissingError} If no target is available
   * @throws {Error} If disconnected or the name is not configured
   * @since 0.14.0
   */
  async prepareConsumer(name: string): Promise<void> {
    if (!this.#ready || !this.#transport) throw new Error('SqsQueue is not connected');
    let preparation = this.#preparations.get(name);
    if (!preparation) {
      const transport = this.#transport;
      const connection = this.#connection;
      preparation = this.#redrive
        .resolve(
          this.#runtime,
          transport,
          name,
          this.#getQueueUrl(name),
          Object.hasOwn(this.#deadLetterQueues, name) ? this.#deadLetterQueues[name] : undefined,
          (message) => this.#logger?.warn(message),
        )
        .then((target) => {
          if (!this.#ready || this.#connection !== connection)
            throw new Error('SqsQueue is not connected');
          this.#targets.set(name, target);
          return target;
        });
      this.#preparations.set(name, preparation);
      const pending = preparation;
      void pending.catch((error: unknown) => {
        if (
          error instanceof SqsDeadLetterTargetMissingError &&
          (error.reason === 'attributes-unavailable' || error.reason === 'target-unresolvable') &&
          this.#preparations.get(name) === pending
        )
          this.#preparations.delete(name);
      });
    }
    await preparation;
  }

  async reserve<T>(name: string, limit: number, nowMs: number): Promise<readonly StoredJob<T>[]> {
    if (!this.#transport) throw new Error('SqsQueue is not connected');
    const connection = this.#connection;
    await this.prepareConsumer(name);
    const transport = this.#transport;
    if (!this.#ready || !transport || this.#connection !== connection)
      throw new Error('SqsQueue is not connected');
    const queueUrl = this.#getQueueUrl(name);
    const target = this.#targets.get(name)!;
    const receivedAtMs = this.#runtime.now();
    const messages = await transport.receive(
      queueUrl,
      Math.min(limit, SQS_MAX_RECEIVE),
      this.#visibilityTimeoutSeconds,
    );
    if (!this.#ready || this.#connection !== connection)
      throw new Error('SqsQueue is not connected');
    // Waiting for a long poll is not time spent handling its returned delivery.
    // Keep the request start only for the conservative twelve-hour ceiling.
    const claimExpiresAtMs = this.#runtime.now() + this.#visibilityTimeoutSeconds * 1000;
    const jobs: StoredJob<T>[] = [];
    for (const msg of messages) {
      if (!msg.receiptHandle) {
        this.#logger?.error('SQS message with no ReceiptHandle skipped on reserve');
        continue;
      }
      const decoded = decodeSqsEnvelope(msg.body, name);
      const attempts =
        msg.approximateReceiveCount === undefined ? 1 : Number(msg.approximateReceiveCount);
      const validCount = Number.isInteger(attempts) && attempts >= 1;
      if (!decoded.ok || !validCount) {
        const reason = !decoded.ok ? decoded.reason : 'invalid ApproximateReceiveCount';
        const retirement = this.#retireUnreadable(name, msg, validCount ? attempts : 0, reason);
        this.#retirements.add(retirement);
        void retirement.finally(() => this.#retirements.delete(retirement));
        continue;
      }
      const envelope = decoded.envelope;
      const headers = readStringMap(envelope.headers);
      if (envelope.headers !== undefined && headers === undefined) {
        this.#logger?.error(
          `SQS reserve: malformed headers dropped on "${name}" job ${logId(envelope.id)} — job runs untraced`,
        );
      }
      let maxAttempts = envelope.maxAttempts ?? this.#defaultMaxAttempts;
      if (target.maxReceiveCount !== undefined) {
        const budget = Math.max(1, Math.min(maxAttempts, target.maxReceiveCount - 1));
        if (
          (budget < maxAttempts || target.maxReceiveCount === 1) &&
          !this.#clampWarned.has(name)
        ) {
          this.#clampWarned.add(name);
          this.#logger?.warn(
            `SQS "${name}": maxAttempts=${maxAttempts}, maxReceiveCount=${target.maxReceiveCount}, effective budget=${budget}; recommend maxReceiveCount = maxAttempts + 1` +
              (target.maxReceiveCount === 1
                ? '; a worker dying on this attempt leaves native redrive without onFailed'
                : ''),
          );
        }
        maxAttempts = budget;
      }
      const claimToken = this.#runtime.uuid();
      this.#receipts.set(envelope.id, {
        name,
        receiptHandle: msg.receiptHandle,
        receivedAtMs,
        claimExpiresAtMs,
        body: msg.body,
        claimToken,
        attempts,
        messageId: msg.messageId ?? 'unknown',
        activity: { settlementInProgress: false, settling: false, renewal: undefined },
      });
      jobs.push({
        id: envelope.id,
        name,
        data: envelope.data as T,
        attempts,
        maxAttempts,
        availableAtMs: nowMs,
        claimToken,
        ...(headers === undefined ? {} : { headers }),
      });
    }
    if (!this.#ready || this.#connection !== connection)
      throw new Error('SqsQueue is not connected');
    return jobs;
  }

  ack(name: string, id: string, claimToken: string): Promise<void> {
    return this.#settle(name, id, claimToken, async (entry, fence, transport) => {
      await fence();
      await transport.delete(this.#getQueueUrl(name), entry.receiptHandle);
    });
  }

  requeue(
    name: string,
    id: string,
    availableAtMs: number,
    _attempts: number,
    claimToken: string,
  ): Promise<void> {
    return this.#settle(name, id, claimToken, async (entry, fence, transport) => {
      await fence();
      const seconds = Math.ceil(Math.max(0, availableAtMs - this.#runtime.now()) / 1000);
      const remaining = this.#remainingVisibility(entry);
      if (remaining >= 1)
        await transport.changeVisibility(
          this.#getQueueUrl(name),
          entry.receiptHandle,
          Math.min(seconds, remaining),
        );
    });
  }

  /**
   * Forwards terminal work before deleting the source, or explicitly discards it.
   * @param name - Consumed name
   * @param id - Job id
   * @param _nowMs - Caller time (receipt expiry uses the adapter clock)
   * @param claimToken - Delivery fence
   * @param reason - Final failure or dead-worker abandonment
   * A copy reaching the target is counted as dead-lettered even if the claim
   * lapses during forwarding; a warning records the at-least-once duplicate risk.
   * @returns Discard marker only after a successful opt-out deletion
   * @throws {StaleClaimError} If stale before forwarding or before an explicit discard
   * @throws {Error} On transport rejection; the receipt is kept until its visibility
   * timeout. A later delivery may forward a second copy after a failed source delete.
   * @since 0.14.0
   */
  deadLetter(
    name: string,
    id: string,
    _nowMs: number,
    claimToken: string,
    reason: 'attempts-exhausted' | 'abandoned' = 'attempts-exhausted',
  ): Promise<void | 'discarded'> {
    return this.#settle(name, id, claimToken, (entry, fence) =>
      this.#retire(
        name,
        entry.body,
        entry.receiptHandle,
        entry.messageId,
        entry.attempts,
        reason,
        id,
        fence,
      ),
    );
  }

  /** Owns one settle while allowing renewal until its final receipt operation takes the fence. */
  async #settle<T>(
    name: string,
    id: string,
    token: string,
    call: (
      entry: ReceiptEntry,
      fence: (recheck?: boolean) => Promise<boolean>,
      transport: ISqsTransport,
    ) => Promise<T>,
  ): Promise<T> {
    const transport = this.#transport;
    if (!transport) throw new Error('SqsQueue is not connected');
    const entry = this.#claim(name, id, token);
    const activity = entry.activity;
    if (activity.settlementInProgress) throw new StaleClaimError();
    activity.settlementInProgress = true;
    // `recheck: false` is for the source delete after a successful forward: the
    // copy is already in the target, so the delete is always attempted. A stale
    // receipt handle makes SQS skip it harmlessly; refusing here would leave the
    // source to be delivered and forwarded again.
    // Resolves whether this delivery still owns the claim.
    const fence = async (recheck = true): Promise<boolean> => {
      activity.settling = true;
      if (activity.renewal !== undefined) await activity.renewal;
      if (recheck) {
        this.#claim(name, id, token);
        return true;
      }
      const current = this.findReceiptEntry(id);
      return current !== undefined && current.name === name && current.claimToken === token;
    };
    try {
      const result = await call(entry, fence, transport);
      this.#forget(id, entry);
      return result;
    } finally {
      activity.settling = false;
      activity.settlementInProgress = false;
    }
  }

  async #retire(
    name: string,
    body: string,
    receiptHandle: string,
    messageId: string,
    attempts: number,
    reason: 'attempts-exhausted' | 'abandoned' | 'unreadable',
    id = messageId,
    fence?: (recheck?: boolean) => Promise<boolean>,
  ): Promise<void | 'discarded'> {
    // reserve already prepared unreadable work; claimed settles keep renewing
    // while their own preparation completes.
    if (reason !== 'unreadable') await this.prepareConsumer(name);
    const transport = this.#transport!;
    const target = this.#targets.get(name)!;
    if (target.url === false) {
      if (fence !== undefined) await fence();
      await transport.delete(this.#getQueueUrl(name), receiptHandle);
      if (reason !== 'unreadable') {
        this.#logger?.warn(
          `SQS "${name}" job ${logId(id)} discarded after ${attempts} attempts; deadLetterQueues[name] is false`,
        );
      }
      return 'discarded';
    }
    try {
      await transport.send(target.url, body, undefined, {
        'setu-dead-letter-reason': { DataType: 'String', StringValue: reason },
        'setu-attempts': { DataType: 'Number', StringValue: String(attempts) },
        'setu-source-message-id': { DataType: 'String', StringValue: messageId },
      });
    } catch (error) {
      // SendMessage size refusal confirmed with the installed SDK against
      // LocalStack. Attributes count towards the limit; never match error text.
      if (
        typeof error !== 'object' ||
        error === null ||
        !('name' in error) ||
        error.name !== 'InvalidParameterValue'
      )
        throw error;
      this.#logger?.warn(
        `SQS deadLetter: forwarding "${name}" without setu- attributes after InvalidParameterValue; dead-letter metadata omitted`,
      );
      await transport.send(target.url, body);
    }
    try {
      const owned = fence === undefined ? true : await fence(false);
      await transport.delete(this.#getQueueUrl(name), receiptHandle);
      if (!owned) {
        this.#logger?.warn(
          `SQS deadLetter: the claim on "${name}" job ${logId(id)} lapsed during the forward; the source may be delivered and dead-lettered again`,
        );
      }
    } catch (error) {
      this.#logger?.error(
        `SQS deadLetter: source delete for "${name}" failed (possible duplicate on re-claim)`,
      );
      throw error;
    }
  }

  async #extend(name: string, id: string, token: string): Promise<boolean> {
    const transport = this.#transport;
    const entry = this.findReceiptEntry(id);
    if (!this.#ready || !transport || !entry || entry.name !== name || entry.claimToken !== token)
      return false;
    // Only the final receipt operation suppresses renewal, and only while the
    // claim is still valid. Slow preparation and forwarding keep renewing.
    if (entry.activity.settling) return true;
    if (entry.activity.renewal !== undefined) return entry.activity.renewal;
    const pending = Promise.withResolvers<boolean>();
    entry.activity.renewal = pending.promise;
    // Publish the in-flight promise before entering the transport, including
    // an injected transport that synchronously calls back into the adapter.
    void this.#renewReceipt(name, id, entry, transport).then(pending.resolve, pending.reject);
    try {
      return await pending.promise;
    } finally {
      entry.activity.renewal = undefined;
    }
  }

  /** Whole seconds remaining, rounded down with one second of request headroom. */
  #remainingVisibility(entry: ReceiptEntry): number {
    return Math.max(
      0,
      Math.floor((43_200_000 - (this.#runtime.now() - entry.receivedAtMs) - 1000) / 1000),
    );
  }

  /** Retires unreadable bytes independently of the valid batch claims. */
  async #retireUnreadable(
    name: string,
    msg: SqsReceivedMessage,
    attempts: number,
    reason: string,
  ): Promise<void> {
    try {
      const disposition = await this.#retire(
        name,
        msg.body,
        msg.receiptHandle!,
        msg.messageId ?? 'unknown',
        attempts,
        'unreadable',
      );
      this.#logger?.warn(
        `SQS unreadable message on "${name}", message id "${msg.messageId ?? 'unknown'}": ${reason}; ${disposition === 'discarded' ? 'discarded; deadLetterQueues[name] is false' : 'forwarded unchanged to its dead-letter target and deleted'}`,
      );
    } catch {
      try {
        this.#logger?.warn(
          `SQS unreadable message on "${name}", message id "${msg.messageId ?? 'unknown'}": ${reason}; forwarding or deletion failed; left for its visibility timeout`,
        );
      } catch {
        /* Diagnostics cannot reject detached retirement. */
      }
    }
  }

  async #renewReceipt(
    name: string,
    id: string,
    entry: ReceiptEntry,
    transport: ISqsTransport,
  ): Promise<boolean> {
    const now = this.#runtime.now();
    const remaining = this.#remainingVisibility(entry);
    if (remaining <= 0) return false;
    const seconds = Math.min(this.#visibilityTimeoutSeconds, remaining);
    try {
      await transport.changeVisibility(this.#getQueueUrl(name), entry.receiptHandle, seconds);
    } catch {
      return false;
    }
    if (!this.#ready || this.#transport !== transport || this.#receipts.get(id) !== entry)
      return false;
    this.#receipts.set(id, { ...entry, claimExpiresAtMs: now + seconds * 1000 });
    return true;
  }

  #claim(name: string, id: string, token: string): ReceiptEntry {
    this.#getQueueUrl(name);
    const entry = this.findReceiptEntry(id);
    if (!entry || entry.name !== name || entry.claimToken !== token) throw new StaleClaimError();
    return entry;
  }

  #forget(id: string, entry: ReceiptEntry): void {
    if (this.#receipts.get(id)?.claimToken === entry.claimToken) this.#receipts.delete(id);
  }

  storeRecurring(rec: StoredRecurring): Promise<void> {
    this.#recurring.set(rec.id, rec);
    return Promise.resolve();
  }

  fetchRecurringDue(nowMs: number): Promise<readonly StoredRecurring[]> {
    const due: StoredRecurring[] = [];
    for (const rec of this.#recurring.values()) {
      if (rec.nextRunAtMs <= nowMs) {
        due.push(rec);
      }
    }
    return Promise.resolve(due as readonly StoredRecurring[]);
  }

  advanceRecurring(id: string, nextRunAtMs: number): Promise<void> {
    const rec = this.#recurring.get(id);
    if (rec) {
      this.#recurring.set(id, { ...rec, nextRunAtMs });
    }
    return Promise.resolve();
  }

  /** Find a receipt entry by stable job id. */
  private findReceiptEntry(id: string): ReceiptEntry | undefined {
    const entry = this.#receipts.get(id);
    if (!entry) {
      return undefined;
    }
    // Sweep expired entries.
    if (entry.claimExpiresAtMs <= this.#runtime.now()) {
      this.#receipts.delete(id);
      return undefined;
    }
    return entry;
  }
}

/**
 * Renders a sender-chosen job id for a log line: JSON-quoted, so a CR/LF or a
 * quote cannot forge a second record in a plain-text logger, and cut to 128
 * characters, so a large id cannot flood the log.
 *
 * @param id - The envelope id, as the sender wrote it
 * @returns The quoted, bounded id
 */
function logId(id: string): string {
  return JSON.stringify(id.length > 128 ? `${id.slice(0, 128)}…` : id);
}

/**
 * Narrows an envelope's `headers` to a flat string map, or reports `undefined`
 * when it is absent or malformed.
 *
 * SQS bodies are arbitrary JSON written by whoever holds the queue URL, so the
 * value arrives as `unknown` and cannot be trusted to be the shape
 * `IJob.headers` promises its consumers. One non-string value is enough to
 * reject the whole map: a partially-typed map would hand a processor a
 * `Record<string, string>` containing something that is not a string, which is
 * the kind of lie a type assertion exists to prevent.
 *
 * Absent and malformed deliberately collapse to the same answer HERE — both
 * mean "no usable channel" — while the caller keeps them apart for reporting,
 * because only the second is worth an operator's attention.
 *
 * @param value - The envelope's raw `headers` member
 * @returns The map when every value is a string, otherwise `undefined`
 */
function readStringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [, entry] of entries) {
    if (typeof entry !== 'string') {
      return undefined;
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
