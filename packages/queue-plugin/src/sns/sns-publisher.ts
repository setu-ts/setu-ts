/**
 * SNS publisher for fan-out over AWS SNS.
 *
 * Uses the v3 SNS SDK behind a domain port ({@linkcode ISnsTransport}) with
 * lazy-load via {@linkcode loadSnsModule} and adaptation via
 * {@linkcode adaptSnsModule}.
 *
 * @module
 */

import {
  OptionalDependencyUnavailableError,
  contextToTraceparent,
  TELEMETRY_CONTEXT_OPAQUE,
  TRACEPARENT_HEADER,
} from '@setu-ts/common';
import type { IRuntimeServices, ITelemetryService } from '@setu-ts/common';
import { encodeSqsEnvelope } from '../adapters/sqs-envelope.ts';

/**
 * Declares the constructors used from the real AWS SNS SDK v3.
 */
export interface SnsSdkModule {
  SNSClient: new (config: {
    region?: string | undefined;
    credentials?: unknown;
    endpoint?: string | undefined;
  }) => {
    send(command: unknown): Promise<unknown>;
    destroy(): Promise<void>;
  };
  PublishCommand: new (input: Record<string, unknown>) => unknown;
}

/**
 * Domain port for SNS operations.
 */
export interface ISnsTransport {
  /** Publish a message to a topic. Returns the message ID or undefined. */
  publish(topicArn: string, body: string): Promise<string | undefined>;
  /** Close the client. */
  close(): Promise<void>;
}

/**
 * Options for SNS publisher.
 */
export interface SnsPublisherOptions {
  /** Supplies publishJob ids through uuid(); publish ignores it. @since 0.14.0 */
  runtime?: IRuntimeServices;
  /** Producer spans and envelope traceparent for publishJob; publish ignores it. @since 0.14.0 */
  telemetry?: ITelemetryService;
  /** Target SNS topic ARN. */
  topicArn: string;
  /** AWS region (for lazy SDK load). */
  region?: string;
  /** AWS credentials (for lazy SDK load). */
  credentials?: unknown;
  /** Custom endpoint URL (for local testing). */
  endpoint?: string;
  /** Injected transport (bypasses lazy SDK load). */
  client?: ISnsTransport;
}

/**
 * Lazy-load the AWS SNS SDK v3.
 */
export async function loadSnsModule(): Promise<SnsSdkModule> {
  try {
    return (await import('@aws-sdk/client-sns')) as unknown as SnsSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@aws-sdk/client-sns', {
      requiredBy: '@setu-ts/queue-plugin',
      cause: error,
    });
  }
}

/**
 * Adapts the real AWS SNS SDK v3 module to the domain port.
 *
 * @param mod - The loaded SDK module
 * @param options - Client constructor options
 * @returns A domain-shaped transport
 */
export function adaptSnsModule(
  mod: SnsSdkModule,
  options: { region?: string | undefined; credentials?: unknown; endpoint?: string | undefined },
): ISnsTransport {
  const clientConfig: Record<string, unknown> = {};
  if (options.region !== undefined) clientConfig.region = options.region;
  if (options.credentials !== undefined) clientConfig.credentials = options.credentials;
  if (options.endpoint !== undefined) clientConfig.endpoint = options.endpoint;
  const client = new mod.SNSClient(clientConfig);

  return {
    publish: async (topicArn: string, body: string): Promise<string | undefined> => {
      const result = await client.send(
        new mod.PublishCommand({
          TopicArn: topicArn,
          Message: body,
        }),
      );
      return (result as { MessageId?: string }).MessageId;
    },
    close: async () => {
      await client.destroy();
    },
  };
}

/**
 * SNS publisher for fan-out messaging.
 *
 * Publishes messages to a single SNS topic, which fans them out to all
 * subscribed endpoints (SQS queues, HTTP endpoints, Lambda functions, etc.).
 *
 * @since 0.1.0
 */
export class SnsPublisher {
  #topicArn: string;
  #region: string | undefined;
  #credentials: unknown;
  #endpoint: string | undefined;
  #injectedClient: ISnsTransport | undefined;
  #transport: ISnsTransport | null = null;
  #ready = false;
  #runtime: IRuntimeServices | undefined;
  #telemetry: ITelemetryService | undefined;

  constructor(options: SnsPublisherOptions) {
    this.#runtime = options.runtime;
    this.#telemetry = options.telemetry;
    this.#topicArn = options.topicArn;
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#endpoint = options.endpoint;
    this.#injectedClient = options.client;
  }

  async connect(): Promise<void> {
    if (this.#ready) return;

    if (this.#injectedClient !== undefined) {
      this.#transport = this.#injectedClient;
    } else {
      const mod = await loadSnsModule();
      this.#transport = adaptSnsModule(mod, {
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
    this.#ready = false;
  }

  isReady(): boolean {
    return this.#ready;
  }

  /**
   * Publish a raw message to the configured SNS topic. The queue adapter
   * cannot read this form; use publishJob for SQS job consumers.
   *
   * @param message - The message payload (serialized to JSON)
   * @returns The SNS message ID, or undefined if not available
   */
  publish(message: unknown): Promise<string | undefined> {
    if (!this.#transport) throw new Error('SnsPublisher is not connected');

    const body = typeof message === 'string' ? message : JSON.stringify(message);
    return this.#transport.publish(this.#topicArn, body);
  }
  /**
   * Publishes work readable by raw and wrapped SQS subscriptions consuming name.
   * Headers live only in the envelope; no SNS message attributes are sent.
   * @typeParam T - Payload type
   * @param name - Consumed job name
   * @param data - JSON-serializable job payload
   * @param options - Explicit identity, optional attempt budget and copied headers
   * @returns SNS message id, or undefined when unavailable
   * @throws {TypeError} As a rejection without options.id or options.runtime, or for invalid work
   * @throws {Error} As a rejection if disconnected or publishing fails
   * @example
   * ```typescript
   * await publisher.publishJob('report.build', { reportId: 'r1' }, { id: 'job-1' });
   * ```
   * @since 0.14.0
   */
  async publishJob<T>(
    name: string,
    data: T,
    options?: {
      id?: string;
      maxAttempts?: number;
      headers?: Readonly<Record<string, string>>;
    },
  ): Promise<string | undefined> {
    const transport = this.#transport;
    if (!transport) throw new Error('SnsPublisher is not connected');
    const id = options?.id ?? this.#runtime?.uuid();
    if (id === undefined)
      throw new TypeError('publishJob requires options.id or SnsPublisherOptions.runtime');
    const publish = (
      headers: Readonly<Record<string, string>> | undefined,
    ): Promise<string | undefined> =>
      transport.publish(
        this.#topicArn,
        encodeSqsEnvelope({
          id,
          name,
          data,
          ...(options?.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
          ...(headers === undefined ? {} : { headers: { ...headers } }),
        }),
      );
    if (!this.#telemetry) return await publish(options?.headers);
    return await this.#telemetry.withSpan(
      `enqueue ${name}`,
      (span) => {
        const traceparent = contextToTraceparent({
          _opaque: TELEMETRY_CONTEXT_OPAQUE,
          ...span.spanContext(),
        });
        return publish(
          traceparent === null
            ? options?.headers
            : { ...options?.headers, [TRACEPARENT_HEADER]: traceparent },
        );
      },
      {
        kind: 'producer',
        attributes: {
          'messaging.system': 'queue',
          'messaging.destination.name': name,
          'messaging.operation': 'enqueue',
        },
      },
    );
  }
}
