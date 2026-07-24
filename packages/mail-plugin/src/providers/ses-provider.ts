/**
 * SesProvider — sends via AWS Simple Email Service (v2). The
 * `@aws-sdk/client-sesv2` SDK is never a hard dependency: inject an
 * {@linkcode ISesClient} facade, or the provider lazily imports and adapts the
 * SDK.
 *
 * @module
 */
import type { ISesClient, MailProvider, OutgoingMail } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

/** Methods an injected SES client facade must expose. */
const REQUIRED_METHODS = ['sendEmail'] as const;

/** The subset of the AWS SESv2 SDK the adapter uses. */
export interface SesSdkModule {
  SESv2Client: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<unknown>;
  };
  SendEmailCommand: new (input: Record<string, unknown>) => unknown;
}

/**
 * Options for {@linkcode SesProvider}.
 *
 * @since 0.1.0
 */
export interface SesProviderOptions {
  /** AWS region for the lazily-loaded client. */
  region?: string | undefined;
  /** AWS access key id for the lazily-loaded client. */
  accessKeyId?: string | undefined;
  /** AWS secret access key for the lazily-loaded client. */
  secretAccessKey?: string | undefined;
  /** Injected client facade; bypasses the lazy SDK import. */
  client?: ISesClient | undefined;
}

/**
 * Validates that an injected object matches {@linkcode ISesClient}.
 *
 * @param client - The candidate client
 * @returns `true` when the shape is valid
 */
export function validateSesClient(client: unknown): client is ISesClient {
  return hasMethods(client, REQUIRED_METHODS);
}

/**
 * Adapts the AWS SESv2 SDK module to the facade. Pure — unit-tested with a fake
 * module; the real module is supplied on the lazy path by {@linkcode loadSesModule}.
 *
 * @param mod - The SDK module (real or fake)
 * @param options - AWS connection options
 * @returns The facade wrapping a `SESv2Client`
 */
export function adaptSesModule(mod: SesSdkModule, options: SesProviderOptions): ISesClient {
  const client = new mod.SESv2Client(
    buildSesConfig(options.region, options.accessKeyId, options.secretAccessKey),
  );
  return {
    async sendEmail(message: OutgoingMail): Promise<void> {
      await client.send(new mod.SendEmailCommand(toSesInput(message)));
    },
  };
}

/**
 * Lazily imports the AWS SESv2 SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If `npm:@aws-sdk/client-sesv2` cannot be resolved
 */
export async function loadSesModule(): Promise<SesSdkModule> {
  return await import('npm:@aws-sdk/client-sesv2@^3') as unknown as SesSdkModule;
}

/** Maps an {@linkcode OutgoingMail} to a `SendEmailCommand` input. */
export function toSesInput(message: OutgoingMail): Record<string, unknown> {
  const toAddresses = Array.isArray(message.to) ? [...message.to] : [message.to as string];
  const destination: Record<string, unknown> = { ToAddresses: toAddresses };
  if (message.cc !== undefined) {
    destination.CcAddresses = [...message.cc];
  }
  if (message.bcc !== undefined) {
    destination.BccAddresses = [...message.bcc];
  }
  const body: Record<string, unknown> = {};
  if (message.text !== undefined) {
    body.Text = { Data: message.text };
  }
  if (message.html !== undefined) {
    body.Html = { Data: message.html };
  }
  return {
    FromEmailAddress: message.from,
    Destination: destination,
    Content: { Simple: { Subject: { Data: message.subject }, Body: body } },
  };
}

/** Builds a `SESv2Client` config without assigning `undefined` to optionals. */
function buildSesConfig(
  region?: string,
  accessKeyId?: string,
  secretAccessKey?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (region !== undefined) {
    config.region = region;
  }
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  return config;
}

/**
 * AWS SESv2 provider.
 *
 * @since 0.1.0
 */
export class SesProvider implements MailProvider {
  #client: ISesClient | null = null;
  readonly #options: SesProviderOptions;

  /**
   * @param options - AWS connection/injection options
   */
  constructor(options?: SesProviderOptions) {
    this.#options = options ?? {};
  }

  async connect(): Promise<void> {
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateSesClient(injected)) {
        throw new Error('Injected SES client is missing the required sendEmail method');
      }
      this.#client = injected;
      return;
    }
    this.#client = adaptSesModule(await loadSesModule(), this.#options);
  }

  disconnect(): Promise<void> {
    this.#client = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * Sends a message via SES.
   *
   * @param message - The outgoing mail
   * @throws {Error} If the provider is not connected or SES rejects the message
   */
  send(message: OutgoingMail): Promise<void> {
    if (this.#client === null) {
      return Promise.reject(new Error('SesProvider is not connected'));
    }
    return this.#client.sendEmail(message);
  }
}
