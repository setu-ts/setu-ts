/**
 * MailService — the {@linkcode IMailer} implementation registered under
 * `CAPABILITIES.MAIL`. Resolves the sender once, renders templates through the
 * {@linkcode TemplateEngine}, and dispatches to a {@linkcode MailProvider}.
 *
 * @module
 */
import type { IMailer, MailMessage } from '@setu-ts/common';
import type { MailProvider, OutgoingMail } from '../interfaces/index.ts';
import type { TemplateEngine } from '../templates/template-engine.ts';

/**
 * Options for {@linkcode MailService}.
 *
 * @since 0.1.0
 */
export interface MailServiceOptions {
  /** Default sender used when a message omits `from`. */
  defaultFrom?: string;
}

/**
 * Mailer backed by a pluggable provider and a template engine.
 *
 * `send` and `sendTemplate` both funnel through the single {@link MailService.send}
 * path, so the default-`from` resolution and provider dispatch live in one place.
 *
 * @since 0.1.0
 */
export class MailService implements IMailer {
  readonly #provider: MailProvider;
  readonly #templates: TemplateEngine;
  readonly #defaultFrom: string | undefined;

  /**
   * @param provider - The backing provider adapter
   * @param templates - The template engine (built from plugin options)
   * @param options - Default sender
   */
  constructor(provider: MailProvider, templates: TemplateEngine, options?: MailServiceOptions) {
    this.#provider = provider;
    this.#templates = templates;
    this.#defaultFrom = options?.defaultFrom;
  }

  /**
   * Sends an email, resolving `from` from the message or the configured default.
   *
   * @param message - The message to send
   * @throws {Error} If no `from` can be resolved, or the provider rejects it
   */
  async send(message: MailMessage): Promise<void> {
    await this.#provider.send(this.#resolve(message));
  }

  /**
   * Renders a named template and sends the result. The `subject` is taken
   * verbatim from `message`; the template supplies the `html`/`text` bodies.
   *
   * @param template - Template name
   * @param message - Envelope (recipients, subject, optional `from`/`cc`/`bcc`)
   * @param data - Template variables
   * @throws {Error} If the template is unknown, a variable is missing, no `from`
   *   can be resolved, or the provider rejects the message
   */
  async sendTemplate(
    template: string,
    message: Omit<MailMessage, 'html' | 'text'>,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const rendered = this.#templates.render(template, data);
    await this.#provider.send(this.#resolve({ ...message, ...rendered }));
  }

  /** Resolves `from` and asserts a sender is present. */
  #resolve(message: MailMessage): OutgoingMail {
    const from = message.from ?? this.#defaultFrom;
    if (from === undefined) {
      throw new Error('MailMessage requires a "from" address or a configured default');
    }
    return { ...message, from };
  }
}
