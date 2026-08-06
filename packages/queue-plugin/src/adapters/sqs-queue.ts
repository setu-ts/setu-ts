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

import type { IRuntimeServices } from '@hono-enterprise/common';
import type { QueueAdapter } from './queue-adapter.ts';
import type { StoredJob, StoredRecurring } from '../interfaces/index.ts';
import {
  QueueBackendUnavailableError,
  SqsDelayTooLongError,
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
}

/** A message received from SQS with its receipt handle. */
export interface SqsReceivedMessage {
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
  /** Send a message to a queue. */
  send(queueUrl: string, body: string, delaySeconds?: number): Promise<void>;
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
  /** Close the client. */
  close(): Promise<void>;
}

/**
 * Options for SQS queue adapter.
 */
export interface SqsQueueOptions {
  /** Job name → queue URL mapping. */
  queues: Record<string, string>;
  /** Job name → dead-letter queue URL mapping (optional). */
  deadLetterQueues?: Record<string, string>;
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
  const mod = await import('npm:@aws-sdk/client-sqs@^3');
  return mod as unknown as SqsSdkModule;
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
    send: async (queueUrl: string, body: string, delaySeconds?: number): Promise<void> => {
      const input: Record<string, unknown> = {
        QueueUrl: queueUrl,
        MessageBody: body,
      };
      if (delaySeconds !== undefined) {
        input.DelaySeconds = delaySeconds;
      }
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
    close: async () => {
      await client.destroy();
    },
  };
}

/** Internal receipt handle entry keyed by envelope id. */
interface ReceiptEntry {
  readonly receiptHandle: string;
  readonly claimExpiresAtMs: number;
  /** Original message body (for DLQ forwarding). */
  readonly body?: string;
}

/**
 * SQS queue adapter.
 *
 * @since 0.1.0
 */
export class SqsQueue implements QueueAdapter {
  #runtime: IRuntimeServices;
  #queues: Record<string, string>;
  #deadLetterQueues: Record<string, string>;
  #visibilityTimeoutSeconds: number;
  #region: string | undefined;
  #credentials: unknown;
  #endpoint: string | undefined;
  #injectedClient: ISqsTransport | undefined;
  #transport: ISqsTransport | null = null;
  #ready = false;
  #receipts: Map<string, ReceiptEntry>;
  #recurring: Map<string, StoredRecurring>;
  #logger: { error: (msg: string) => void } | undefined;

  constructor(
    runtime: IRuntimeServices,
    options: SqsQueueOptions,
    logger?: { error: (msg: string) => void },
  ) {
    this.#runtime = runtime;
    this.#queues = options.queues;
    this.#deadLetterQueues = options.deadLetterQueues ?? {};
    this.#visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT;
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#endpoint = options.endpoint;
    this.#injectedClient = options.client;
    this.#receipts = new Map();
    this.#recurring = new Map();
    this.#logger = logger;
  }

