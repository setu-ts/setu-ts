/**
 * @module
 *
 * Email plugin with log, SMTP (`nodemailer`), AWS SES (v2), and SendGrid
 * providers plus a zero-dependency `{{ variable }}` template engine.
 *
 * Exports the plugin factory, service, provider implementations, structural
 * client facades, the template engine, and option types.
 */

// ── Plugin factory ──────────────────────────────────────────────────────────

/**
 * MailPlugin factory — registers an {@linkcode IMailer} under `CAPABILITIES.MAIL`.
 */
export { createProvider, MailPlugin } from './plugin/mail-plugin.ts';

// ── Service ─────────────────────────────────────────────────────────────────

/** MailService — the {@linkcode IMailer} implementation. */
export { MailService } from './services/mail-service.ts';

/** Options for {@linkcode MailService}. */
export type { MailServiceOptions } from './services/mail-service.ts';

// ── Template engine ─────────────────────────────────────────────────────────

/** TemplateEngine — renders named `{{ variable }}` bodies. */
export { escapeHtml, TemplateEngine } from './templates/template-engine.ts';

/** A rendered template body. */
export type { RenderedTemplate } from './templates/template-engine.ts';

// ── Provider implementations ────────────────────────────────────────────────

/** Log provider (default, zero-dependency). */
export { LogProvider } from './providers/log-provider.ts';

/** SMTP provider over `nodemailer`. */
export {
  adaptNodemailerModule,
  loadNodemailerModule,
  SmtpProvider,
  toNodemailerMessage,
  validateSmtpTransport,
} from './providers/smtp-provider.ts';

/** AWS SESv2 provider. */
export {
  adaptSesModule,
  loadSesModule,
  SesProvider,
  toSesInput,
  validateSesClient,
} from './providers/ses-provider.ts';

/** SendGrid provider over `fetch`. */
export { SendGridProvider, toSendGridBody } from './providers/sendgrid-provider.ts';

// ── Provider option types ───────────────────────────────────────────────────

/** Options for {@linkcode LogProvider}. */
export type { LogProviderOptions } from './providers/log-provider.ts';

/** Options for {@linkcode SmtpProvider} and the `nodemailer` module shape. */
export type { NodemailerModule, SmtpProviderOptions } from './providers/smtp-provider.ts';

/** Options for {@linkcode SesProvider} and the SESv2 SDK module shape. */
export type { SesProviderOptions, SesSdkModule } from './providers/ses-provider.ts';

/** Options for {@linkcode SendGridProvider}. */
export type { SendGridProviderOptions } from './providers/sendgrid-provider.ts';

// ── Public types ────────────────────────────────────────────────────────────

/** Options for the MailPlugin factory. */
export type { MailPluginOptions } from './interfaces/index.ts';

/** Supported provider backend types. */
export type { MailProviderType } from './interfaces/index.ts';

/** Provider-specific options. */
export type { MailProviderOptions } from './interfaces/index.ts';

/** A named body template. */
export type { MailTemplate } from './interfaces/index.ts';

/** An outgoing mail with a resolved sender (what providers receive). */
export type { OutgoingMail } from './interfaces/index.ts';

/** Structural shape of an injected `nodemailer` transport. */
export type { ISmtpTransport } from './interfaces/index.ts';

/** Structural shape of an injected AWS SESv2 client facade. */
export type { ISesClient } from './interfaces/index.ts';

/** A `fetch`-shaped function for the SendGrid provider. */
export type { IMailHttp } from './interfaces/index.ts';

// ── Re-exported from @hono-enterprise/common ────────────────────────────────

/** The committed mail contract (`send`, `sendTemplate`) and message shape. */
export type { IMailer, MailMessage } from '@hono-enterprise/common';
