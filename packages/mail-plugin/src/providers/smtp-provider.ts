/**
 * SmtpProvider — sends over SMTP via `nodemailer`. The package is never a hard
 * dependency: inject an {@linkcode ISmtpTransport}, or the provider lazily
 * imports `nodemailer` and adapts its transporter. Requires raw sockets, so it
 * is Node/Deno/Bun only (not Cloudflare Workers).
 *
 * @module
 */
import type { ISmtpTransport, MailProvider, OutgoingMail } from '../interfaces/index.ts';
import { hasMethods } from './shape.ts';

/** Methods an injected transport facade must expose. */
const REQUIRED_METHODS = ['sendMail'] as const;

/** Default SMTP submission port. */
const DEFAULT_PORT = 587;

/** The subset of `nodemailer` the adapter uses. */
export interface NodemailerModule {
  createTransport: (options: Record<string, unknown>) => ISmtpTransport;
}

/**
 * Options for {@linkcode SmtpProvider}.
 *
 * @since 0.1.0
 */
export interface SmtpProviderOptions {
  /** SMTP server host. */
  host?: string | undefined;
  /** SMTP server port. Default `587`. */
  port?: number | undefined;
  /** Use an implicit TLS connection. Default `false`. */
  secure?: boolean | undefined;
  /** SMTP auth credentials. */
  auth?: { user: string; pass: string } | undefined;
  /** Injected transport facade; bypasses the lazy `nodemailer` import. */
  transport?: ISmtpTransport | undefined;
}

/**
 * Validates that an injected object matches {@linkcode ISmtpTransport}.
 *
 * @param transport - The candidate transport
 * @returns `true` when the shape is valid
 */
export function validateSmtpTransport(transport: unknown): transport is ISmtpTransport {
  return hasMethods(transport, REQUIRED_METHODS);
}

/**
 * Adapts the `nodemailer` module to a transport facade. Pure — unit-tested with
 * a fake module; the real module is supplied on the lazy path by
 * {@linkcode loadNodemailerModule}.
 *
 * @param mod - The `nodemailer` module (real or fake)
 * @param options - SMTP connection options
 * @returns The transport facade
 */
export function adaptNodemailerModule(
  mod: NodemailerModule,
  options: SmtpProviderOptions,
): ISmtpTransport {
  return mod.createTransport(buildTransportConfig(options));
}

/**
 * Lazily imports `nodemailer`. Only exercised on the lazy path.
 *
 * @returns The `nodemailer` module
 * @throws {Error} If `npm:nodemailer` cannot be resolved
 */
export async function loadNodemailerModule(): Promise<NodemailerModule> {
  return await import('npm:nodemailer@^6') as unknown as NodemailerModule;
}

/** Builds a transport config without assigning `undefined` to optional fields. */
function buildTransportConfig(options: SmtpProviderOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {
    port: options.port ?? DEFAULT_PORT,
    secure: options.secure ?? false,
  };
  if (options.host !== undefined) {
    config.host = options.host;
  }
  if (options.auth !== undefined) {
    config.auth = options.auth;
  }
  return config;
}

/** Maps an {@linkcode OutgoingMail} to nodemailer's message fields. */
export function toNodemailerMessage(
  message: OutgoingMail,
): Parameters<ISmtpTransport['sendMail']>[0] {
  const mail: Parameters<ISmtpTransport['sendMail']>[0] = {
    from: message.from,
    to: joinAddresses(message.to),
    subject: message.subject,
  };
  if (message.text !== undefined) {
    mail.text = message.text;
  }
  if (message.html !== undefined) {
    mail.html = message.html;
  }
  if (message.cc !== undefined) {
    mail.cc = message.cc.join(', ');
  }
  if (message.bcc !== undefined) {
    mail.bcc = message.bcc.join(', ');
  }
  return mail;
}

/** Joins one-or-many addresses into a comma-separated header value. */
function joinAddresses(to: string | readonly string[]): string {
  return Array.isArray(to) ? to.join(', ') : to as string;
}

/**
 * SMTP provider over `nodemailer`.
 *
 * @since 0.1.0
 */
export class SmtpProvider implements MailProvider {
  #transport: ISmtpTransport | null = null;
  readonly #options: SmtpProviderOptions;

  /**
   * @param options - SMTP connection/injection options
   */
  constructor(options?: SmtpProviderOptions) {
    this.#options = options ?? {};
  }

  async connect(): Promise<void> {
    const injected = this.#options.transport;
    if (injected !== undefined) {
      if (!validateSmtpTransport(injected)) {
        throw new Error('Injected SMTP transport is missing the required sendMail method');
      }
      this.#transport = injected;
      return;
    }
    this.#transport = adaptNodemailerModule(await loadNodemailerModule(), this.#options);
  }

  disconnect(): Promise<void> {
    this.#transport = null;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#transport !== null;
  }

  /**
   * Sends a message over SMTP.
   *
   * @param message - The outgoing mail
   * @throws {Error} If the provider is not connected or the transport rejects
   */
  async send(message: OutgoingMail): Promise<void> {
    if (this.#transport === null) {
      throw new Error('SmtpProvider is not connected');
    }
    await this.#transport.sendMail(toNodemailerMessage(message));
  }
}
