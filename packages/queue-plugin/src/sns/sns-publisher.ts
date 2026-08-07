/**
 * SNS publisher for fan-out over AWS SNS.
 *
 * Uses the v3 SNS SDK behind a domain port ({@linkcode ISnsTransport}) with
 * lazy-load via {@linkcode loadSnsModule} and adaptation via
 * {@linkcode adaptSnsModule}.
 *
 * @module
 */

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
  const mod = await import('npm:@aws-sdk/client-sns@^3');
  return mod as unknown as SnsSdkModule;
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

  constructor(options: SnsPublisherOptions) {
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
   * Publish a message to the configured SNS topic.
   *
   * @param message - The message payload (serialized to JSON)
   * @returns The SNS message ID, or undefined if not available
   */
  publish(message: unknown): Promise<string | undefined> {
    if (!this.#transport) throw new Error('SnsPublisher is not connected');

    const body = typeof message === 'string' ? message : JSON.stringify(message);
    return this.#transport.publish(this.#topicArn, body);
  }
}
