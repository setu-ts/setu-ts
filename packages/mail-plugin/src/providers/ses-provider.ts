/**
 * SesProvider — sends via AWS Simple Email Service (v2). The
 * `@aws-sdk/client-sesv2` SDK is never a hard dependency: inject an
 * {@linkcode ISesClient} facade, or the provider lazily imports and adapts the
 * SDK.
 *
 * @module
 */
import type { DeadlineOptions } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import type { ISesClient, MailProvider, OutgoingMail } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';
import type { MailDeadline } from './bounded-send.ts';
import { resolveMailDeadline, runMailCall, toMailError } from './bounded-send.ts';

/** Methods an injected SES client facade must expose. */
const REQUIRED_METHODS = ['sendEmail'] as const;

/** The subset of the AWS SESv2 SDK the adapter uses. */
export interface SesSdkModule {
  SESv2Client: new (config: Record<string, unknown>) => {
    send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  };
  SendEmailCommand: new (input: Record<string, unknown>) => unknown;
  /** Present in `@aws-sdk/client-sesv2`; a fake module without it gets no probe. */
  GetAccountCommand?: new (input: Record<string, never>) => unknown;
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
  /**
   * SES v2 endpoint for the lazily-loaded client (a private endpoint, or a
   * local stand-in). Without it the SDK addresses AWS.
   *
   * @since 0.14.0
   */
  endpoint?: string | undefined;
  /**
   * Bound on one send (and on the readiness probe), in milliseconds, including
   * the SDK's own retries. A send that does not settle in time rejects with
   * `BackendOutcomeUnknownError` (`504`): the message may have gone out. `0`
   * disables the bound; anything outside `0`–`2147483647` throws `RangeError`
   * at construction.
   *
   * @default 15000
   * @since 0.14.0
   */
  requestTimeoutMs?: number | undefined;
  /**
   * Timer surface the bound runs on. `MailPlugin` supplies the runtime's
   * timers; a directly constructed provider falls back to the ambient ones.
   *
   * @since 0.14.0
   */
  timing?: DeadlineOptions['timing'];
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
  const deadline = resolveMailDeadline(options.requestTimeoutMs, options.timing);
  const client = new mod.SESv2Client(
    buildSesConfig(options.region, options.accessKeyId, options.secretAccessKey, options.endpoint),
  );
  const send = (command: unknown): Promise<unknown> =>
    runMailCall(deadline, 'ses', (abortSignal) => client.send(command, { abortSignal }));
  const GetAccount = mod.GetAccountCommand;
  const facade: ISesClient = {
    async sendEmail(message: OutgoingMail): Promise<void> {
      await send(new mod.SendEmailCommand(toSesInput(message)));
    },
  };
  if (GetAccount === undefined) return facade;
  return {
    ...facade,
    // Readiness: `GetAccount` (non-mutating) answered. Any HTTP answer below
    // 500 — a refused credential included — means SES is reachable; a network
    // failure, the bound or a 5xx means it is not.
    async isHealthy(): Promise<boolean> {
      try {
        await send(new GetAccount({}));
        return true;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
          ?.httpStatusCode;
        return typeof status === 'number' && status < 500;
      }
    },
  };
}

/**
 * Lazily imports the AWS SESv2 SDK. Only exercised on the lazy path.
 *
 * @returns The SDK module
 * @throws {Error} If `@aws-sdk/client-sesv2` cannot be resolved
 */
export async function loadSesModule(): Promise<SesSdkModule> {
  try {
    return (await import('@aws-sdk/client-sesv2')) as unknown as SesSdkModule;
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@aws-sdk/client-sesv2', {
      requiredBy: '@setu-ts/mail-plugin',
      cause: error,
    });
  }
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
    Content: {
      Simple: {
        Subject: { Data: message.subject },
        Body: body,
        ...(message.attachments === undefined
          ? {}
          : {
              Attachments: message.attachments.map((attachment) => ({
                FileName: attachment.filename,
                RawContent: attachment.content,
                ContentDisposition: attachment.contentId === undefined ? 'ATTACHMENT' : 'INLINE',
                ...(attachment.contentType === undefined
                  ? {}
                  : { ContentType: attachment.contentType }),
                ...(attachment.contentId === undefined ? {} : { ContentId: attachment.contentId }),
              })),
            }),
      },
    },
  };
}

/** Builds a `SESv2Client` config without assigning `undefined` to optionals. */
function buildSesConfig(
  region?: string,
  accessKeyId?: string,
  secretAccessKey?: string,
  endpoint?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (region !== undefined) {
    config.region = region;
  }
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  if (endpoint !== undefined) {
    config.endpoint = endpoint;
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
  /** `true` when the client was injected: its sends are bounded here, by race. */
  #injected = false;
  readonly #options: SesProviderOptions;
  readonly #deadline: MailDeadline;
  /**
   * Reachability probe. The lazily adapted client calls SES v2 `GetAccount`
   * under the bound; an injected client publishes its own `isHealthy` when it
   * has one, and the indicator reports `reachable: 'unknown'` when it does
   * not.
   *
   * @since 0.1.0
   */
  isHealthy?: () => Promise<boolean>;

  /**
   * @param options - SES connection/injection options
   * @throws {RangeError} When `requestTimeoutMs` is out of range
   */
  constructor(options?: SesProviderOptions) {
    this.#options = options ?? {};
    this.#deadline = resolveMailDeadline(this.#options.requestTimeoutMs, this.#options.timing);
  }

  async connect(): Promise<void> {
    const injected = this.#options.client;
    if (injected !== undefined) {
      if (!validateSesClient(injected)) {
        throw new Error('Injected SES client is missing the required sendEmail method');
      }
      this.#client = injected;
      this.#injected = true;
    } else {
      this.#client = adaptSesModule(await loadSesModule(), this.#options);
      this.#injected = false;
    }
    this.#installProbe();
  }

  /** Installs `isHealthy` from the client's optional member. */
  #installProbe(): void {
    const client = this.#client;
    if (client !== null && typeof client.isHealthy === 'function') {
      const probe = client.isHealthy;
      this.isHealthy = (): Promise<boolean> =>
        runMailCall(this.#deadline, 'ses', () => probe.call(client)).catch(() => false);
    } else {
      delete this.isHealthy;
    }
  }

  disconnect(): Promise<void> {
    this.#client = null;
    delete this.isHealthy;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#client !== null;
  }

  /**
   * Sends a message through SES v2.
   *
   * @param message - The outgoing mail
   * @throws {Error} If the provider is not connected
   * @throws {BackendOutcomeUnknownError} When the send does not settle within
   *   `requestTimeoutMs`
   */
  async send(message: OutgoingMail): Promise<void> {
    const client = this.#client;
    if (client === null) throw new Error('SesProvider is not connected');
    try {
      await (this.#injected
        ? runMailCall(this.#deadline, 'ses', () => client.sendEmail(message))
        : client.sendEmail(message));
    } catch (error) {
      throw toMailError(error, 'ses');
    }
  }
}
