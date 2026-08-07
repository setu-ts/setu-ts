/**
 * Public interfaces/types and the internal provider port for the mail plugin.
 *
 * @module
 */
import type { ILogger, MailMessage } from '@setu-ts/common';

/**
 * An outgoing email whose sender has already been resolved by
 * {@linkcode MailService} (from the message or the configured default). This is
 * the shape every {@linkcode MailProvider} receives — `from` is never absent.
 *
 * @since 0.1.0
 */
export type OutgoingMail = MailMessage & { readonly from: string };

/**
 * Supported mail provider backends.
 *
 * - `'log'` — writes each message to the resolved {@linkcode ILogger} (and an
 *   optional sink); the zero-dependency default, works on every runtime
 *   including Cloudflare Workers. For testing/local development.
 * - `'smtp'` — SMTP via `nodemailer` (injected transport or lazy `npm:`
 *   import); Node/Deno/Bun only (raw sockets, not available on Workers).
 * - `'ses'` — AWS Simple Email Service via `@aws-sdk/client-sesv2` (injected
 *   client or lazy `npm:` import).
 * - `'sendgrid'` — SendGrid v3 HTTP API over web-standard `fetch`
 *   (zero-dependency, Workers-portable).
 *
 * @since 0.1.0
 */
export type MailProviderType = 'log' | 'smtp' | 'ses' | 'sendgrid';

/**
 * Structural shape of a `nodemailer` transport. The plugin never hard-depends on
 * `nodemailer`; inject this shape, or {@linkcode SmtpProvider} lazily loads the
 * package and adapts it to this facade.
 *
 * @since 0.1.0
 */
export interface ISmtpTransport {
  /**
   * Sends one message.
   *
   * @param mail - The nodemailer message fields
   * @returns Resolves when the transport accepts the message
   */
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
    cc?: string;
    bcc?: string;
  }): Promise<unknown>;
}

/**
 * Structural shape of an AWS SESv2 client facade (injected or SDK-adapted). The
 * plugin never hard-depends on `@aws-sdk/client-sesv2`.
 *
 * @since 0.1.0
 */
export interface ISesClient {
  /**
   * Sends one message via SES.
   *
   * @param message - The already-resolved outgoing mail
   * @returns Resolves when SES accepts the message
   */
  sendEmail(message: OutgoingMail): Promise<void>;
}

/**
 * A `fetch`-shaped function used by {@linkcode SendGridProvider} so it stays
 * runtime-agnostic and testable.
 *
 * @since 0.1.0
 */
export type IMailHttp = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A named body template. At least one of `html`/`text` must be present.
 *
 * @since 0.1.0
 */
export interface MailTemplate {
  /** HTML body template with `{{ variable }}` placeholders (values escaped). */
  html?: string;
  /** Plain-text body template with `{{ variable }}` placeholders (raw). */
  text?: string;
}

/**
 * Provider-specific options. Fields are consumed only by the matching provider;
 * unrelated fields are ignored (mirrors `SecretsProviderOptions`).
 *
 * @since 0.1.0
 */
export interface MailProviderOptions {
  /** (`smtp`) SMTP server host. */
  host?: string;
  /** (`smtp`) SMTP server port. Default `587`. */
  port?: number;
  /** (`smtp`) Use an implicit TLS connection. Default `false`. */
  secure?: boolean;
  /** (`smtp`) SMTP auth credentials. */
  auth?: { user: string; pass: string };
  /** (`smtp`) Injected transport facade; bypasses the lazy `nodemailer` import. */
  transport?: ISmtpTransport;
  /** (`ses`) AWS region for the lazily-loaded client. */
  region?: string;
  /** (`ses`) AWS access key id for the lazily-loaded client. */
  accessKeyId?: string;
  /** (`ses`) AWS secret access key for the lazily-loaded client. */
  secretAccessKey?: string;
  /** (`ses`) Injected client facade; bypasses the lazy SDK import. */
  client?: ISesClient;
  /** (`sendgrid`) SendGrid API key sent as a Bearer token. */
  apiKey?: string;
  /** (`sendgrid`) API endpoint. Default `https://api.sendgrid.com/v3/mail/send`. */
  endpoint?: string;
  /** (`sendgrid`) Injected `fetch`-shaped function; defaults to global `fetch`. */
  http?: IMailHttp;
  /** (`log`) Called with each sent message — a read-back seam for tests/hooks. */
  sink?: (message: OutgoingMail) => void;
}

/**
 * Options for the {@linkcode MailPlugin} factory.
 *
 * @example
 * ```typescript
 * app.register(MailPlugin({
 *   provider: 'smtp',
 *   options: { host: 'smtp.example.com', port: 587, auth: { user, pass } },
 *   defaults: { from: 'noreply@myapp.com' },
 * }));
 * ```
 * @since 0.1.0
 */
export interface MailPluginOptions {
  /** Provider backend. Defaults to `'log'`. */
  provider?: MailProviderType;
  /** Provider-specific options. */
  options?: MailProviderOptions;
  /** Message defaults applied when a message omits the field. */
  defaults?: { from?: string };
  /** Named body templates available to `sendTemplate`. */
  templates?: Record<string, MailTemplate>;
}

/**
 * Internal provider port. NOT exported from `src/index.ts` — the committed
 * public contract is `IMailer`; providers are an internal seam behind
 * {@linkcode MailService}. Every provider receives an {@linkcode OutgoingMail}
 * whose `from` the service has already resolved.
 */
export interface MailProvider {
  /** Establishes any backing connection/client. No-op for stateless providers. */
  connect(): Promise<void>;
  /** Releases any backing connection/client. No-op for stateless providers. */
  disconnect(): Promise<void>;
  /** Reports whether the provider is ready to send. */
  isReady(): boolean;
  /**
   * Sends one message.
   *
   * @param message - The outgoing mail with a resolved `from`
   * @throws {Error} If the provider rejects the message
   */
  send(message: OutgoingMail): Promise<void>;
}

/** Re-exported for provider constructors that accept a logger. */
export type { ILogger };