  /** Get the queue URL for a job name, or throw if unconfigured. */
  #getQueueUrl(name: string): string {
    const url = this.#queues[name];
    if (url === undefined) {
      throw new SqsQueueNotConfiguredError(name, Object.keys(this.#queues) as string[]);
    }
    return url;
  }

  async connect(): Promise<void> {
    if (this.#ready) return;

    if (this.#runtime.platform() === 'cloudflare-workers') {
      throw new QueueBackendUnavailableError('SQS', 'npm:@aws-sdk/client-sqs@^3');
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

    this.#ready = true;
  }

  async disconnect(): Promise<void> {
    if (this.#transport) {
      await this.#transport.close();
      this.#transport = null;
    }
    this.#receipts.clear();
    this.#ready = false;
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

    const body = JSON.stringify({
      v: 1,
      id: job.id,
      name: job.name,
      data: job.data,
      maxAttempts: job.maxAttempts,
    });

    await this.#transport.send(queueUrl, body, delaySeconds);
  }

  async reserve<T>(
    name: string,
    limit: number,
    nowMs: number,
  ): Promise<readonly StoredJob<T>[]> {
    if (!this.#transport) throw new Error('SqsQueue is not connected');

    const queueUrl = this.#getQueueUrl(name);
    const max = Math.min(limit, SQS_MAX_RECEIVE);

    const messages = await this.#transport.receive(
      queueUrl,
      max,
      this.#visibilityTimeoutSeconds,
    );

    const jobs: StoredJob<T>[] = [];
    for (const msg of messages) {
      // Skip messages with no receipt handle (field is optional in SDK types).
      if (!msg.receiptHandle) {
        if (this.#logger) {
          this.#logger.error(`SQS message with no ReceiptHandle skipped on reserve`);
        }
        continue;
      }

      // Parse envelope — skip malformed messages.
      let envelope: {
        v: number;
        id: string;
        name: string;
        data: T;
        maxAttempts: number;
      };
      try {
        envelope = JSON.parse(msg.body) as typeof envelope;
      } catch {
        // Malformed message — skip.
        continue;
      }

      // Attempts come from the platform's ApproximateReceiveCount.
      const attempts = msg.approximateReceiveCount ? Number(msg.approximateReceiveCount) : 1;

      // Record the receipt handle, keyed by receipt handle.
      const maxAttempts = envelope.maxAttempts ?? 3;
      this.#receipts.set(msg.receiptHandle, {
        receiptHandle: msg.receiptHandle,
        claimExpiresAtMs: nowMs + this.#visibilityTimeoutSeconds * 1000,
        body: msg.body,
      });

      jobs.push({
        id: msg.receiptHandle,
        name,
        data: envelope.data,
        attempts,
        maxAttempts,
        availableAtMs: nowMs,
      });
    }

    return jobs;
  }

  async ack(name: string, id: string): Promise<void> {
    if (!this.#transport) throw new Error('SqsQueue is not connected');

    const queueUrl = this.#getQueueUrl(name);
    const entry = this.findReceiptEntry(id);

    if (!entry) {
      // Unknown or expired receipt handle — the claim has lapsed,
      // the message will be redelivered.
      if (this.#logger) {
        this.#logger.error(`SQS ack: unknown or expired receipt handle ${id}`);
      }
      return;
    }

    await this.#transport.delete(queueUrl, entry.receiptHandle);
    this.#receipts.delete(id);
  }

  async requeue(
    name: string,
    id: string,
    availableAtMs: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- attempts is unused by SQS; the count comes from ApproximateReceiveCount.
    _attempts: number,
  ): Promise<void> {
    if (!this.#transport) throw new Error('SqsQueue is not connected');

    const queueUrl = this.#getQueueUrl(name);
    const entry = this.findReceiptEntry(id);

    if (!entry) {
      if (this.#logger) {
        this.#logger.error(`SQS requeue: unknown or expired receipt handle ${id}`);
      }
      return;
    }

    const now = this.#runtime.now();
    const seconds = Math.ceil(Math.max(0, availableAtMs - now) / 1000);

    await this.#transport.changeVisibility(queueUrl, entry.receiptHandle, seconds);
    this.#receipts.delete(id);
  }

  async deadLetter(name: string, id: string, _nowMs: number): Promise<void> {
    if (!this.#transport) throw new Error('SqsQueue is not connected');

    const queueUrl = this.#getQueueUrl(name);
    const entry = this.findReceiptEntry(id);

    if (!entry) {
      if (this.#logger) {
        this.#logger.error(`SQS deadLetter: unknown or expired receipt handle ${id}`);
      }
      return;
    }

    const dlqUrl = this.#deadLetterQueues[name];

    if (dlqUrl) {
      try {
        // Send to DLQ first, then delete from source (that order).
        await this.#transport.send(dlqUrl, entry.body ?? '');
        await this.#transport.delete(queueUrl, entry.receiptHandle);
      } catch (err) {
        // DLQ send failed — leave the source undeleted so it remains claimable.
        if (this.#logger) {
          this.#logger.error(`SQS deadLetter: DLQ send failed: ${err}`);
        }
      }
    } else {
      // No DLQ configured — log and delete.
      if (this.#logger) {
        this.#logger.error(`SQS deadLetter: no DLQ configured for "${name}", deleting message`);
      }
      await this.#transport.delete(queueUrl, entry.receiptHandle);
    }

    this.#receipts.delete(id);
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

  /** Find a receipt entry by job id or receipt handle. */
  private findReceiptEntry(id: string): ReceiptEntry | undefined {
    // Check direct key first.
    if (this.#receipts.has(id)) {
      const entry = this.#receipts.get(id)!;
      // Sweep expired entries.
      if (entry.claimExpiresAtMs < this.#runtime.now()) {
        this.#receipts.delete(id);
        return undefined;
      }
      return entry;
    }
    // Linear scan by receipt handle value (bounded by in-flight work).
    for (const [key, entry] of this.#receipts.entries()) {
      if (entry.receiptHandle === id) {
        if (entry.claimExpiresAtMs < this.#runtime.now()) {
          this.#receipts.delete(key);
          return undefined;
        }
        return entry;
      }
    }
    return undefined;
  }
}
